const test = require("node:test");
const assert = require("node:assert/strict");
const { ConnectionService } = require("../../src/core/connection/ConnectionService");

function createServiceWithDevice({ type }) {
  const device = {
    robotId: "1",
    type,
    host: "127.0.0.1",
    port: 502,
    unitId: 1,
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

test("ConnectionService resetea messageIn1 y messageIn2 para CARRO", async () => {
  const service = createServiceWithDevice({ type: "CARRO" });

  const writes = [];
  const readSequence = [100, 100, 0];
  const client = {
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
    unitId: 1,
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
