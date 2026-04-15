const { ModbusClient } = require("../../infra/transport/modbus/ModbusClient");

class ConnectionService {
  constructor(options) {
    this.deviceRegistry = options.deviceRegistry;
    this.stateManager = options.stateManager;
    this.logger = options.logger || console;
    this.simulate = options.simulate ?? true;
    this.clients = new Map();
  }

  deviceKey(robotId, type) {
    return `${robotId}:${type}`;
  }

  registerDevice(deviceInput) {
    const device = this.deviceRegistry.register(deviceInput);
    this.stateManager.upsertDevice(device);
    return device;
  }

  getDevice(robotId, type) {
    return this.deviceRegistry.get(robotId, type);
  }

  async getClient(device) {
    const key = this.deviceKey(device.robotId, device.type);
    if (!this.clients.has(key)) {
      this.clients.set(
        key,
        new ModbusClient({
          host: device.host,
          port: device.port || 502,
          unitId: device.unitId || 1,
          timeoutMs: device.timeoutMs || 2000,
        })
      );
    }

    return this.clients.get(key);
  }

  async connectDevice(device) {
    if (this.simulate) {
      this.deviceRegistry.updateStatus(device.robotId, device.type, "CONNECTED");
      this.stateManager.upsertDevice({ ...device, status: "CONNECTED", lastSeen: Date.now() });
      return;
    }

    const client = await this.getClient(device);
    await client.connect();
    this.deviceRegistry.updateStatus(device.robotId, device.type, "CONNECTED");
    this.stateManager.upsertDevice({ ...device, status: "CONNECTED", lastSeen: Date.now() });
  }

  async heartbeat(robotId) {
    const devices = this.deviceRegistry.listByRobot(robotId);

    for (const device of devices) {
      try {
        if (this.simulate) {
          this.deviceRegistry.updateStatus(robotId, device.type, "CONNECTED");
          this.stateManager.upsertDevice({
            ...device,
            status: "CONNECTED",
            lastSeen: Date.now(),
            lastResponse: { heartbeat: true, simulated: true },
          });
          continue;
        }

        const client = await this.getClient(device);
        const values = await client.readHoldingRegisters(device.heartbeatRegister || 0, 1);
        this.deviceRegistry.updateStatus(robotId, device.type, "CONNECTED", {
          lastResponse: { heartbeatValue: values[0] ?? null },
        });
        this.stateManager.upsertDevice({
          ...device,
          status: "CONNECTED",
          lastSeen: Date.now(),
          lastResponse: { heartbeatValue: values[0] ?? null },
        });
      } catch (error) {
        this.logger.warn("[connection] heartbeat failed", {
          robotId,
          type: device.type,
          error: error.message,
        });

        this.deviceRegistry.updateStatus(robotId, device.type, "DISCONNECTED", {
          lastResponse: { error: error.message },
        });
        this.stateManager.upsertDevice({
          ...device,
          status: "DISCONNECTED",
          lastSeen: Date.now(),
          lastResponse: { error: error.message },
        });
      }
    }
  }

  async executeStepCommand({ robotId, step, command }) {
    const device = this.getDevice(robotId, step.deviceType);
    if (!device) {
      const error = new Error(`No hay dispositivo ${step.deviceType} para robot ${robotId}`);
      error.fatal = true;
      throw error;
    }

    if (this.simulate) {
      this.deviceRegistry.updateStatus(robotId, device.type, "CONNECTED", {
        lastCommand: command,
        lastResponse: { ack: "DONE", simulated: true, step: step.type },
      });
      this.stateManager.upsertDevice({
        ...device,
        status: "CONNECTED",
        lastSeen: Date.now(),
        lastCommand: command,
        lastResponse: { ack: "DONE", simulated: true, step: step.type },
      });
      return { ack: "DONE", stateOk: true, raw: { simulated: true } };
    }

    const client = await this.getClient(device);
    await client.writeSingleRegister(command.address, command.value);

    const stateValues = await client.readHoldingRegisters(command.verifyAddress, 1);
    const stateOk = stateValues[0] === command.expectedValue;

    this.deviceRegistry.updateStatus(robotId, device.type, "CONNECTED", {
      lastCommand: command,
      lastResponse: { verifyValue: stateValues[0], stateOk },
    });

    this.stateManager.upsertDevice({
      ...device,
      status: "CONNECTED",
      lastSeen: Date.now(),
      lastCommand: command,
      lastResponse: { verifyValue: stateValues[0], stateOk },
    });

    return {
      ack: "DONE",
      stateOk,
      raw: { verifyValue: stateValues[0] },
    };
  }
}

module.exports = {
  ConnectionService,
};
