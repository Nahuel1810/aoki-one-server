const test = require("node:test");
const assert = require("node:assert/strict");
const { ConnectionService } = require("../../src/core/connection/ConnectionService");

function createServiceWithDevice({ type }) {
  const device = {
    robotId: "1",
    type,
    host: "127.0.0.1",
    port: 502,
    unitId: 255,
    registerMap: {
      messageIn: 0,
      messageOut: 0,
    },
  };

  const deviceRegistry = {
    get(robotId, deviceType) {
      if (String(robotId) === "1" && String(deviceType).toUpperCase() === type) {
        return device;
      }

      return null;
    },
    updateStatus() {},
  };

  const stateManager = {
    upsertDevice() {},
  };

  const service = new ConnectionService({
    deviceRegistry,
    stateManager,
    logger: { info() {}, warn() {}, error() {} },
    simulate: false,
  });

  return service;
}

function createConnectionCheckService({ device, options = {} }) {
  const updates = [];
  const deviceRegistry = {
    listByRobot(robotId) {
      if (String(robotId) !== String(device.robotId)) {
        return [];
      }

      return [device];
    },
    get(robotId, deviceType) {
      if (
        String(robotId) === String(device.robotId) &&
        String(deviceType).toUpperCase() === String(device.type).toUpperCase()
      ) {
        return device;
      }

      return null;
    },
    updateStatus(robotId, type, status, extra = {}) {
      updates.push({ robotId, type, status, extra });
    },
  };

  const stateManager = {
    upsertDevice() {},
  };

  const service = new ConnectionService({
    deviceRegistry,
    stateManager,
    logger: { info() {}, warn() {}, error() {} },
    simulate: false,
    reconnectBackoffBaseMs: 5000,
    reconnectBackoffMaxMs: 30000,
    recreateClientAfterFailures: 5,
    ...options,
  });

  return { service, updates };
}

function createOverlapDetectingClient({ delayMs = 25 } = {}) {
  let active = 0;
  let maxActive = 0;
  const calls = [];

  async function guardedCall(name, payload = {}) {
    active += 1;
    maxActive = Math.max(maxActive, active);
    calls.push({ name, ...payload });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    active -= 1;
  }

  return {
    stats() {
      return { active, maxActive, calls: [...calls] };
    },
    async ensureConnected() {
      await guardedCall("ensureConnected");
    },
    markDisconnected() {},
    async writeSingleRegister(address, value) {
      await guardedCall("writeSingleRegister", { address, value });
    },
    async readHoldingRegisters(address, length = 1) {
      await guardedCall("readHoldingRegisters", { address, length });
      return new Array(length).fill(123);
    },
    async readInputRegisters(address, length = 1) {
      await guardedCall("readInputRegisters", { address, length });
      return new Array(length).fill(0);
    },
  };
}

test("ConnectionService resetea messageIn1 y messageIn2 para CARRO", async () => {
  const service = createServiceWithDevice({ type: "CARRO" });

  const writes = [];
  const readSequence = [100, 100, 0];
  const client = {
    async ensureConnected() {},
    markDisconnected() {},
    async writeSingleRegister(address, value) {
      writes.push({ address, value });
    },
    async readInputRegisters() {
      const value = readSequence.length > 0 ? readSequence.shift() : 0;
      return [value];
    },
  };

  service.getClient = async () => client;

  const response = await service.executeStepCommand({
    robotId: "1",
    step: { type: "HOMING", deviceType: "CARRO" },
    command: { value: 41000, expectedResponses: [100] },
  });

  assert.equal(response.ack, "DONE");

  assert.deepEqual(writes, [
    { address: 0, value: 4 },
    { address: 1, value: 1000 },
    { address: 0, value: 0 },
    { address: 1, value: 0 },
  ]);
});

test("ConnectionService espera OUT=100 antes de resetear en ELEVADOR", async () => {
  const service = createServiceWithDevice({ type: "ELEVADOR" });

  const writes = [];
  const readSequence = [0, 100, 100, 0];
  const client = {
    async ensureConnected() {},
    markDisconnected() {},
    async writeSingleRegister(address, value) {
      writes.push({ address, value });
    },
    async readInputRegisters() {
      const value = readSequence.length > 0 ? readSequence.shift() : 0;
      return [value];
    },
  };

  service.getClient = async () => client;

  const response = await service.executeStepCommand({
    robotId: "1",
    step: { type: "ELEVADOR", deviceType: "ELEVADOR" },
    command: { value: 107, expectedResponses: [100] },
  });

  assert.equal(response.ack, "DONE");
  assert.equal(response.raw.reset.messageInReset, true);
  assert.equal(response.raw.reset.messageOutReset, true);

  assert.deepEqual(writes, [
    { address: 0, value: 107 },
    { address: 0, value: 0 },
  ]);
});

