class QueueManager {
  constructor() {
    this.byRobot = new Map();
  }

  clear() {
    this.byRobot.clear();
  }

  ensureRobot(robotId) {
    if (!this.byRobot.has(robotId)) {
      this.byRobot.set(robotId, { activeOrderId: null, items: [], paused: false });
    }

    return this.byRobot.get(robotId);
  }

  enqueue(order) {
    const state = this.ensureRobot(order.robotId);
    state.items.push(order.id);
  }

  restoreRobotQueue(robotId, queuedOrderIds = [], activeOrderId = null, paused = false) {
    this.byRobot.set(robotId, {
      activeOrderId,
      items: [...queuedOrderIds],
      paused,
    });
  }

  setActive(robotId, orderId) {
    const state = this.ensureRobot(robotId);
    state.activeOrderId = orderId;
  }

  clearActive(robotId) {
    const state = this.ensureRobot(robotId);
    state.activeOrderId = null;
  }

  dequeueNext(robotId) {
    const state = this.ensureRobot(robotId);
    if (state.paused) {
      return null;
    }
    return state.items.shift() || null;
  }

  pauseQueue(robotId) {
    const state = this.ensureRobot(robotId);
    state.paused = true;
    return state;
  }

  resumeQueue(robotId) {
    const state = this.ensureRobot(robotId);
    state.paused = false;
    return state;
  }

  isQueuePaused(robotId) {
    const state = this.ensureRobot(robotId);
    return state.paused;
  }

  removeOrder(robotId, orderId) {
    const state = this.ensureRobot(robotId);
    state.items = state.items.filter((id) => id !== orderId);
    if (state.activeOrderId === orderId) {
      state.activeOrderId = null;
    }
  }

  isRobotBusy(robotId) {
    const state = this.ensureRobot(robotId);
    return state.activeOrderId !== null;
  }

  getSnapshot() {
    const snapshot = [];
    for (const [robotId, state] of this.byRobot.entries()) {
      snapshot.push({
        robotId,
        activeOrderId: state.activeOrderId,
        queueLength: state.items.length,
        paused: state.paused,
        queuedOrderIds: [...state.items],
      });
    }

    return snapshot;
  }
}

module.exports = {
  QueueManager,
};
