class QueueManager {
  constructor() {
    this.byRobot = new Map();
  }

  ensureRobot(robotId) {
    if (!this.byRobot.has(robotId)) {
      this.byRobot.set(robotId, { activeOrderId: null, items: [] });
    }

    return this.byRobot.get(robotId);
  }

  enqueue(order) {
    const state = this.ensureRobot(order.robotId);
    state.items.push(order.id);
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
    return state.items.shift() || null;
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
        queuedOrderIds: [...state.items],
      });
    }

    return snapshot;
  }
}

module.exports = {
  QueueManager,
};
