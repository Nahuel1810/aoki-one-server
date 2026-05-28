const { CARRO } = require("../../config/plcProtocol");
const {
  parseLocationCode,
  hasLocationActionSuffix,
  inferRobotIdFromEstanteria,
  toCarroCommand,
  toElevadorGoLevelCommand,
} = require("./locationTranslator");
const { sortPickSlotsByDistance } = require("./slotDistance");
const { SLOT_STATUS } = require("../state/StateManager");

class OrchestratorService {
  constructor(options) {
    this.queueManager = options.queueManager;
    this.stateManager = options.stateManager;
    this.connectionService = options.connectionService;
    this.errorHandler = options.errorHandler;
    this.eventStore = options.eventStore;
    this.snapshotStore = options.snapshotStore;
    this.logger = options.logger || console;
    this.config = {
      tickMs: Number(process.env.ORCHESTRATOR_TICK_MS || 300),
      maxRetries: Number(process.env.MAX_RETRIES_PER_STEP || 3),
      baseBackoffMs: Number(process.env.BASE_BACKOFF_MS || 500),
      commandAckTimeoutMs: Number(process.env.COMMAND_ACK_TIMEOUT_MS || 2000),
      ...options.config,
    };

    this.processingRobots = new Set();
    this.timer = null;
    this.started = false;
    // Cuando hay loops activos, el tick se vuelve no-op por robot. Estas
    // promesas guardan referencia al loop por si se quiere observar/await.
    this.activeLoops = new Map();
  }

  getOrderLocationContext(order) {
    const source = parseLocationCode(order.locationCode);
    const slot = order.slotLocationCode ? parseLocationCode(order.slotLocationCode) : null;
    const target = order.targetLocation ? parseLocationCode(order.targetLocation) : null;

    return { source, slot, target };
  }

  static inferRobotId(locationCode) {
    try {
      const parsed = parseLocationCode(locationCode);
      return inferRobotIdFromEstanteria(parsed.estanteriaCode);
    } catch {
      return null;
    }
  }

  buildSteps(orderType) {
    return [
      { id: 1, type: "HOMING", deviceType: "CARRO", status: "PENDING", retries: 0 },
      { id: 2, type: "ELEVADOR", deviceType: "ELEVADOR", status: "PENDING", retries: 0 },
      { id: 3, type: "CARRO_BUSCA", deviceType: "CARRO", status: "PENDING", retries: 0 },
      { id: 4, type: "ELEVADOR", deviceType: "ELEVADOR", status: "PENDING", retries: 0 },
      {
        id: 5,
        type: orderType === "PUT" ? "CARRO_DEVUELVE" : "CARRO_DEJA",
        deviceType: "CARRO",
        status: "PENDING",
        retries: 0,
      },
    ];
  }

  resolveStepCommand(step, order) {
    const { source, slot, target } = this.getOrderLocationContext(order);
    const bringSource = source;
    const dropTarget = order.type === "PICK" ? slot || source : target || source;

    const carroBring = toCarroCommand(bringSource, "T");
    const carroReturn = toCarroCommand(dropTarget, "D");
    const elevadorSourceLevel = toElevadorGoLevelCommand(bringSource);
    const elevadorDropLevel = toElevadorGoLevelCommand(dropTarget);

    let elevadorCommandCode = elevadorSourceLevel.commandCode;
    if (step.type === "ELEVADOR" && step.id === 4) {
      elevadorCommandCode = elevadorDropLevel.commandCode;
    }

    const commandCodes = {
      HOMING: CARRO.COMMANDS.INIT,
      ELEVADOR: elevadorCommandCode,
      CARRO_BUSCA: carroBring.commandCode,
      CARRO_DEJA: carroReturn.commandCode,
      CARRO_DEVUELVE: carroReturn.commandCode,
    };

    return {
      commandCode: commandCodes[step.type] || 0,
      value: commandCodes[step.type] || 0,
      expectedResponses: [100],
    };
  }

