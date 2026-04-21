const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout: sleep } = require("node:timers/promises");
const { createApp } = require("../../src/app");
const { InMemoryEventStore, InMemorySnapshotStore } = require("../helpers/fakes");

const FAST_PLC_POLL_ENV = {
  STEP_ACK_MAX_ATTEMPTS: "3",
  STEP_ACK_INTERVAL_MS: "20",
  STEP_RESET_MAX_ATTEMPTS: "3",
  STEP_RESET_INTERVAL_MS: "20",
};

function toUrl(server, path) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}${path}`;
}

async function waitForOrderStatus(server, orderId, expectedStatus, timeoutMs = 6000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const res = await fetch(toUrl(server, `/api/orders/${orderId}`));
    if (res.status === 200) {
      const data = await res.json();
      if (data?.data?.status === expectedStatus) {
        return data.data;
      }
    }

    await sleep(80);
  }

  throw new Error(`Timeout esperando estado ${expectedStatus} para order ${orderId}`);
}

async function withTemporaryEnv(values, action) {
  const previous = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    process.env[key] = values[key];
  }

  try {
    return await action();
  } finally {
    for (const key of Object.keys(values)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

async function getRobotState(server, robotId) {
  const res = await fetch(toUrl(server, "/api/devices/robots"));
  const body = await res.json();
  const robot = (body?.data || []).find((item) => String(item.id) === String(robotId));
  return robot || null;
}

async function registerDefaultDevices(server, robotId = "1") {
  const registerCarroRes = await fetch(toUrl(server, "/api/devices/register"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      robotId,
      type: "CARRO",
      host: "127.0.0.1",
      port: 502,
    }),
  });
  assert.equal(registerCarroRes.status, 201);

  const registerElevadorRes = await fetch(toUrl(server, "/api/devices/register"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      robotId,
      type: "ELEVADOR",
      host: "127.0.0.1",
      port: 502,
    }),
  });
  assert.equal(registerElevadorRes.status, 201);
}

async function createPickOrder(server, locationCode = "3X04AA3") {
  const createOrderRes = await fetch(toUrl(server, "/api/orders"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "PICK",
      locationCode,
    }),
  });

  const createOrderData = await createOrderRes.json();
  assert.equal(createOrderRes.status, 202);
  assert.equal(createOrderData.ok, true);
  return createOrderData.data;
}

class FakeModbusPlcClient {
  constructor({
    deviceType,
    messageInAddress = 0,
    messageOutAddress = 0,
    responseLagReads = 1,
    behavior = {},
  }) {
    this.deviceType = String(deviceType).toUpperCase();
    this.messageInAddress = Number(messageInAddress);
    this.messageOutAddress = Number(messageOutAddress);
    this.responseLagReads = Number(responseLagReads);
    this.behavior = behavior || {};

    this.connected = false;
    this.unitId = null;
    this.timeoutMs = null;
    this.registers = new Map();
    this.messageOut = 0;
    this.pendingResponseReads = 0;
    this.pendingResponseCode = null;

    this.writeHistory = [];
    this.readInputHistory = [];
    this.commandCount = 0;
    this.failOnceInjected = false;
  }

  async connect() {
    this.connected = true;
  }

  async ensureConnected() {
    if (!this.connected) {
      await this.connect();
    }
  }

  async disconnect() {
    this.connected = false;
  }

  async writeSingleRegister(address, value) {
    await this.writeRegister(address, value);
  }

  resolveResponseCode() {
    if (Array.isArray(this.behavior.commandResponseCodes)) {
      const fromSequence = this.behavior.commandResponseCodes.shift();
      if (fromSequence !== undefined) {
        return fromSequence;
      }
    }

    if (this.behavior.defaultResponseCode !== undefined) {
      return this.behavior.defaultResponseCode;
    }

    return 100;
  }

  maybeFailCommandWrite(address, value) {
    if (!this.behavior.failOnceOnFirstCommandWrite || this.failOnceInjected) {
      return;
    }

    this.failOnceInjected = true;
    const error = new Error(this.behavior.failOnceMessage || "socket hang up");
    error.code = this.behavior.failOnceCode || "ECONNRESET";
    error.address = Number(address);
    error.value = Number(value);
    throw error;
  }

  scheduleCommandResponse() {
    this.commandCount += 1;
    const responseCode = this.resolveResponseCode();
    if (responseCode === null || responseCode === undefined) {
      this.pendingResponseReads = 0;
      this.pendingResponseCode = null;
      return;
    }

    this.pendingResponseReads = Math.max(0, this.responseLagReads);
    this.pendingResponseCode = Number(responseCode);
  }

  scheduleSuccessResponse() {
    this.scheduleCommandResponse();
  }

  resetResponseState() {
    this.messageOut = 0;
    this.pendingResponseReads = 0;
    this.pendingResponseCode = null;
  }

  async writeRegister(address, value) {
    const normalizedAddress = Number(address);
    const normalizedValue = Number(value);
    this.registers.set(normalizedAddress, normalizedValue);
    this.writeHistory.push({ address: normalizedAddress, value: normalizedValue });

    if (this.deviceType === "CARRO") {
      if (
        normalizedAddress !== this.messageInAddress &&
        normalizedAddress !== this.messageInAddress + 1
      ) {
        return;
      }

      const in1 = Number(this.registers.get(this.messageInAddress) || 0);
      const in2 = Number(this.registers.get(this.messageInAddress + 1) || 0);

      if (in1 === 0 && in2 === 0) {
        this.resetResponseState();
        return;
      }

      if (in1 === 0 || in2 === 0) {
        return;
      }

      this.maybeFailCommandWrite(normalizedAddress, normalizedValue);

      this.scheduleSuccessResponse();
      return;
    }

    if (normalizedAddress !== this.messageInAddress) {
      return;
    }

    if (normalizedValue === 0) {
      this.resetResponseState();
      return;
    }

    this.maybeFailCommandWrite(normalizedAddress, normalizedValue);

    this.scheduleSuccessResponse();
  }

  async readInputRegisters(address, length) {
    const normalizedAddress = Number(address);
    const normalizedLength = Number(length);

    if (normalizedAddress === this.messageOutAddress && normalizedLength === 1) {
      if (this.pendingResponseReads > 0) {
        this.pendingResponseReads -= 1;
        this.readInputHistory.push(0);
        return [0];
      }

      if (this.pendingResponseCode !== null) {
        this.messageOut = this.pendingResponseCode;
        this.pendingResponseCode = null;
      }

      this.readInputHistory.push(this.messageOut);
      return [this.messageOut];
    }

    return new Array(Math.max(1, normalizedLength)).fill(0);
  }

  async readHoldingRegisters(address, length) {
    const normalizedAddress = Number(address);
    const normalizedLength = Number(length);
    const data = [];

    for (let offset = 0; offset < normalizedLength; offset += 1) {
      data.push(Number(this.registers.get(normalizedAddress + offset) || 0));
    }

    return data;
  }
}

async function setupModbusFakeE2E({ clientBehaviors = {}, orchestratorConfig = {} } = {}) {
  const eventStore = new InMemoryEventStore();
  const snapshotStore = new InMemorySnapshotStore();

  const { app, services } = createApp({
    simulatePlc: false,
    eventStore,
    snapshotStore,
    orchestratorConfig: {
      tickMs: 20,
      baseBackoffMs: 1,
      maxRetries: 2,
      commandAckTimeoutMs: 400,
      ...orchestratorConfig,
    },
  });

  const fakeClients = new Map();
  services.connectionService.getClient = async (device) => {
    const key = `${device.robotId}:${device.type}`;
    if (!fakeClients.has(key)) {
      const registerMap = device.registerMap || {};
      const behavior = clientBehaviors[String(device.type).toUpperCase()] || {};
      fakeClients.set(
        key,
        new FakeModbusPlcClient({
          deviceType: device.type,
          messageInAddress: Number(registerMap.messageIn ?? 0),
          messageOutAddress: Number(registerMap.messageOut ?? 0),
          responseLagReads: 1,
          behavior,
        })
      );
    }

    return fakeClients.get(key);
  };

  const server = app.listen(0);
  await services.orchestrator.start();

  return {
    server,
    services,
    eventStore,
    snapshotStore,
    fakeClients,
    async close() {
      await services.orchestrator.stop();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("E2E: maniobra completa con Modbus fake para CARRO y ELEVADOR", async () => {
  const ctx = await setupModbusFakeE2E();

  try {
    await registerDefaultDevices(ctx.server, "1");
    const createdOrder = await createPickOrder(ctx.server, "3X04AA3");

    const order = await waitForOrderStatus(ctx.server, createdOrder.id, "DONE", 7000);
    assert.equal(order.status, "DONE");

    const carro = ctx.fakeClients.get("1:CARRO");
    const elevador = ctx.fakeClients.get("1:ELEVADOR");
    assert.ok(carro);
    assert.ok(elevador);

    assert.equal(carro.connected, true);
    assert.equal(elevador.connected, true);

    const carroNonZeroWrites = carro.writeHistory
      .filter((write) => write.value !== 0)
      .map((write) => write.value);
    const elevadorNonZeroWrites = elevador.writeHistory
      .filter((write) => write.value !== 0)
      .map((write) => write.value);

    assert.deepEqual(carroNonZeroWrites, [4, 1000, 3, 201, 1, 100]);
    assert.deepEqual(elevadorNonZeroWrites, [101, 105]);

    const carroResetWrites = carro.writeHistory.filter((write) => write.value === 0);
    const elevadorResetWrites = elevador.writeHistory.filter((write) => write.value === 0);
    assert.equal(carroResetWrites.length > 0, true);
    assert.equal(elevadorResetWrites.length > 0, true);

    assert.equal(carro.readInputHistory.includes(100), true);
    assert.equal(elevador.readInputHistory.includes(100), true);

    const storedOrder = ctx.snapshotStore.last?.orders?.find((item) => item.id === order.id);
    assert.ok(storedOrder);
    assert.equal(storedOrder.status, "DONE");
  } finally {
    await ctx.close();
  }
});

test("E2E: timeout de MensajeOUT deja orden en ERROR", async () => {
  await withTemporaryEnv(FAST_PLC_POLL_ENV, async () => {
    const ctx = await setupModbusFakeE2E({
      orchestratorConfig: {
        maxRetries: 1,
      },
      clientBehaviors: {
        CARRO: { defaultResponseCode: null },
        ELEVADOR: { defaultResponseCode: null },
      },
    });

    try {
      await registerDefaultDevices(ctx.server, "1");
      const createdOrder = await createPickOrder(ctx.server, "3X04AA3");
      const order = await waitForOrderStatus(ctx.server, createdOrder.id, "ERROR", 5000);

      assert.equal(order.status, "ERROR");
      assert.equal(order.errorReason, "Estado PLC no coincide con lo esperado");

      const robot = await getRobotState(ctx.server, "1");
      assert.ok(robot);
      assert.equal(robot.status, "ERROR");
      assert.equal(robot.enabled, true);
    } finally {
      await ctx.close();
    }
  });
});

test("E2E: respuesta 199 pausa robot y frena cola", async () => {
  await withTemporaryEnv(FAST_PLC_POLL_ENV, async () => {
    const ctx = await setupModbusFakeE2E({
      orchestratorConfig: {
        maxRetries: 2,
      },
      clientBehaviors: {
        CARRO: { commandResponseCodes: [199] },
      },
    });

    try {
      await registerDefaultDevices(ctx.server, "1");
      const createdOrder = await createPickOrder(ctx.server, "3X04AA3");
      const order = await waitForOrderStatus(ctx.server, createdOrder.id, "ERROR", 5000);

      assert.equal(order.status, "ERROR");
      assert.equal(order.errorReason, "No logro recuperarse");

      const robot = await getRobotState(ctx.server, "1");
      assert.ok(robot);
      assert.equal(robot.status, "PAUSED");
      assert.equal(robot.enabled, false);
      assert.equal(robot.queue.activeOrderId, null);
    } finally {
      await ctx.close();
    }
  });
});

test("E2E: desconexion en escritura de step reintenta y recupera", async () => {
  await withTemporaryEnv(FAST_PLC_POLL_ENV, async () => {
    const ctx = await setupModbusFakeE2E({
      orchestratorConfig: {
        maxRetries: 2,
      },
      clientBehaviors: {
        CARRO: { failOnceOnFirstCommandWrite: true, defaultResponseCode: 100 },
      },
    });

    try {
      await registerDefaultDevices(ctx.server, "1");
      const createdOrder = await createPickOrder(ctx.server, "3X04AA3");
      const order = await waitForOrderStatus(ctx.server, createdOrder.id, "DONE", 7000);

      assert.equal(order.status, "DONE");

      const carro = ctx.fakeClients.get("1:CARRO");
      assert.ok(carro);
      assert.equal(carro.failOnceInjected, true);
      const homingWriteAttempts = carro.writeHistory.filter(
        (write) => write.address === 0 && write.value === 4
      ).length;
      assert.equal(homingWriteAttempts >= 2, true);
    } finally {
      await ctx.close();
    }
  });
});
