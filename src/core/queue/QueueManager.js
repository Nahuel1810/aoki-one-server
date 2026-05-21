/**
 * @abstract In-memory queue manager — base class for all queue drivers.
 *
 * All public methods are async-compatible (sync implementations that return
 * plain values work transparently with `await`). Subclasses should override
 * every public method to connect to an external backend.
 *
 * @example
 * // Simulation / testing
 * const queue = new QueueManager();
 *
 * // Production — external backend
 * class MyQueue extends QueueManager {
 *   async enqueue(order) { ... }
 *   // ... override the rest
 * }
 */
class QueueManager {
  constructor() {
    this.byRobot = new Map();
  }

  // ── State helpers ─────────────────────────────────────────────

  clear() {
    this.byRobot.clear();
  }

  ensureRobot(robotId) {
    if (!this.byRobot.has(robotId)) {
      this.byRobot.set(robotId, { activeOrderId: null, items: [], paused: false });
    }

    return this.byRobot.get(robotId);
  }

  // ── Queue operations ──────────────────────────────────────────

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

  // ── Lifecycle ─────────────────────────────────────────────────

  /**
   * Release any external connections. No-op for in-memory driver.
   * Subclasses should override this to close Redis/HTTP connections.
   */
  async disconnect() {}
}

module.exports = {
  QueueManager,
};
