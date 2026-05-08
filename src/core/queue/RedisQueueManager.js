const Redis = require("ioredis");

class RedisQueueManager {
  /**
   * @param {object} options
   * @param {string} [options.url] - Redis connection URL (e.g. redis://127.0.0.1:6379)
   * @param {string} [options.prefix] - Key prefix for namespace isolation (default: "aoki")
   * @param {object} [options.logger] - Logger instance
   * @param {object} [options.redisClient] - Pre-built ioredis client (for testing)
   */
  constructor(options = {}) {
    this.prefix = options.prefix || "aoki-one";
    this.logger = options.logger || console;

    if (options.redisClient) {
      this.redis = options.redisClient;
      this._ownsConnection = false;
    } else {
      const url = options.url || process.env.REDIS_URL || "redis://127.0.0.1:6379";
      this.redis = new Redis(url, {
        maxRetriesPerRequest: 3,
        retryStrategy(times) {
          const delay = Math.min(times * 200, 3000);
          return delay;
        },
        lazyConnect: false,
      });
      this._ownsConnection = true;
    }

    this.redis.on("error", (err) => {
      this.logger.error?.("[RedisQueueManager] connection error", { error: err.message });
    });
  }

  // ── Key helpers ──────────────────────────────────────────────

  _itemsKey(robotId) {
    return `${this.prefix}:queue:${robotId}:items`;
  }

  _stateKey(robotId) {
    return `${this.prefix}:queue:${robotId}:state`;
  }

  // ── Public API (same interface as QueueManager) ──────────────

  async clear() {
    const pattern = `${this.prefix}:queue:*`;
    let cursor = "0";

    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = nextCursor;

      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } while (cursor !== "0");
  }

  async ensureRobot(robotId) {
    const stateKey = this._stateKey(robotId);
    const raw = await this.redis.hgetall(stateKey);

    if (!raw || Object.keys(raw).length === 0) {
      await this.redis.hset(stateKey, "activeOrderId", "", "paused", "0");
      const items = await this.redis.lrange(this._itemsKey(robotId), 0, -1);
      return { activeOrderId: null, items, paused: false };
    }

    const items = await this.redis.lrange(this._itemsKey(robotId), 0, -1);
    return {
      activeOrderId: raw.activeOrderId || null,
      items,
      paused: raw.paused === "1",
    };
  }

  async enqueue(order) {
    await this.ensureRobot(order.robotId);
    await this.redis.rpush(this._itemsKey(order.robotId), order.id);
  }

  async restoreRobotQueue(robotId, queuedOrderIds = [], activeOrderId = null, paused = false) {
    const itemsKey = this._itemsKey(robotId);
    const stateKey = this._stateKey(robotId);

    const pipeline = this.redis.pipeline();
    pipeline.del(itemsKey);

    if (queuedOrderIds.length > 0) {
      pipeline.rpush(itemsKey, ...queuedOrderIds);
    }

    pipeline.hset(stateKey, "activeOrderId", activeOrderId || "", "paused", paused ? "1" : "0");
    await pipeline.exec();
  }

  async setActive(robotId, orderId) {
    await this.redis.hset(this._stateKey(robotId), "activeOrderId", orderId);
  }

  async clearActive(robotId) {
    await this.redis.hset(this._stateKey(robotId), "activeOrderId", "");
  }

  async dequeueNext(robotId) {
    const paused = await this.redis.hget(this._stateKey(robotId), "paused");
    if (paused === "1") {
      return null;
    }

    const orderId = await this.redis.lpop(this._itemsKey(robotId));
    return orderId || null;
  }

  async pauseQueue(robotId) {
    await this.ensureRobot(robotId);
    await this.redis.hset(this._stateKey(robotId), "paused", "1");
    return this.ensureRobot(robotId);
  }

  async resumeQueue(robotId) {
    await this.ensureRobot(robotId);
    await this.redis.hset(this._stateKey(robotId), "paused", "0");
    return this.ensureRobot(robotId);
  }

  async isQueuePaused(robotId) {
    const paused = await this.redis.hget(this._stateKey(robotId), "paused");
    return paused === "1";
  }

  async removeOrder(robotId, orderId) {
    await this.redis.lrem(this._itemsKey(robotId), 0, orderId);

    const active = await this.redis.hget(this._stateKey(robotId), "activeOrderId");
    if (active === orderId) {
      await this.redis.hset(this._stateKey(robotId), "activeOrderId", "");
    }
  }

  async isRobotBusy(robotId) {
    const active = await this.redis.hget(this._stateKey(robotId), "activeOrderId");
    return !!active;
  }

  async getSnapshot() {
    const pattern = `${this.prefix}:queue:*:state`;
    const snapshot = [];
    let cursor = "0";

    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = nextCursor;

      for (const stateKey of keys) {
        // Extract robotId from key: {prefix}:queue:{robotId}:state
        const parts = stateKey.split(":");
        const robotId = parts[parts.length - 2];

        const [state, items] = await Promise.all([
          this.redis.hgetall(stateKey),
          this.redis.lrange(this._itemsKey(robotId), 0, -1),
        ]);

        snapshot.push({
          robotId,
          activeOrderId: state.activeOrderId || null,
          queueLength: items.length,
          paused: state.paused === "1",
          queuedOrderIds: items,
        });
      }
    } while (cursor !== "0");

    return snapshot;
  }

  // ── Lifecycle ────────────────────────────────────────────────

  async disconnect() {
    if (this._ownsConnection) {
      await this.redis.quit();
    }
  }
}

module.exports = {
  RedisQueueManager,
};
