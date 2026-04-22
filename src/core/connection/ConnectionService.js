const { ModbusClient } = require("../../infra/transport/modbus/ModbusClient");
const { isConnectivityError } = require("../../infra/transport/modbus/modbusConnectivity");
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
    this.recreateClientAfterFailures =
      Number(options.recreateClientAfterFailures) ||
      Number(process.env.CONNECTION_RECREATE_CLIENT_AFTER_FAILURES || 5);
    this.reconnectBackoffBaseMs =
      Number(options.reconnectBackoffBaseMs) ||
      Number(process.env.CONNECTION_RETRY_BACKOFF_BASE_MS || 2000);
    this.reconnectBackoffMaxMs =
      Number(options.reconnectBackoffMaxMs) ||
      Number(process.env.CONNECTION_RETRY_BACKOFF_MAX_MS || 30000);
    this.clients = new Map();
    this.connectionRecovery = new Map();
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

  resolveRegister(device, key, overrideValue) {
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
          unitId: device.unitId || 255,
          timeoutMs: device.timeoutMs || 2000,
        })
      );
    }

    return this.clients.get(key);
  }

  getRecoveryState(robotId, type) {
    const key = this.deviceKey(robotId, type);
    if (!this.connectionRecovery.has(key)) {
      this.connectionRecovery.set(key, {
        consecutiveFailures: 0,
        nextRetryAt: 0,
        lastError: null,
      });
    }

    return this.connectionRecovery.get(key);
  }

  clearRecoveryState(robotId, type) {
    const state = this.getRecoveryState(robotId, type);
    state.consecutiveFailures = 0;
    state.nextRetryAt = 0;
    state.lastError = null;
  }

  calculateBackoffMs(consecutiveFailures) {
    const exponent = Math.max(0, Number(consecutiveFailures) - 1);
    const delay = this.reconnectBackoffBaseMs * 2 ** exponent;
    return Math.min(delay, this.reconnectBackoffMaxMs);
  }

  registerConnectionFailure(robotId, type, error) {
    const state = this.getRecoveryState(robotId, type);
    state.consecutiveFailures += 1;
    state.lastError = error?.message || String(error || "unknown");
    state.nextRetryAt = Date.now() + this.calculateBackoffMs(state.consecutiveFailures);
    return state;
  }

  async recreateClient(device) {
    const key = this.deviceKey(device.robotId, device.type);
    const currentClient = this.clients.get(key);

    if (currentClient) {
      try {
        await currentClient.disconnect?.();
      } catch (error) {
        this.logger.warn?.("[connection] failed to disconnect stale client", {
          robotId: device.robotId,
          type: device.type,
          error: error.message,
        });
      }
    }

    this.clients.delete(key);
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

  restoreRegisteredDevices(devices = []) {
    let restored = 0;

    for (const device of devices) {
      if (!device || !device.robotId || !device.type) {
        continue;
      }

      const normalized = {
        ...device,
        robotId: String(device.robotId),
        type: String(device.type).trim().toUpperCase(),
      };

      this.deviceRegistry.register(normalized);
      this.stateManager.upsertDevice(normalized);
      restored += 1;
    }

    return restored;
  }

  async connectDevice(device) {
    if (this.simulate) {
      this.logger.info?.("[connection] simulated device connected", {
        robotId: device.robotId,
        type: device.type,
      });
      this.deviceRegistry.updateStatus(device.robotId, device.type, "CONNECTED");
      this.stateManager.upsertDevice({ ...device, status: "CONNECTED", lastSeen: Date.now() });
      return;
    }

    this.logger.info?.("[connection] connecting device", {
      robotId: device.robotId,
      type: device.type,
      host: device.host,
      port: device.port || 502,
      unitId: device.unitId || 255,
    });
    const client = await this.getClient(device);
    await client.connect();
    this.logger.info?.("[connection] device connected", {
      robotId: device.robotId,
      type: device.type,
    });
    this.deviceRegistry.updateStatus(device.robotId, device.type, "CONNECTED");
    this.stateManager.upsertDevice({ ...device, status: "CONNECTED", lastSeen: Date.now() });
  }

  async checkRobotConnections(robotId) {
    const devices = this.deviceRegistry.listByRobot(robotId);

    for (const device of devices) {
      const recovery = this.getRecoveryState(robotId, device.type);

      if (!this.simulate && recovery.nextRetryAt > Date.now()) {
        const waitMs = recovery.nextRetryAt - Date.now();
        this.logger.info?.("[connection] retry delayed by backoff", {
          robotId,
          type: device.type,
          waitMs,
          consecutiveFailures: recovery.consecutiveFailures,
        });

        this.deviceRegistry.updateStatus(robotId, device.type, "DISCONNECTED", {
          lastResponse: {
            error: recovery.lastError || "retry delayed by backoff",
            retryInMs: waitMs,
            consecutiveFailures: recovery.consecutiveFailures,
          },
        });
        this.stateManager.upsertDevice({
          ...device,
          status: "DISCONNECTED",
          lastSeen: device.lastSeen,
          lastResponse: {
            error: recovery.lastError || "retry delayed by backoff",
            retryInMs: waitMs,
            consecutiveFailures: recovery.consecutiveFailures,
          },
        });
        continue;
      }

      try {
        if (this.simulate) {
          this.clearRecoveryState(robotId, device.type);
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
        this.clearRecoveryState(robotId, device.type);
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

        const failure = this.registerConnectionFailure(robotId, device.type, error);
        const shouldRecreateClient =
          !this.simulate &&
          this.recreateClientAfterFailures > 0 &&
          failure.consecutiveFailures % this.recreateClientAfterFailures === 0;

        if (shouldRecreateClient) {
          await this.recreateClient(device);
          this.logger.warn("[connection] client recreated after repeated failures", {
            robotId,
            type: device.type,
            consecutiveFailures: failure.consecutiveFailures,
          });
        }

        this.deviceRegistry.updateStatus(robotId, device.type, "DISCONNECTED", {
          lastResponse: {
            error: error.message,
            retryInMs: Math.max(0, failure.nextRetryAt - Date.now()),
            consecutiveFailures: failure.consecutiveFailures,
          },
        });
        this.stateManager.upsertDevice({
          ...device,
          status: "DISCONNECTED",
          lastSeen: device.lastSeen,
          lastResponse: {
            error: error.message,
            retryInMs: Math.max(0, failure.nextRetryAt - Date.now()),
            consecutiveFailures: failure.consecutiveFailures,
          },
        });
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

  async sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  notifyModbusConnectivityIssue(device, error) {
    const robotId = device.robotId;
    const type = device.type;
    const message = error?.message || String(error);
    const latest = this.getDevice(robotId, type) || device;
    this.deviceRegistry.updateStatus(robotId, type, "DISCONNECTED", {
      lastResponse: {
        error: message,
        connectivityRecovery: true,
      },
    });
    this.stateManager.upsertDevice({
      ...latest,
      status: "DISCONNECTED",
      lastSeen: latest.lastSeen,
      lastResponse: {
        error: message,
        connectivityRecovery: true,
      },
    });
  }

  /**
   * Ejecuta una operación Modbus reintentando ante errores de conectividad:
   * hasta 3 intentos con 2 s entre ellos, luego recrea el cliente y repite hasta éxito.
   */
  async runModbusOp(device, operation) {
    if (this.simulate) {
      throw new Error("runModbusOp no aplica en modo simulacion");
    }

    const innerAttempts = Number(process.env.MODBUS_CONNECTIVITY_INNER_ATTEMPTS || 3);
    const innerDelayMs = Number(process.env.MODBUS_CONNECTIVITY_INNER_DELAY_MS || 2000);

    while (true) {
      for (let i = 1; i <= innerAttempts; i += 1) {
        const client = await this.getClient(device);
        try {
          await client.ensureConnected();
          const result = await operation(client);
          this.clearRecoveryState(device.robotId, device.type);
          return result;
        } catch (error) {
          if (!isConnectivityError(error)) {
            throw error;
          }
          client.markDisconnected();
          this.notifyModbusConnectivityIssue(device, error);
          this.logger.warn?.("[connection] modbus connectivity error, retrying", {
            robotId: device.robotId,
            type: device.type,
            attempt: i,
            innerAttempts,
            message: error.message,
          });
          if (i < innerAttempts) {
            await this.sleep(innerDelayMs);
          }
        }
      }

      const client = await this.getClient(device);
      client.markDisconnected();
      await this.recreateClient(device);
      this.logger.warn?.("[connection] modbus client recreated after connectivity errors", {
        robotId: device.robotId,
        type: device.type,
      });
    }
  }

  async writeResetMessageIn(device, deviceType, commandAddress) {
    await this.runModbusOp(device, async (client) => {
      if (String(deviceType).toUpperCase() === "CARRO") {
        await client.writeSingleRegister(commandAddress, 0);
        await client.writeSingleRegister(commandAddress + 1, 0);
        return;
      }

      await client.writeSingleRegister(commandAddress, 0);
    });
  }

  async waitForMessageOutZero(device, responseAddress) {
    const attempts = Number(process.env.STEP_RESET_MAX_ATTEMPTS || 60);
    const intervalMs = Number(process.env.STEP_RESET_INTERVAL_MS || 2500);
    let lastValue = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const values = await this.runModbusOp(device, (client) =>
        client.readInputRegisters(responseAddress, 1)
      );
      lastValue = values[0] ?? null;

      if (Number(lastValue) === 0) {
        return { ok: true, lastValue, attempts: attempt };
      }

      if (attempt < attempts) {
        await this.sleep(intervalMs);
      }
    }

    return { ok: false, lastValue, attempts };
  }

  async waitForExpectedResponse(device, responseAddress, expectedResponses = [100]) {
    const attempts = Number(process.env.STEP_ACK_MAX_ATTEMPTS || 60);
    const intervalMs = Number(process.env.STEP_ACK_INTERVAL_MS || 2000);
    let lastValue = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const values = await this.runModbusOp(device, (client) =>
        client.readInputRegisters(responseAddress, 1)
      );
      lastValue = values[0] ?? null;

      if (this.matchesExpectedResponse(lastValue, expectedResponses)) {
        return { ok: true, responseCode: lastValue, attempts: attempt };
      }

      if (attempt < attempts) {
        await this.sleep(intervalMs);
      }
    }

    return { ok: false, responseCode: lastValue, attempts };
  }

  async resetStepRegisters({ device, commandAddress, responseAddress, robotId, stepType }) {
    const result = {
      messageInReset: false,
      messageOutReset: false,
      lastMessageOut: null,
    };

    try {
      await this.writeResetMessageIn(device, device.type, commandAddress);
      result.messageInReset = true;
    } catch (error) {
      result.error = `No se pudo resetear messageIn: ${error.message}`;
      return result;
    }

    try {
      const outReset = await this.waitForMessageOutZero(device, responseAddress);
      result.messageOutReset = outReset.ok;
      result.lastMessageOut = outReset.lastValue;
    } catch (error) {
      result.error = `No se pudo verificar reset de messageOut: ${error.message}`;
      return result;
    }

    if (!result.messageOutReset) {
      this.logger.warn?.("[connection] step reset incomplete", {
        robotId,
        deviceType: device.type,
        step: stepType,
        messageInReset: result.messageInReset,
        messageOutReset: result.messageOutReset,
        lastMessageOut: result.lastMessageOut,
      });
    }

    return result;
  }

  async resetRobotMessageIn(robotId) {
    const devices = this.deviceRegistry.listByRobot(robotId) || [];
    const result = {
      robotId: String(robotId),
      attempted: devices.length,
      reset: 0,
      failures: [],
    };

    for (const device of devices) {
      try {
        if (!this.simulate) {
          const commandAddress = this.resolveRegister(device, "messageIn");
          await this.writeResetMessageIn(device, device.type, commandAddress);
        }

        result.reset += 1;
      } catch (error) {
        result.failures.push({
          type: device.type,
          error: error.message,
        });
      }
    }

    if (result.failures.length > 0) {
      const details = result.failures.map((failure) => `${failure.type}: ${failure.error}`).join("; ");
      throw new Error(`No se pudo resetear messageIn para todos los dispositivos del robot ${robotId}. ${details}`);
    }

    return result;
  }

  async executeStepCommand({ robotId, step, command }) {
    const device = this.getDevice(robotId, step.deviceType);
    if (!device) {
      const error = new Error(`No hay dispositivo ${step.deviceType} para robot ${robotId}`);
      error.fatal = true;
      throw error;
    }

    if (this.simulate) {
      this.logger.info?.("[connection] simulated step execution", {
        robotId,
        deviceType: step.deviceType,
        step: step.type,
        value: command?.value,
      });
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

    const commandAddress = this.resolveRegister(device, "messageIn", command.address);
    const responseAddress = this.resolveRegister(device, "messageOut", command.responseAddress);

    this.logger.info?.("[connection] sending plc command", {
      robotId,
      deviceType: device.type,
      step: step.type,
      commandValue: command.value,
      commandAddress,
      responseAddress,
    });

    await this.runModbusOp(device, async (client) => {
      if (String(device.type).toUpperCase() === "CARRO") {
        const { high, low } = this.splitCarroCommandValue(command.value);
        this.logger.info?.("[connection] carro split command", {
          robotId,
          high,
          low,
        });
        await client.writeSingleRegister(commandAddress, high);
        await client.writeSingleRegister(commandAddress + 1, low);
        return;
      }

      await client.writeSingleRegister(commandAddress, Number(command.value));
    });

    const ackResult = await this.waitForExpectedResponse(
      device,
      responseAddress,
      command.expectedResponses || [100]
    );
    const responseCode = ackResult.responseCode;
    this.logger.info?.("[connection] plc response", {
      robotId,
      deviceType: device.type,
      step: step.type,
      responseCode,
      ackAttempts: ackResult.attempts,
    });

    const decoded = decodeResponse(responseCode);
    const responseOk = ackResult.ok;
    const stateOk = responseOk;

    let reset = null;
    if (stateOk) {
      reset = await this.resetStepRegisters({
        device,
        commandAddress,
        responseAddress,
        robotId,
        stepType: step.type,
      });

      if (!reset.messageInReset || !reset.messageOutReset) {
        const resetError = new Error(
          `Step confirmado pero reset incompleto (messageInReset=${reset.messageInReset}, messageOutReset=${reset.messageOutReset}, lastMessageOut=${reset.lastMessageOut})`
        );
        resetError.fatal = true;
        throw resetError;
      }
    }

    this.deviceRegistry.updateStatus(robotId, device.type, "CONNECTED", {
      lastCommand: command,
      lastResponse: { responseCode, decoded, stateOk, reset },
    });

    this.stateManager.upsertDevice({
      ...device,
      status: "CONNECTED",
      lastSeen: Date.now(),
      lastCommand: command,
      lastResponse: { responseCode, decoded, stateOk, reset },
    });

    return {
      ack: stateOk ? "DONE" : "ERROR",
      stateOk,
      raw: { responseCode, decoded, reset },
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

    const address = this.resolveRegister(device, variable);
    return this.runModbusOp(device, (client) => client.readHoldingRegisters(address, length));
  }

  async writeVariable({ robotId, type, variable, value }) {
    const device = this.getDevice(robotId, type);
    if (!device) {
      throw new Error(`No hay dispositivo ${type} para robot ${robotId}`);
    }

    if (this.simulate) {
      return { ok: true, simulated: true };
    }

    const address = this.resolveRegister(device, variable);
    await this.runModbusOp(device, async (client) => {
      await client.writeSingleRegister(address, Number(value));
    });
    return { ok: true };
  }

  async executeDirectCommand({ robotId, type, value, expectedResponses = [100] }) {
    const deviceType = String(type || "").trim().toUpperCase();
    return this.executeStepCommand({
      robotId,
      step: {
        type: "DIRECT",
        deviceType,
      },
      command: {
        commandCode: Number(value),
        value: Number(value),
        expectedResponses,
      },
    });
  }

  async readDeviceState({ robotId, type }) {
    const deviceType = String(type || "").trim().toUpperCase();
    const device = this.getDevice(robotId, deviceType);
    if (!device) {
      throw new Error(`No hay dispositivo ${deviceType} para robot ${robotId}`);
    }

    const registerMap = this.getRegisterMap(device);

    if (this.simulate) {
      return {
        robotId: String(robotId),
        type: deviceType,
        registerMap,
        values: {
          messageIn1: 0,
          messageIn2: deviceType === "CARRO" ? 0 : null,
          messageOut: 0,
        },
        lastResponse: device.lastResponse || null,
        simulated: true,
      };
    }

    const messageInAddress = this.resolveRegister(device, "messageIn");
    const messageOutAddress = this.resolveRegister(device, "messageOut");

    return this.runModbusOp(device, async (client) => {
      let messageIn1 = null;
      let messageIn2 = null;
      if (deviceType === "CARRO") {
        const values = await client.readHoldingRegisters(messageInAddress, 2);
        messageIn1 = values[0] ?? null;
        messageIn2 = values[1] ?? null;
      } else {
        const values = await client.readHoldingRegisters(messageInAddress, 1);
        messageIn1 = values[0] ?? null;
      }

      const outValues = await client.readInputRegisters(messageOutAddress, 1);
      const messageOut = outValues[0] ?? null;

      return {
        robotId: String(robotId),
        type: deviceType,
        registerMap,
        values: {
          messageIn1,
          messageIn2,
          messageOut,
        },
        decodedMessageOut: decodeResponse(messageOut),
        lastResponse: device.lastResponse || null,
        simulated: false,
      };
    });
  }
}

module.exports = {
  ConnectionService,
};
