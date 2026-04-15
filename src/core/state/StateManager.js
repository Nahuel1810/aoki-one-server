const { randomUUID } = require("node:crypto");

class StateManager {
  constructor() {
    this.orders = new Map();
    this.robots = new Map();
    this.devices = new Map();
    this.commands = new Map();
    this.errors = [];
  }

  upsertRobot(robot) {
    const current = this.robots.get(robot.id) || {};
    const merged = {
      id: robot.id,
      status: "IDLE",
      currentOrderId: null,
      mode: "AUTO",
      enabled: true,
      lastHeartbeat: null,
      ...current,
      ...robot,
      updatedAt: Date.now(),
    };

    this.robots.set(merged.id, merged);
    return merged;
  }

  upsertDevice(device) {
    const key = `${device.robotId}:${device.type}`;
    const current = this.devices.get(key) || {};
    const merged = {
      id: key,
      status: "DISCONNECTED",
      lastSeen: null,
      lastCommand: null,
      lastResponse: null,
      ...current,
      ...device,
      updatedAt: Date.now(),
    };

    this.devices.set(key, merged);
    return merged;
  }

  createOrder(input) {
    const now = Date.now();
    const order = {
      id: randomUUID(),
      type: input.type,
      status: "PENDING",
      priority: Number.isFinite(input.priority) ? input.priority : 0,
      locationCode: input.locationCode,
      targetLocation: input.targetLocation || null,
      currentStepIndex: 0,
      robotId: input.robotId,
      errorReason: null,
      steps: input.steps,
      history: [{ ts: now, event: "ORDER_CREATED" }],
      createdAt: now,
      updatedAt: now,
    };

    this.orders.set(order.id, order);
    return order;
  }

  updateOrder(orderId, patch) {
    const order = this.orders.get(orderId);
    if (!order) {
      return null;
    }

    const merged = {
      ...order,
      ...patch,
      updatedAt: Date.now(),
    };

    this.orders.set(orderId, merged);
    return merged;
  }

  pushOrderHistory(orderId, event, metadata = null) {
    const order = this.orders.get(orderId);
    if (!order) {
      return;
    }

    order.history.push({ ts: Date.now(), event, metadata });
    order.updatedAt = Date.now();
  }

  addCommand(command) {
    const entity = {
      id: randomUUID(),
      status: "SENT",
      sentAt: Date.now(),
      acknowledgedAt: null,
      finishedAt: null,
      rawResponse: null,
      ...command,
    };

    this.commands.set(entity.id, entity);
    return entity;
  }

  updateCommand(commandId, patch) {
    const command = this.commands.get(commandId);
    if (!command) {
      return null;
    }

    const merged = { ...command, ...patch };
    this.commands.set(commandId, merged);
    return merged;
  }

  addError(errorEntity) {
    const entity = {
      id: randomUUID(),
      timestamp: Date.now(),
      severity: "ERROR",
      ...errorEntity,
    };

    this.errors.push(entity);
    return entity;
  }

  getOrder(orderId) {
    return this.orders.get(orderId) || null;
  }

  listOrders() {
    return [...this.orders.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  listRobots() {
    return [...this.robots.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  listDevices() {
    return [...this.devices.values()];
  }

  listErrors() {
    return [...this.errors].sort((a, b) => b.timestamp - a.timestamp);
  }

  getSnapshot() {
    return {
      orders: this.listOrders(),
      robots: this.listRobots(),
      devices: this.listDevices(),
      commands: [...this.commands.values()],
      errors: this.listErrors(),
      snapshotAt: Date.now(),
    };
  }
}

module.exports = {
  StateManager,
};
