const { randomUUID } = require("node:crypto");
const { parseLocationCode } = require("../orchestrator/locationTranslator");

const SLOT_STATUS = {
  FREE: "FREE",
  RESERVED: "RESERVED",
  PICK_IN_PROGRESS: "PICK_IN_PROGRESS",
  OCCUPIED: "OCCUPIED",
  PUT_IN_PROGRESS: "PUT_IN_PROGRESS",
  BLOCKED: "BLOCKED",
};

function normalizeLocationCode(value) {
  const parsed = parseLocationCode(value);
  return parsed.baseCode;
}

function buildInitialSlot(locationCode) {
  return {
    id: randomUUID(),
    locationCode,
    status: SLOT_STATUS.FREE,
    reservedByOrderId: null,
    currentBox: null,
    lastError: null,
    updatedAt: Date.now(),
  };
}

class StateManager {
  constructor(options = {}) {
    this.orders = new Map();
    this.robots = new Map();
    this.devices = new Map();
    this.commands = new Map();
    this.slots = new Map();
    this.errors = [];

    this.initialPickSlots = Array.isArray(options.pickSlots) ? options.pickSlots : [];
    this.configurePickSlots(this.initialPickSlots);
  }

  reset() {
    this.orders.clear();
    this.robots.clear();
    this.devices.clear();
    this.commands.clear();
    this.slots.clear();
    this.errors = [];

    this.configurePickSlots(this.initialPickSlots);
  }

  configurePickSlots(locationCodes = []) {
    for (const code of locationCodes) {
      const normalized = normalizeLocationCode(code);
      if (this.slots.has(normalized)) {
        continue;
      }

      this.slots.set(normalized, buildInitialSlot(normalized));
    }
  }

  hydrateFromSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") {
      return;
    }

    this.reset();

    for (const order of snapshot.orders || []) {
      this.orders.set(order.id, order);
    }

    for (const robot of snapshot.robots || []) {
      this.robots.set(robot.id, robot);
    }

    for (const device of snapshot.devices || []) {
      this.devices.set(`${device.robotId}:${device.type}`, device);
    }

    for (const command of snapshot.commands || []) {
      this.commands.set(command.id, command);
    }

    for (const slot of snapshot.slots || []) {
      const normalized = normalizeLocationCode(slot.locationCode);
      this.slots.set(normalized, {
        ...buildInitialSlot(normalized),
        ...slot,
        locationCode: normalized,
        updatedAt: Date.now(),
      });
    }

    this.errors = Array.isArray(snapshot.errors) ? [...snapshot.errors] : [];
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
      slotLocationCode: input.slotLocationCode || null,
      waitingForSlot: Boolean(input.waitingForSlot),
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

  getSlot(locationCode) {
    const normalized = normalizeLocationCode(locationCode);
    return this.slots.get(normalized) || null;
  }

  listSlots() {
    return [...this.slots.values()].sort((a, b) => a.locationCode.localeCompare(b.locationCode));
  }

  listAvailableSlots() {
    return this.listSlots().filter((slot) => slot.status === SLOT_STATUS.FREE);
  }

  reserveSlot(locationCode, orderId) {
    const normalized = normalizeLocationCode(locationCode);
    const slot = this.slots.get(normalized);
    if (!slot || slot.status !== SLOT_STATUS.FREE) {
      return null;
    }

    const updated = {
      ...slot,
      status: SLOT_STATUS.RESERVED,
      reservedByOrderId: orderId,
      updatedAt: Date.now(),
      lastError: null,
    };

    this.slots.set(normalized, updated);
    return updated;
  }

  markSlotPickInProgress(locationCode, orderId) {
    return this.updateSlotStatus(locationCode, SLOT_STATUS.PICK_IN_PROGRESS, orderId);
  }

  markSlotPutInProgress(locationCode, orderId) {
    return this.updateSlotStatus(locationCode, SLOT_STATUS.PUT_IN_PROGRESS, orderId);
  }

  markSlotOccupied(locationCode, orderId, boxData = {}) {
    const normalized = normalizeLocationCode(locationCode);
    const slot = this.slots.get(normalized);
    if (!slot) {
      return null;
    }

    const updated = {
      ...slot,
      status: SLOT_STATUS.OCCUPIED,
      reservedByOrderId: orderId,
      currentBox: {
        id: boxData.id || `ORDER:${orderId}`,
        sourceLocationCode: boxData.sourceLocationCode || null,
        pickOrderId: boxData.pickOrderId || orderId,
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
      lastError: null,
    };

    this.slots.set(normalized, updated);
    return updated;
  }

  reserveOccupiedSlotForPut(locationCode, orderId) {
    const normalized = normalizeLocationCode(locationCode);
    const slot = this.slots.get(normalized);
    if (!slot || slot.status !== SLOT_STATUS.OCCUPIED) {
      return null;
    }

    const updated = {
      ...slot,
      status: SLOT_STATUS.RESERVED,
      reservedByOrderId: orderId,
      updatedAt: Date.now(),
      lastError: null,
    };

    this.slots.set(normalized, updated);
    return updated;
  }

  releaseSlot(locationCode) {
    const normalized = normalizeLocationCode(locationCode);
    const slot = this.slots.get(normalized);
    if (!slot) {
      return null;
    }

    const updated = {
      ...slot,
      status: SLOT_STATUS.FREE,
      reservedByOrderId: null,
      currentBox: null,
      updatedAt: Date.now(),
      lastError: null,
    };

    this.slots.set(normalized, updated);
    return updated;
  }

  blockSlot(locationCode, reason, orderId = null) {
    const normalized = normalizeLocationCode(locationCode);
    const slot = this.slots.get(normalized);
    if (!slot) {
      return null;
    }

    const updated = {
      ...slot,
      status: SLOT_STATUS.BLOCKED,
      reservedByOrderId: orderId || slot.reservedByOrderId || null,
      lastError: reason || null,
      updatedAt: Date.now(),
    };

    this.slots.set(normalized, updated);
    return updated;
  }

  updateSlotStatus(locationCode, status, orderId = null) {
    const normalized = normalizeLocationCode(locationCode);
    const slot = this.slots.get(normalized);
    if (!slot) {
      return null;
    }

    const updated = {
      ...slot,
      status,
      reservedByOrderId: orderId || slot.reservedByOrderId || null,
      updatedAt: Date.now(),
    };

    this.slots.set(normalized, updated);
    return updated;
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
      slots: this.listSlots(),
      errors: this.listErrors(),
      snapshotAt: Date.now(),
    };
  }
}

module.exports = {
  StateManager,
  SLOT_STATUS,
};
