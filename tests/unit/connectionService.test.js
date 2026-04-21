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
    { address: 0, value: 0 },
    { address: 1, value: 0 },
    { address: 0, value: 4 },
    { address: 1, value: 1000 },
    { address: 0, value: 0 },
    { address: 1, value: 0 },
  ]);
});

test("ConnectionService espera OUT!=0 antes de resetear en ELEVADOR", async () => {
  const service = createServiceWithDevice({ type: "ELEVADOR" });

  const writes = [];
  const readSequence = [0, 0, 100, 0];
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
    { address: 0, value: 0 },
    { address: 0, value: 107 },
    { address: 0, value: 0 },
  ]);
});

test("ConnectionService resetea messageIn aunque OUT sea error", async () => {
  const service = createServiceWithDevice({ type: "ELEVADOR" });

  const writes = [];
  const readSequence = [0, 199, 0];
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

  assert.equal(response.ack, "ERROR");
  assert.equal(response.stateOk, false);
  assert.equal(response.raw.responseCode, 199);
  assert.equal(response.raw.reset.messageInReset, true);
  assert.equal(response.raw.reset.messageOutReset, true);

  assert.deepEqual(writes, [
    { address: 0, value: 0 },
    { address: 0, value: 107 },
    { address: 0, value: 0 },
  ]);
});

test("ConnectionService hace rollback a 0/0 si falla escritura parcial de CARRO", async () => {
  const service = createServiceWithDevice({ type: "CARRO" });

  const writes = [];
  const client = {
    async writeSingleRegister(address, value) {
      writes.push({ address, value });
      if (address === 1 && value === 1000) {
        throw new Error("fallo segunda palabra carro");
      }
    },
    async readHoldingRegisters() {
      return [0, 0];
    },
    async readInputRegisters() {
      return [0];
    },
  };

  service.getClient = async () => client;

  await assert.rejects(
    () =>
      service.executeStepCommand({
        robotId: "1",
        step: { type: "HOMING", deviceType: "CARRO" },
        command: { value: 41000, expectedResponses: [100] },
      }),
    /No se pudo escribir comando CARRO completo/
  );

  assert.deepEqual(writes, [
    { address: 0, value: 0 },
    { address: 1, value: 0 },
    { address: 0, value: 4 },
    { address: 1, value: 1000 },
    { address: 0, value: 0 },
    { address: 1, value: 0 },
  ]);
});

test("ConnectionService no falla si timeout en reset pero messageIn ya quedo en 0", async () => {
  const service = createServiceWithDevice({ type: "ELEVADOR" });

  const writes = [];
  const readInputSequence = [100, 0];
  let timeoutInjected = false;

  const client = {
    async writeSingleRegister(address, value) {
      writes.push({ address, value });

      if (!timeoutInjected && value === 0) {
        timeoutInjected = true;
        const timeoutError = new Error("operation timed out");
        timeoutError.code = "ETIMEDOUT";
        throw timeoutError;
      }
    },
    async readHoldingRegisters() {
      return [0];
    },
    async readInputRegisters() {
      const value = readInputSequence.length > 0 ? readInputSequence.shift() : 0;
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
  assert.equal(timeoutInjected, true);
});

test("ConnectionService auto-resetea IN cuando lee OUT=100 en estado de CARRO", async () => {
  const service = createServiceWithDevice({ type: "CARRO" });

  const writes = [];
  let readHoldingCall = 0;
  const client = {
    async writeSingleRegister(address, value) {
      writes.push({ address, value });
    },
    async readHoldingRegisters(address, length) {
      readHoldingCall += 1;
      if (address === 0 && length === 2) {
        if (readHoldingCall === 1) {
          return [1, 211];
        }

        return [0, 0];
      }

      return [0, 0];
    },
    async readInputRegisters() {
      return [100];
    },
  };

  service.getClient = async () => client;

  const state = await service.readDeviceState({ robotId: "1", type: "CARRO" });

  assert.equal(state.values.messageOut, 100);
  assert.equal(state.values.messageIn1, 0);
  assert.equal(state.values.messageIn2, 0);
  assert.deepEqual(writes, [
    { address: 0, value: 0 },
    { address: 1, value: 0 },
  ]);
});