  async rehydrateFromSnapshot(snapshot) {
    if (!snapshot) {
      return;
    }

    this.stateManager.hydrateFromSnapshot(snapshot);
    await this.queueManager.clear();

    const orders = this.stateManager.listOrders().sort((a, b) => a.createdAt - b.createdAt);
    for (const order of orders) {
      let currentStatus = order.status;

      if (order.status === "IN_PROGRESS") {
        this.stateManager.updateOrder(order.id, { status: "PENDING" });
        this.stateManager.pushOrderHistory(order.id, "ORDER_RECOVERED_FROM_IN_PROGRESS");
        currentStatus = "PENDING";
      }

      if (currentStatus === "PENDING") {
        await this.queueManager.enqueue({ ...order, status: "PENDING" });
      }
    }

    for (const robot of this.stateManager.listRobots()) {
      if (robot.status !== "ERROR") {
        this.stateManager.upsertRobot({ id: robot.id, status: "IDLE", currentOrderId: null });
      }
    }

    this.eventStore.append({ entityType: "SYSTEM", entityId: "orchestrator", event: "SNAPSHOT_REHYDRATED" });
  }

  async submitOrder(input) {
    const type = String(input.type || "PICK").toUpperCase();
    if (!["PICK", "PUT"].includes(type)) {
      throw new Error("type invalido. Usar PICK o PUT");
    }

    const hasExternalOrderId = input.id !== undefined && input.id !== null && String(input.id).trim() !== "";
    const externalOrderId = hasExternalOrderId ? Number(input.id) : null;
    if (hasExternalOrderId && (!Number.isFinite(externalOrderId) || !Number.isInteger(externalOrderId))) {
      throw new Error("id debe ser numerico entero");
    }

    if (Number.isInteger(externalOrderId)) {
      const existingOrder = this.stateManager.findOrderByExternalId(externalOrderId);
      if (existingOrder) {
        return existingOrder;
      }
    }

    if (hasLocationActionSuffix(input.locationCode)) {
      throw new Error("locationCode no debe incluir accion final (T/D/L). La accion se deriva desde type PICK/PUT");
    }

    const parsedLocation = parseLocationCode(input.locationCode);
    const parsedTarget = input.targetLocation ? parseLocationCode(input.targetLocation) : null;

    const robotId = input.robotId || parsedLocation.robotId || OrchestratorService.inferRobotId(parsedLocation.baseCode);
    if (!robotId) {
      throw new Error("No se pudo derivar robotId. Enviar robotId o locationCode valido");
    }

    let slotLocationCode = input.slotLocationCode ? parseLocationCode(input.slotLocationCode).baseCode : null;
    let steps = this.buildSteps(type);
    let logicalPickOnly = false;
    let logicalReturnOnly = false;

    if (type === "PICK") {
      const dupSlot = this.stateManager.findOccupiedPickSlotBySource(parsedLocation.baseCode);
      if (dupSlot) {
        this.stateManager.incrementLogicalPickStack(dupSlot.locationCode);
        steps = [];
        slotLocationCode = dupSlot.locationCode;
        logicalPickOnly = true;
      }
    }

    if (type === "PUT") {
      slotLocationCode = parsedLocation.baseCode;
      const slot = this.stateManager.getSlot(slotLocationCode);
      if (!slot) {
        throw new Error("PUT requiere locationCode de zona pickeo configurada");
      }

      // Nota: se acepta PUT tanto sobre slots OCUPADO (devolución normal)
      // como sobre slots LIBRE (devolución manual de cajón físico
      // fuera-de-libros). Slots RESERVADO/BUSCANDO/DEVOLVIENDO/ERROR
      // quedarán en waitingForSlot al intentar reservarlos más abajo.
      const stackDepth = this.stateManager.getLogicalPickStackDepth(slotLocationCode);
      if (stackDepth > 1) {
        this.stateManager.decrementLogicalPickStack(slotLocationCode);
        steps = [];
        logicalReturnOnly = true;
      }
    }

    const order = this.stateManager.createOrder({
      ...input,
      externalOrderId,
      type,
      robotId,
      locationCode: parsedLocation.baseCode,
      targetLocation: parsedTarget ? parsedTarget.baseCode : null,
      slotLocationCode,
      steps,
      logicalPickOnly,
      logicalReturnOnly,
    });

    if (type === "PUT" && slotLocationCode && !logicalReturnOnly) {
      const reserved = this.stateManager.reserveSlotForPut(slotLocationCode, order.id);
      if (!reserved) {
        this.stateManager.updateOrder(order.id, { waitingForSlot: true });
      } else {
        const meta = {
          locationCode: slotLocationCode,
          previousStatus: reserved.previousStatus,
        };
        this.stateManager.pushOrderHistory(order.id, "SLOT_RESERVED", meta);
        this.eventStore.append({
          entityType: "SLOT",
          entityId: slotLocationCode,
          event: "SLOT_RESERVED",
          metadata: { orderId: order.id, type: "PUT", previousStatus: reserved.previousStatus },
        });
      }
    }

    this.stateManager.upsertRobot({ id: robotId, status: "IDLE", enabled: true });
    await this.queueManager.enqueue(order);
    this.eventStore.append({ entityType: "ORDER", entityId: order.id, event: "ORDER_ENQUEUED" });
    this.snapshotStore.save(this.stateManager.getSnapshot());

    // Kick inmediato: si el robot no esta procesando, dispara el loop ahora
    // mismo en vez de esperar al proximo tick (elimina latencia inicial).
    this.kickRobot(robotId);

    return order;
  }