test("ConnectionService aplica backoff y recrea cliente al quinto fallo", async () => {
  const device = {
    robotId: "1",
    type: "CARRO",
    host: "127.0.0.1",
    port: 502,
    unitId: 255,
    registerMap: {
      messageIn: 0,
      messageOut: 0,
    },
  };

  const { service } = createConnectionCheckService({ device });

  let ensureConnectedCalls = 0;
  service.getClient = async () => ({
    async ensureConnected() {
      ensureConnectedCalls += 1;
      throw new Error("ECONNREFUSED");
    },
  });

  let recreateCalls = 0;
  service.recreateClient = async () => {
    recreateCalls += 1;
  };

  await service.checkRobotConnections("1");
  assert.equal(ensureConnectedCalls, 1);

  await service.checkRobotConnections("1");
  assert.equal(ensureConnectedCalls, 1);

  const recovery = service.getRecoveryState("1", "CARRO");
  for (let attempt = 2; attempt <= 5; attempt += 1) {
    recovery.nextRetryAt = Date.now() - 1;
    await service.checkRobotConnections("1");
  }

  assert.equal(ensureConnectedCalls, 5);
  assert.equal(recreateCalls, 1);
  assert.equal(recovery.consecutiveFailures, 5);
});

test("hardResetModbusTransport desconecta todos los clientes y limpia maps", async () => {
  const service = createServiceWithDevice({ type: "CARRO" });
  service.modbusHardResetCooldownMs = 0;

  let disconnects = 0;
  service.clients.set("1:CARRO", {
    async disconnect() {
      disconnects += 1;
    },
  });
  service.clients.set("1:ELEVADOR", {
    async disconnect() {
      disconnects += 1;
    },
  });
  service.connectionRecovery.set("1:CARRO", { consecutiveFailures: 3, nextRetryAt: 1, lastError: "x" });
  service.modbusRecreateStreakByDevice.set("1:CARRO", 5);

  await service.hardResetModbusTransport({ reason: "test" });

  assert.equal(disconnects, 2);
  assert.equal(service.clients.size, 0);
  assert.equal(service.connectionRecovery.size, 0);
  assert.equal(service.modbusRecreateStreakByDevice.size, 0);
});

test("ConnectionService serializa llamadas concurrentes sobre el mismo cliente Modbus", async () => {
  const service = createServiceWithDevice({ type: "CARRO" });
  const client = createOverlapDetectingClient({ delayMs: 20 });
  service.getClient = async () => client;

  const concurrentOps = Array.from({ length: 10 }, () =>
    service.readVariable({
      robotId: "1",
      type: "CARRO",
      variable: "messageIn",
      length: 1,
    })
  );

  const results = await Promise.all(concurrentOps);
  const stats = client.stats();

  assert.equal(results.length, 10);
  assert.equal(stats.maxActive, 1);
});

test("checkRobotConnections omite monitor cuando orchestrator tiene prioridad", async () => {
  const device = {
    robotId: "1",
    type: "CARRO",
    host: "127.0.0.1",
    port: 502,
    unitId: 255,
    registerMap: { messageIn: 0, messageOut: 0 },
  };
  const { service } = createConnectionCheckService({
    device,
    options: {
      monitorPriorityResolver: () => true,
    },
  });

  let ensureConnectedCalls = 0;
  service.getClient = async () => ({
    async ensureConnected() {
      ensureConnectedCalls += 1;
    },
  });

  await service.checkRobotConnections("1");
  assert.equal(ensureConnectedCalls, 0);
});

test("checkRobotConnections omite ciclo si el lock del device ya esta ocupado", async () => {
  const device = {
    robotId: "1",
    type: "CARRO",
    host: "127.0.0.1",
    port: 502,
    unitId: 255,
    registerMap: { messageIn: 0, messageOut: 0 },
  };
  const { service } = createConnectionCheckService({ device });
  const key = service.deviceKey("1", "CARRO");

  let ensureConnectedCalls = 0;
  service.getClient = async () => ({
    async ensureConnected() {
      ensureConnectedCalls += 1;
    },
  });

  const blockingOp = service.deviceMutex.run(key, async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });

  await service.checkRobotConnections("1");
  await blockingOp;

  assert.equal(ensureConnectedCalls, 0);
});
