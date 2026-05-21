const { QueueManager } = require("./QueueManager");

/**
 * HTTP client queue manager. Extends QueueManager and overrides all public
 * methods to delegate to an external aoki-queue-server instance.
 *
 * The external server is responsible for persisting queue state in Redis so
 * that orders survive restarts of this process.
 *
 * @extends QueueManager
 */
class ExternalQueueManager extends QueueManager {
  /**
   * @param {object} options
   * @param {string} options.baseUrl  - Base URL of aoki-queue-server (e.g. http://192.168.1.5:4000)
   * @param {object} [options.logger] - Logger instance
   * @param {number} [options.timeoutMs=8000] - Request timeout in milliseconds
   */
  constructor({ baseUrl, logger, timeoutMs = 8000 } = {}) {
    super();
    if (!baseUrl) {
      throw new Error("[ExternalQueueManager] baseUrl is required");
    }
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.logger = logger || console;
    this.timeoutMs = timeoutMs;
  }

  // ── HTTP helpers ──────────────────────────────────────────────

  async _request(method, path, body) {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        signal: controller.signal,
        headers: body !== undefined ? { "Content-Type": "application/json" } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      const data = await res.json();

      if (!res.ok || data.ok === false) {
        const msg = data?.error || `HTTP ${res.status}`;
        throw new Error(`[ExternalQueueManager] ${method} ${path} → ${msg}`);
      }

      return data;
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error(`[ExternalQueueManager] timeout calling ${method} ${path}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  _robotPath(robotId) {
    return `/robots/${encodeURIComponent(robotId)}/queue`;
  }

  // ── Queue operations (override) ───────────────────────────────

  async clear() {
    await this._request("DELETE", "/queue");
  }

  async ensureRobot(robotId) {
    const { data } = await this._request("GET", `${this._robotPath(robotId)}/state`);
    return data;
  }

  async enqueue(order) {
    await this._request("POST", `${this._robotPath(order.robotId)}/enqueue`, { orderId: order.id });
  }

  async restoreRobotQueue(robotId, queuedOrderIds = [], activeOrderId = null, paused = false) {
    await this._request("PUT", `${this._robotPath(robotId)}/state`, {
      queuedOrderIds,
      activeOrderId,
      paused,
    });
  }

  async setActive(robotId, orderId) {
    await this._request("PATCH", `${this._robotPath(robotId)}/active`, { orderId });
  }

  async clearActive(robotId) {
    await this._request("DELETE", `${this._robotPath(robotId)}/active`);
  }

  async dequeueNext(robotId) {
    const { data } = await this._request("POST", `${this._robotPath(robotId)}/dequeue`);
    return data.orderId || null;
  }

  async pauseQueue(robotId) {
    const { data } = await this._request("POST", `${this._robotPath(robotId)}/pause`);
    return data;
  }

  async resumeQueue(robotId) {
    const { data } = await this._request("POST", `${this._robotPath(robotId)}/resume`);
    return data;
  }

  async isQueuePaused(robotId) {
    const { data } = await this._request("GET", `${this._robotPath(robotId)}/state`);
    return data.paused === true;
  }

  async removeOrder(robotId, orderId) {
    await this._request("DELETE", `${this._robotPath(robotId)}/items/${encodeURIComponent(orderId)}`);
  }

  async isRobotBusy(robotId) {
    const { data } = await this._request("GET", `${this._robotPath(robotId)}/state`);
    return !!data.activeOrderId;
  }

  async getSnapshot() {
    const { data } = await this._request("GET", "/queue/snapshot");
    return data;
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  async disconnect() {
    // HTTP client — nothing to close
  }
}

module.exports = {
  ExternalQueueManager,
};