  async start() {
    if (this.timer) {
      return;
    }

    this.started = true;
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.logger.error("[orchestrator] tick failed", error);
      });
    }, this.config.tickMs);

    // Despertar inmediatamente cualquier robot que ya tenga trabajo
    // (rehidratado desde snapshot, por ejemplo).
    for (const robot of this.stateManager.listRobots()) {
      if (robot.enabled !== false) {
        this.kickRobot(robot.id);
      }
    }
  }

  async stop() {
    this.started = false;
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  isRobotProcessing(robotId) {
    return this.processingRobots.has(robotId);
  }

  async tick() {
    // El tick actua solo como fallback: arranca un loop por cada robot que
    // este IDLE y enabled, pero NO impulsa steps de robots que ya estan en
    // loop activo (esos avanzan solos sin esperar al tick).
    const robots = this.stateManager.listRobots();

    for (const robot of robots) {
      if (!robot.enabled) {
        continue;
      }

      this.tryDispatchRobot(robot.id);
    }
  }

  /**
   * Arranca (si no esta ya corriendo) el loop de procesamiento para un robot.
   * Es idempotente: si el robot ya tiene un loop activo, no hace nada.
   * Llamar desde tick, submitOrder, retryOrder o cuando llegue trabajo nuevo.
   */
  kickRobot(robotId) {
    if (!this.started) {
      // No autoejecutar antes de start(); preserva el comportamiento de tests
      // que llaman submitOrder y luego inspeccionan la cola.
      return;
    }
    this.tryDispatchRobot(robotId);
  }

  tryDispatchRobot(robotId) {
    if (!this.started) {
      return;
    }

    if (this.processingRobots.has(robotId)) {
      return;
    }

    this.processingRobots.add(robotId);
    const loopPromise = this.runRobotLoop(robotId)
      .catch((error) => {
        this.logger.error("[orchestrator] robot loop failed", {
          robotId,
          error: error?.message || String(error),
        });
      })
      .finally(() => {
        this.processingRobots.delete(robotId);
        this.activeLoops.delete(robotId);
      });
    this.activeLoops.set(robotId, loopPromise);
  }

  /**
   * Loop continuo por robot: encadena steps y ordenes sin pasar por el tick.
   * Sale cuando:
   *  - no hay orden activa ni nada para dequeuear (queue vacia)
   *  - la orden quedo en ERROR (robot pasa a ERROR, no se sigue)
   *  - la orden se difirio (PENDING por waitingForSlot)
   */
  async runRobotLoop(robotId) {
    // Loop infinito controlado por breaks explicitos para cubrir cada
    // condicion de salida de manera legible.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const robot = this.stateManager.getRobot
        ? this.stateManager.getRobot(robotId)
        : this.stateManager.listRobots().find((r) => r.id === robotId);

      if (robot && robot.enabled === false) {
        return;
      }

      let queueState = await this.queueManager.ensureRobot(robotId);
      let activeOrderId = queueState.activeOrderId;

      if (!activeOrderId) {
        const nextOrderId = await this.queueManager.dequeueNext(robotId);
        if (!nextOrderId) {
          return;
        }

        await this.queueManager.setActive(robotId, nextOrderId);
        this.stateManager.upsertRobot({ id: robotId, status: "BUSY", currentOrderId: nextOrderId });
        activeOrderId = nextOrderId;
      }

      await this.processOrder(robotId, activeOrderId);

      const order = this.stateManager.getOrder(activeOrderId);
      if (!order) {
        continue;
      }

      // ERROR: el robot quedo en estado ERROR; no levantamos mas trabajo
      // hasta que llegue un retry explicito (que dispara kickRobot).
      if (order.status === "ERROR") {
        return;
      }

      // PENDING: la orden se difirio (p.ej. waitingForSlot). Salimos y dejamos
      // que el proximo tick o un kick externo (release de slot) la retome.
      if (order.status === "PENDING") {
        return;
      }

      // IN_PROGRESS: el step se completo, hay mas steps. Continuamos el loop
      // y volvemos a llamar a processOrder con la misma orden activa.
      // DONE / CANCELED: la orden termino; el loop intenta dequeuear la siguiente.
      // En cualquier caso, no rompemos: la proxima iteracion decide.
    }
  }

  async processOrder(robotId, orderId) {
    let order = this.stateManager.getOrder(orderId);
    if (!order) {
      await this.queueManager.clearActive(robotId);
      return;
    }

    // Runtime check: si estamos ejecutando un PICK y aún no tiene slot asignado,
    // validar en el momento de ejecución si ya existe un slot OCCUPED con el
    // mismo sourceLocationCode. En ese caso, convertir la orden a logicalPick
    // (incrementar contador y marcar pasos vacíos) para evitar duplicar movimiento físico.
    if (order.type === "PICK" && !order.logicalPickOnly && !order.slotLocationCode) {
      const dupSlot = this.stateManager.findOccupiedPickSlotBySource(order.locationCode);
      if (dupSlot) {
        this.stateManager.incrementLogicalPickStack(dupSlot.locationCode);
        this.stateManager.pushOrderHistory(order.id, "PICK_ALREADY_IN_SLOT", { locationCode: dupSlot.locationCode });
        this.stateManager.updateOrder(order.id, {
          slotLocationCode: dupSlot.locationCode,
          steps: [],
          logicalPickOnly: true,
        });
        // refrescar la referencia local para que el resto del flujo lo vea
        order = this.stateManager.getOrder(orderId);
      }
    }

    if (order.status === "DONE" || order.status === "ERROR" || order.status === "CANCELED") {
      await this.queueManager.clearActive(robotId);
      this.stateManager.upsertRobot({ id: robotId, status: "IDLE", currentOrderId: null });
      return;
    }

    if (order.logicalPickOnly || order.logicalReturnOnly) {
      const finishedAt = Date.now();
      order = this.ensureStartedProcessingAt(order, finishedAt);
      const meta = {
        slotLocationCode: order.slotLocationCode || null,
        kind: order.logicalPickOnly ? "PICK_ALREADY_IN_SLOT" : "PUT_LOGICAL_RETURN",
      };
      this.stateManager.pushOrderHistory(order.id, meta.kind, meta);
      order = this.stateManager.updateOrder(order.id, { status: "DONE" });
      this.stateManager.pushOrderHistory(order.id, "ORDER_DONE");
      this.eventStore.append({ entityType: "ORDER", entityId: order.id, event: "ORDER_DONE", metadata: meta });
      this.recordOrderMetrics(order, "DONE", finishedAt);
      await this.queueManager.clearActive(robotId);
      this.stateManager.upsertRobot({ id: robotId, status: "IDLE", currentOrderId: null });
      this.snapshotStore.save(this.stateManager.getSnapshot());
      return;
    }

    if (order.type === "PICK" && !order.slotLocationCode) {
      const assignedSlot = this.assignSlotForPickOrder(order);
      if (!assignedSlot) {
        await this.deferOrderWaitingForSlot(order, robotId);
        return;
      }

      order = this.stateManager.updateOrder(order.id, {
        slotLocationCode: assignedSlot.locationCode,
        waitingForSlot: false,
      });
      this.stateManager.pushOrderHistory(order.id, "SLOT_ASSIGNED", { locationCode: assignedSlot.locationCode });
      this.eventStore.append({
        entityType: "SLOT",
        entityId: assignedSlot.locationCode,
        event: "SLOT_RESERVED",
        metadata: { orderId: order.id, type: "PICK" },
      });
    }

    if (order.waitingForSlot && order.slotLocationCode) {
      this.stateManager.updateOrder(order.id, { waitingForSlot: false });
    }

    const startedAtPatch = !order.startedProcessingAt ? { startedProcessingAt: Date.now() } : {};
    order = this.stateManager.updateOrder(order.id, { status: "IN_PROGRESS", ...startedAtPatch });
    if (order.slotLocationCode && order.currentStepIndex === 0) {
      if (order.type === "PICK") {
        this.stateManager.markSlotPickInProgress(order.slotLocationCode, order.id);
      } else if (order.type === "PUT") {
        this.stateManager.markSlotPutInProgress(order.slotLocationCode, order.id);
      }
    }

    const currentStep = order.steps[order.currentStepIndex];
    if (!currentStep) {
      if (order.type === "PICK" && order.slotLocationCode) {
        this.stateManager.markSlotOccupied(order.slotLocationCode, order.id, {
          sourceLocationCode: order.locationCode,
          pickOrderId: order.id,
        });
        this.stateManager.pushOrderHistory(order.id, "SLOT_OCCUPIED", { locationCode: order.slotLocationCode });
        this.eventStore.append({
          entityType: "SLOT",
          entityId: order.slotLocationCode,
          event: "SLOT_OCCUPIED",
          metadata: { orderId: order.id },
        });
      }

      if (order.type === "PUT" && order.slotLocationCode) {
        this.stateManager.releaseSlot(order.slotLocationCode);
        this.stateManager.pushOrderHistory(order.id, "SLOT_RELEASED", { locationCode: order.slotLocationCode });
        this.eventStore.append({
          entityType: "SLOT",
          entityId: order.slotLocationCode,
          event: "SLOT_RELEASED",
          metadata: { orderId: order.id },
        });
      }

      const finishedAt = Date.now();
      order = this.ensureStartedProcessingAt(order, finishedAt);
      order = this.stateManager.updateOrder(order.id, { status: "DONE" });
      this.stateManager.pushOrderHistory(order.id, "ORDER_DONE");
      this.eventStore.append({ entityType: "ORDER", entityId: order.id, event: "ORDER_DONE" });
      this.recordOrderMetrics(order, "DONE", finishedAt);
      await this.queueManager.clearActive(robotId);
      this.stateManager.upsertRobot({ id: robotId, status: "IDLE", currentOrderId: null });
      this.snapshotStore.save(this.stateManager.getSnapshot());
      return;
    }

    const executed = await this.executeStepWithRetry(order, currentStep);
    if (!executed.ok) {
      if (order.slotLocationCode) {
        this.stateManager.blockSlot(order.slotLocationCode, executed.error?.message || "step failed", order.id);
        this.eventStore.append({
          entityType: "SLOT",
          entityId: order.slotLocationCode,
          event: "SLOT_BLOCKED",
          metadata: { orderId: order.id, reason: executed.error?.message || "step failed" },
        });
      }

      const finishedAt = Date.now();
      order = this.ensureStartedProcessingAt(order, finishedAt);
      order = this.stateManager.updateOrder(order.id, {
        status: "ERROR",
        errorReason: executed.error?.message || "step failed",
      });
      this.stateManager.pushOrderHistory(order.id, "ORDER_PAUSED_ERROR", {
        step: currentStep.type,
        error: executed.error?.message,
      });
      this.recordOrderMetrics(order, "ERROR", finishedAt);
      await this.queueManager.clearActive(robotId);
      this.stateManager.upsertRobot({ id: robotId, status: "ERROR", currentOrderId: null });
      this.snapshotStore.save(this.stateManager.getSnapshot());
      return;
    }

    currentStep.status = "DONE";
    currentStep.finishedAt = Date.now();

    this.stateManager.updateOrder(order.id, {
      currentStepIndex: order.currentStepIndex + 1,
      steps: order.steps,
    });
    this.stateManager.pushOrderHistory(order.id, "STEP_DONE", {
      step: currentStep.type,
      index: order.currentStepIndex,
    });
    this.eventStore.append({
      entityType: "STEP",
      entityId: `${order.id}:${currentStep.id}`,
      event: "STEP_DONE",
      metadata: { robotId, orderId: order.id, step: currentStep.type },
    });
    this.snapshotStore.save(this.stateManager.getSnapshot());
  }

  assignSlotForPickOrder(order) {
    const availableSlots = this.stateManager.listAvailableSlots();
    const ranked = sortPickSlotsByDistance(order.locationCode, availableSlots);

    for (const slot of ranked) {
      const reserved = this.stateManager.reserveSlot(slot.locationCode, order.id);
      if (reserved) {
        return reserved;
      }
    }

    return null;
  }

  async deferOrderWaitingForSlot(order, robotId) {
    if (!order.waitingForSlot) {
      this.stateManager.pushOrderHistory(order.id, "ORDER_WAITING_FOR_SLOT", {
        reason: "NO_PICK_SLOT_AVAILABLE",
      });
      this.eventStore.append({ entityType: "ORDER", entityId: order.id, event: "ORDER_WAITING_FOR_SLOT" });
    }

    const updated = this.stateManager.updateOrder(order.id, {
      status: "PENDING",
      waitingForSlot: true,
    });

    await this.queueManager.clearActive(robotId);
    await this.queueManager.enqueue(updated);
    this.stateManager.upsertRobot({ id: robotId, status: "IDLE", currentOrderId: null });
    this.snapshotStore.save(this.stateManager.getSnapshot());
  }

  async executeStepWithRetry(order, step) {
    step.status = "IN_PROGRESS";
    step.startedAt = Date.now();

    const commandPayload = this.resolveStepCommand(step, order);

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt += 1) {
      try {
        step.retries = attempt - 1;
        const commandEntity = this.stateManager.addCommand({
          orderId: order.id,
          stepId: step.id,
          robotId: order.robotId,
          deviceId: `${order.robotId}:${step.deviceType}`,
          commandCode: commandPayload.commandCode,
          status: "SENT",
        });

        const response = await this.connectionService.executeStepCommand({
          robotId: order.robotId,
          step,
          command: commandPayload,
          timeoutMs: this.config.commandAckTimeoutMs,
        });

        if (!response.stateOk) {
          const decoded = response?.raw?.decoded;
          if (decoded?.kind === "ERROR") {
            const plcError = new Error(decoded.message || "Error PLC");
            plcError.errorCode = decoded.errorCode;
            plcError.fatal = Number(decoded.errorCode) === 99;
            throw plcError;
          }

          const mismatchError = new Error("Estado PLC no coincide con lo esperado");
          mismatchError.fatal = false;
          throw mismatchError;
        }

        this.stateManager.updateCommand(commandEntity.id, {
          status: "DONE",
          acknowledgedAt: Date.now(),
          finishedAt: Date.now(),
          rawResponse: response.raw,
        });

        return { ok: true };
      } catch (error) {
        this.errorHandler.capture(this.stateManager, {
          entityType: "ORDER",
          entityId: order.id,
          message: error.message,
          metadata: {
            robotId: order.robotId,
            step: step.type,
            attempt,
          },
        });

        if (!this.errorHandler.isRetryable(error) || attempt === this.config.maxRetries) {
          return { ok: false, error };
        }

        const backoff = this.errorHandler.nextBackoffMs(attempt, this.config.baseBackoffMs);
        await this.errorHandler.sleep(backoff);
      }
    }

    return { ok: false, error: new Error("step failed") };
  }

  async retryOrder(orderId) {
    const order = this.stateManager.getOrder(orderId);
    if (!order) {
      return null;
    }

    await this.connectionService.resetRobotMessageIn(order.robotId);

    const resetSteps = this.buildSteps(order.type);
    const updated = this.stateManager.updateOrder(orderId, {
      status: "PENDING",
      errorReason: null,
      currentStepIndex: 0,
      steps: resetSteps,
      waitingForSlot: false,
    });

    await this.queueManager.enqueue(updated);
    this.stateManager.upsertRobot({ id: updated.robotId, status: "IDLE", currentOrderId: null });
    this.eventStore.append({ entityType: "ORDER", entityId: orderId, event: "ORDER_RETRIED" });
    this.snapshotStore.save(this.stateManager.getSnapshot());

    // Disparar el loop inmediatamente para no esperar al proximo tick.
    this.kickRobot(updated.robotId);

    return updated;
  }

  async cancelOrder(orderId) {
    const order = this.stateManager.getOrder(orderId);
    if (!order) {
      return null;
    }

    await this.queueManager.removeOrder(order.robotId, order.id);

    if (order.slotLocationCode) {
      const slot = this.stateManager.getSlot(order.slotLocationCode);
      if (slot?.reservedByOrderId === order.id) {
        if (order.type === "PICK") {
          this.stateManager.releaseSlot(order.slotLocationCode);
        }

        if (order.type === "PUT") {
          this.stateManager.updateSlotStatus(order.slotLocationCode, SLOT_STATUS.OCCUPIED, null);
        }
      }
    }

    const finishedAt = Date.now();
    const started = this.ensureStartedProcessingAt(order, finishedAt);
    const updated = this.stateManager.updateOrder(orderId, { status: "CANCELED", startedProcessingAt: started.startedProcessingAt });
    this.eventStore.append({ entityType: "ORDER", entityId: orderId, event: "ORDER_CANCELED" });
    this.recordOrderMetrics(updated, "CANCELED", finishedAt);
    this.stateManager.upsertRobot({ id: updated.robotId, status: "IDLE", currentOrderId: null });
    return updated;
  }

  ensureStartedProcessingAt(order, fallbackTs = Date.now()) {
    if (order.startedProcessingAt) {
      return order;
    }
    return this.stateManager.updateOrder(order.id, { startedProcessingAt: fallbackTs }) || order;
  }

  recordOrderMetrics(order, statusOverride, finishedAt) {
    if (!this.eventStore || typeof this.eventStore.insertMetrics !== "function") {
      return;
    }

    const createdAt = Number(order.createdAt || finishedAt);
    const startedAt = Number(order.startedProcessingAt);
    const safeStartedAt = Number.isFinite(startedAt) && startedAt > 0 ? startedAt : finishedAt;
    const waitingMs = Math.max(0, safeStartedAt - createdAt);
    const durationMs = Math.max(0, finishedAt - safeStartedAt);

    this.eventStore.insertMetrics({
      orderId: order.id,
      origin: order.origin,
      type: order.type,
      locationCode: order.slotLocationCode || order.locationCode,
      waitingMs,
      durationMs,
      status: statusOverride || order.status,
      createdAt,
      finishedAt,
    });
  }
}

module.exports = {
  OrchestratorService,
};
