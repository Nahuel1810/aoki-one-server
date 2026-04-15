const { CARRO, buildElevadorIrNivel } = require("../../config/plcProtocol");

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

  static inferRobotId(locationCode) {
    const raw = String(locationCode || "").trim();
    if (!raw) {
      return null;
    }

    return raw.slice(0, 1);
  }

  static inferLevel(locationCode) {
    const digits = String(locationCode || "").replace(/\D/g, "");
    if (digits.length < 2) {
      return 0;
    }

    return Number(digits.slice(1, 3));
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
    const locationNumber = Number(order.locationCode) || 0;
    const targetNumber = Number(order.targetLocation) || locationNumber;
    const level = OrchestratorService.inferLevel(order.locationCode);

    const commandCodes = {
      HOMING: CARRO.COMMANDS.INIT,
      ELEVADOR: buildElevadorIrNivel(level),
      CARRO_BUSCA: locationNumber,
      CARRO_DEJA: targetNumber,
      CARRO_DEVUELVE: targetNumber,
    };

    return {
      commandCode: commandCodes[step.type] || 0,
      address: Number(process.env.MODBUS_COMMAND_REGISTER || 0),
      value: commandCodes[step.type] || 0,
      responseAddress: Number(process.env.MODBUS_RESPONSE_REGISTER || 2),
      expectedResponses: [100],
      verifyAddress: Number(process.env.MODBUS_VERIFY_REGISTER || 1),
      expectedValue: step.id,
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

    const robotId = input.robotId || OrchestratorService.inferRobotId(input.locationCode);
    if (!robotId) {
      throw new Error("No se pudo derivar robotId. Enviar robotId o locationCode valido");
    }

    const steps = this.buildSteps(type);
    const order = this.stateManager.createOrder({
      ...input,
      type,
      robotId,
      steps,
    });

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
    const order = this.stateManager.getOrder(orderId);
    if (!order) {
      this.queueManager.clearActive(robotId);
      return;
    }

    if (order.status === "DONE" || order.status === "ERROR" || order.status === "CANCELED") {
      this.queueManager.clearActive(robotId);
      this.stateManager.upsertRobot({ id: robotId, status: "IDLE", currentOrderId: null });
      return;
    }

    this.stateManager.updateOrder(order.id, { status: "IN_PROGRESS" });

    const currentStep = order.steps[order.currentStepIndex];
    if (!currentStep) {
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
    const updated = this.stateManager.updateOrder(orderId, { status: "CANCELED" });
    this.eventStore.append({ entityType: "ORDER", entityId: orderId, event: "ORDER_CANCELED" });
    this.stateManager.upsertRobot({ id: updated.robotId, status: "IDLE", currentOrderId: null });
    return updated;
  }
}

module.exports = {
  OrchestratorService,
};
