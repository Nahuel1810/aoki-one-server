const { ModbusClient } = require("../../infra/transport/modbus/ModbusClient");
const { decodeResponse } = require("../../config/plcProtocol");
const { mergeRegisterMaps } = require("../../config/deviceRegisterMaps");

class ConnectionService {
  constructor(options) {
    this.deviceRegistry = options.deviceRegistry;
    this.stateManager = options.stateManager;
    this.logger = options.logger || console;
    this.simulate = options.simulate ?? true;
    this.connectionCheckIntervalMs =
      options.connectionCheckIntervalMs ||
      options.heartbeatIntervalMs ||
      Number(process.env.CONNECTION_CHECK_INTERVAL_MS || process.env.HEARTBEAT_INTERVAL_MS || 1000);
    this.connectionTimeoutMs =
      options.connectionTimeoutMs ||
      options.heartbeatTimeoutMs ||
      Number(process.env.CONNECTION_TIMEOUT_MS || process.env.HEARTBEAT_TIMEOUT_MS || 3000);
    this.clients = new Map();
    this.monitorTimer = null;
  }

  deviceKey(robotId, type) {
    return `${robotId}:${type}`;
  }

  registerDevice(deviceInput) {
    const mergedRegisterMap = mergeRegisterMaps(deviceInput.type, deviceInput.registerMap);
    if (!Number.isFinite(Number(mergedRegisterMap.messageIn))) {
      throw new Error("registerMap.messageIn es obligatorio");
    }

    if (!Number.isFinite(Number(mergedRegisterMap.messageOut))) {
      throw new Error("registerMap.messageOut es obligatorio");
    }

    const device = this.deviceRegistry.register({
      ...deviceInput,
      registerMap: mergedRegisterMap,
    });
    this.stateManager.upsertDevice(device);
    return device;
  }

  getRegisterMap(device) {
    return mergeRegisterMaps(device.type, device.registerMap);
  }

  CONNECTEDresolveRegister(device, key, overrideValue) {
    if (overrideValue !== undefined && overrideValue !== null && overrideValue !== "") {
      return Number(overrideValue);
    }

    const registerMap = this.getRegisterMap(device);
    const value = registerMap[key];
    if (value === undefined || value === null || value === "") {
      throw new Error(`No hay registro configurado para '${key}' en dispositivo ${device.type}`);
    }

    return Number(value);
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
    }, this.connectionCheckIntervalMs);
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
      await this.checkRobotConnections(robot.id);
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

  async checkRobotConnections(robotId) {
    const devices = this.deviceRegistry.listByRobot(robotId);

    for (const device of devices) {
      try {
        if (this.simulate) {
          this.deviceRegistry.updateStatus(robotId, device.type, "CONNECTED");
          this.stateManager.upsertDevice({
            ...device,
            status: "CONNECTED",
            lastSeen: Date.now(),
            lastResponse: { connected: true, simulated: true },
          });
          continue;
        }

        const client = await this.getClient(device);
        await client.ensureConnected();
        this.deviceRegistry.updateStatus(robotId, device.type, "CONNECTED", {
          lastResponse: { connected: true },
        });
        this.stateManager.upsertDevice({
          ...device,
          status: "CONNECTED",
          lastSeen: Date.now(),
          lastResponse: { connected: true },
        });
      } catch (error) {
        this.logger.warn("[connection] connection check failed", {
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
      if (latest?.lastSeen && Date.now() - latest.lastSeen > this.connectionTimeoutMs) {
        this.deviceRegistry.updateStatus(robotId, device.type, "OFFLINE", {
          lastResponse: { error: "connection timeout" },
        });
        this.stateManager.upsertDevice({
          ...latest,
          status: "OFFLINE",
          lastResponse: { error: "connection timeout" },
        });
      }
    }
  }

  // Backward compatibility for callers using the old method name.
  async heartbeat(robotId) {
    return this.checkRobotConnections(robotId);
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

  splitCarroCommandValue(value) {
    const normalized = Number(value);
    if (!Number.isFinite(normalized)) {
      throw new Error("Comando de carro invalido");
    }

    const digits = String(Math.trunc(normalized)).padStart(5, "0").slice(-5);
    return {
      high: Number(digits[0]),
      low: Number(digits.slice(1)),
      raw: digits,
    };
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
    const commandAddress = this.resolveRegister(device, "messageIn", command.address);
    const responseAddress = this.resolveRegister(device, "messageOut", command.responseAddress);

    if (String(device.type).toUpperCase() === "CARRO") {
      const { high, low } = this.splitCarroCommandValue(command.value);
      await client.writeSingleRegister(commandAddress, high);
      await client.writeSingleRegister(commandAddress + 1, low);
    } else {
      await client.writeSingleRegister(commandAddress, Number(command.value));
    }

    const responseValues = await client.readHoldingRegisters(responseAddress, 1);
    const responseCode = responseValues[0] ?? null;

    const decoded = decodeResponse(responseCode);
    const responseOk = this.matchesExpectedResponse(responseCode, command.expectedResponses || [100]);
    const stateOk = responseOk;

    this.deviceRegistry.updateStatus(robotId, device.type, "CONNECTED", {
      lastCommand: command,
      lastResponse: { responseCode, decoded, stateOk },
    });

    this.stateManager.upsertDevice({
      ...device,
      status: "CONNECTED",
      lastSeen: Date.now(),
      lastCommand: command,
      lastResponse: { responseCode, decoded, stateOk },
    });

    return {
      ack: decoded.ok ? "DONE" : "ERROR",
      stateOk,
      raw: { responseCode, decoded },
    };
  }

  async readVariable({ robotId, type, variable, length = 1 }) {
    const device = this.getDevice(robotId, type);
    if (!device) {
      throw new Error(`No hay dispositivo ${type} para robot ${robotId}`);
    }

    if (this.simulate) {
      return new Array(length).fill(0);
    }

    const client = await this.getClient(device);
    const address = this.resolveRegister(device, variable);
    return client.readHoldingRegisters(address, length);
  }

  async writeVariable({ robotId, type, variable, value }) {
    const device = this.getDevice(robotId, type);
    if (!device) {
      throw new Error(`No hay dispositivo ${type} para robot ${robotId}`);
    }

    if (this.simulate) {
      return { ok: true, simulated: true };
    }

    const client = await this.getClient(device);
    const address = this.resolveRegister(device, variable);
    await client.writeSingleRegister(address, Number(value));
    return { ok: true };
  }
}

module.exports = {
  ConnectionService,
};
