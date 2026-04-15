class DeviceRegistry {
  constructor() {
    this.devices = new Map();
  }

  key(robotId, type) {
    return `${robotId}:${type}`;
  }

  register(device) {
    const key = this.key(device.robotId, device.type);
    this.devices.set(key, {
      ...device,
      status: device.status || "DISCONNECTED",
      lastSeen: device.lastSeen || null,
      updatedAt: Date.now(),
    });

    return this.devices.get(key);
  }

  updateStatus(robotId, type, status, details = {}) {
    const key = this.key(robotId, type);
    const current = this.devices.get(key);
    if (!current) {
      return null;
    }

    const merged = {
      ...current,
      ...details,
      status,
      lastSeen: Date.now(),
      updatedAt: Date.now(),
    };

    this.devices.set(key, merged);
    return merged;
  }

  get(robotId, type) {
    return this.devices.get(this.key(robotId, type)) || null;
  }

  listByRobot(robotId) {
    return [...this.devices.values()].filter((device) => String(device.robotId) === String(robotId));
  }

  all() {
    return [...this.devices.values()];
  }
}

module.exports = {
  DeviceRegistry,
};
