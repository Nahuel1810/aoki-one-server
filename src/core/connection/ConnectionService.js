const { ModbusClient } = require("../../infra/transport/modbus/ModbusClient");
const { decodeResponse } = require("../../config/plcProtocol");

class ConnectionService {
  constructor(options) {
    this.deviceRegistry = options.deviceRegistry;
    this.stateManager = options.stateManager;
    this.logger = options.logger || console;
    this.simulate = options.simulate ?? true;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || Number(process.env.HEARTBEAT_INTERVAL_MS || 1000);
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs || Number(process.env.HEARTBEAT_TIMEOUT_MS || 3000);
    this.clients = new Map();
    this.monitorTimer = null;
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
          retryAttempts: Number(process.env.MODBUS_RETRY_ATTEMPTS || 3),
          retryBackoffMs: Number(process.env.MODBUS_RETRY_BACKOFF_MS || 300),
        })
      );
    }

    return this.clients.get(key);
  }

  startMonitoring() {
    if (this.monitorTimer) {
      return;
    }

    this.monitorTimer = setInterval(() => {
      this.monitorTick().catch((error) => {
        this.logger.warn("[connection] monitor tick failed", { error: error.message });
      });
    }, this.heartbeatIntervalMs);
  }

  stopMonitoring() {
    if (!this.monitorTimer) {
      return;
    }

    clearInterval(this.monitorTimer);
    this.monitorTimer = null;
  }

  async monitorTick() {
    for (const robot of this.stateManager.listRobots()) {
      await this.heartbeat(robot.id);
    }
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
          lastSeen: device.lastSeen,
          lastResponse: { error: error.message },
        });

        if (!this.simulate) {
          try {
            await this.connectDevice(device);
          } catch {
            // Ignore reconnect error here; monitor loop will keep retrying.
          }
        }
      }

      const latest = this.getDevice(robotId, device.type);
      if (latest?.lastSeen && Date.now() - latest.lastSeen > this.heartbeatTimeoutMs) {
        this.deviceRegistry.updateStatus(robotId, device.type, "OFFLINE", {
          lastResponse: { error: "heartbeat timeout" },
        });
        this.stateManager.upsertDevice({
          ...latest,
          status: "OFFLINE",
          lastResponse: { error: "heartbeat timeout" },
        });
      }
    }
  }

  matchesExpectedResponse(code, expectedResponses = [100]) {
    return expectedResponses.some((expected) => {
      if (typeof expected === "number") {
        return Number(code) === expected;
      }

      if (expected === "1##") {
        return Number(code) >= 100 && Number(code) <= 199;
      }

      if (expected === "2##") {
        return Number(code) >= 200 && Number(code) <= 299;
      }

      return false;
    });
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

    const responseAddress = Number(command.responseAddress ?? process.env.MODBUS_RESPONSE_REGISTER ?? 2);
    const responseValues = await client.readHoldingRegisters(responseAddress, 1);
    const responseCode = responseValues[0] ?? null;
    const decoded = decodeResponse(responseCode);

    const stateValues = await client.readHoldingRegisters(command.verifyAddress, 1);
    const verifyOk = stateValues[0] === command.expectedValue;
    const responseOk = this.matchesExpectedResponse(responseCode, command.expectedResponses || [100]);
    const stateOk = verifyOk && responseOk;

    this.deviceRegistry.updateStatus(robotId, device.type, "CONNECTED", {
      lastCommand: command,
      lastResponse: { verifyValue: stateValues[0], responseCode, decoded, stateOk },
    });

    this.stateManager.upsertDevice({
      ...device,
      status: "CONNECTED",
      lastSeen: Date.now(),
      lastCommand: command,
      lastResponse: { verifyValue: stateValues[0], responseCode, decoded, stateOk },
    });

    return {
      ack: decoded.ok ? "DONE" : "ERROR",
      stateOk,
      raw: { verifyValue: stateValues[0], responseCode, decoded },
    };
  }
}

module.exports = {
  ConnectionService,
};
