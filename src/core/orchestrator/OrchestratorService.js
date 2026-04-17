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
      { id: 6, type: "HOMING", deviceType: "CARRO", status: "PENDING", retries: 0 },
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
      address: Number(process.env.MODBUS_COMMAND_REGISTER || 0),
      value: commandCodes[step.type] || 0,
      responseAddress: Number(process.env.MODBUS_RESPONSE_REGISTER || 2),
      expectedResponses: [100],
      verifyAddress: Number(process.env.MODBUS_VERIFY_REGISTER || 1),
      expectedValue: step.deviceType === "CARRO" ? step.id : undefined,
    };
  }

  rehydrateFromSnapshot(snapshot) {
    if (!snapshot) {
      return;
    }

    this.stateManager.hydrateFromSnapshot(snapshot);
    this.queueManager.clear();

    const orders = this.stateManager.listOrders().sort((a, b) => a.createdAt - b.createdAt);
    for (const order of orders) {
      let currentStatus = order.status;

      if (order.status === "IN_PROGRESS") {
        this.stateManager.updateOrder(order.id, { status: "PENDING" });
        this.stateManager.pushOrderHistory(order.id, "ORDER_RECOVERED_FROM_IN_PROGRESS");
        currentStatus = "PENDING";
      }

      if (currentStatus === "PENDING") {
        this.queueManager.enqueue({ ...order, status: "PENDING" });
      }
    }

    for (const robot of this.stateManager.listRobots()) {
      if (robot.status !== "ERROR") {
        this.stateManager.upsertRobot({ id: robot.id, status: "IDLE", currentOrderId: null });
      }
    }

    this.eventStore.append({ entityType: "SYSTEM", entityId: "orchestrator", event: "SNAPSHOT_REHYDRATED" });
  }

  submitOrder(input) {
    const type = String(input.type || "PICK").toUpperCase();
    if (!["PICK", "PUT"].includes(type)) {
      throw new Error("type invalido. Usar PICK o PUT");
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
    if (type === "PUT") {
      slotLocationCode = parsedLocation.baseCode;
      const slot = this.stateManager.getSlot(slotLocationCode);
      if (!slot) {
        throw new Error("PUT requiere locationCode de zona pickeo configurada");
      }

      if (slot.status !== SLOT_STATUS.OCCUPIED) {
        throw new Error("El slot no tiene cajon disponible para PUT");
      }
    }


    const steps = this.buildSteps(type);
    const order = this.stateManager.createOrder({
      ...input,
      type,
      robotId,
      locationCode: parsedLocation.baseCode,
      targetLocation: parsedTarget ? parsedTarget.baseCode : null,
      slotLocationCode,
      steps,
    });

    if (type === "PUT" && slotLocationCode) {
      const reserved = this.stateManager.reserveOccupiedSlotForPut(slotLocationCode, order.id);
      if (!reserved) {
        this.stateManager.updateOrder(order.id, { waitingForSlot: true });
      } else {
        this.stateManager.pushOrderHistory(order.id, "SLOT_RESERVED", { locationCode: slotLocationCode });
        this.eventStore.append({
          entityType: "SLOT",
          entityId: slotLocationCode,
          event: "SLOT_RESERVED",
          metadata: { orderId: order.id, type: "PUT" },
        });
      }
    }

    this.stateManager.upsertRobot({ id: robotId, status: "IDLE", enabled: true });
    this.queueManager.enqueue(order);
    this.eventStore.append({ entityType: "ORDER", entityId: order.id, event: "ORDER_ENQUEUED" });
    this.snapshotStore.save(this.stateManager.getSnapshot());
    return order;
  }

  async start() {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.logger.error("[orchestrator] tick failed", error);
      });
    }, this.config.tickMs);
  }

  async stop() {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    const robots = this.stateManager.listRobots();

    for (const robot of robots) {
      if (!robot.enabled) {
        continue;
      }

      if (this.processingRobots.has(robot.id)) {
        continue;
      }

      if (!this.queueManager.isRobotBusy(robot.id)) {
        const nextOrderId = this.queueManager.dequeueNext(robot.id);
        if (nextOrderId) {
          this.queueManager.setActive(robot.id, nextOrderId);
          this.stateManager.upsertRobot({ id: robot.id, status: "BUSY", currentOrderId: nextOrderId });
        }
      }

      const queueState = this.queueManager.ensureRobot(robot.id);
      if (!queueState.activeOrderId) {
        continue;
      }

      this.processingRobots.add(robot.id);
      this.processOrder(robot.id, queueState.activeOrderId)
        .catch((error) => {
          this.logger.error("[orchestrator] process order failed", error);
        })
        .finally(() => {
          this.processingRobots.delete(robot.id);
        });
    }
  }

  async processOrder(robotId, orderId) {
    let order = this.stateManager.getOrder(orderId);
    if (!order) {
      this.queueManager.clearActive(robotId);
      return;
    }

    if (order.status === "DONE" || order.status === "ERROR" || order.status === "CANCELED") {
      this.queueManager.clearActive(robotId);
      this.stateManager.upsertRobot({ id: robotId, status: "IDLE", currentOrderId: null });
      return;
    }

    if (order.type === "PICK" && !order.slotLocationCode) {
      const assignedSlot = this.assignSlotForPickOrder(order);
      if (!assignedSlot) {
        this.deferOrderWaitingForSlot(order, robotId);
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

    this.stateManager.updateOrder(order.id, { status: "IN_PROGRESS" });
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

      this.stateManager.updateOrder(order.id, { status: "DONE" });
      this.stateManager.pushOrderHistory(order.id, "ORDER_DONE");
      this.eventStore.append({ entityType: "ORDER", entityId: order.id, event: "ORDER_DONE" });
      this.queueManager.clearActive(robotId);
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

      this.stateManager.updateOrder(order.id, {
        status: "ERROR",
        errorReason: executed.error?.message || "step failed",
      });
      this.stateManager.pushOrderHistory(order.id, "ORDER_PAUSED_ERROR", {
        step: currentStep.type,
        error: executed.error?.message,
      });
      this.queueManager.clearActive(robotId);
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

  deferOrderWaitingForSlot(order, robotId) {
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

    this.queueManager.clearActive(robotId);
    this.queueManager.enqueue(updated);
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

  retryOrder(orderId) {
    const order = this.stateManager.getOrder(orderId);
    if (!order) {
      return null;
    }

    const resetSteps = this.buildSteps(order.type);
    const updated = this.stateManager.updateOrder(orderId, {
      status: "PENDING",
      errorReason: null,
      currentStepIndex: 0,
      steps: resetSteps,
      waitingForSlot: false,
    });

    this.queueManager.enqueue(updated);
    this.stateManager.upsertRobot({ id: updated.robotId, status: "IDLE", currentOrderId: null });
    this.eventStore.append({ entityType: "ORDER", entityId: orderId, event: "ORDER_RETRIED" });
    return updated;
  }

  cancelOrder(orderId) {
    const order = this.stateManager.getOrder(orderId);
    if (!order) {
      return null;
    }

    this.queueManager.removeOrder(order.robotId, order.id);

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

    const updated = this.stateManager.updateOrder(orderId, { status: "CANCELED" });
    this.eventStore.append({ entityType: "ORDER", entityId: orderId, event: "ORDER_CANCELED" });
    this.stateManager.upsertRobot({ id: updated.robotId, status: "IDLE", currentOrderId: null });
    return updated;
  }
}

module.exports = {
  OrchestratorService,
};
