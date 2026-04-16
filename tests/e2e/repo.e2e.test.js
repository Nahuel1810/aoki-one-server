const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout: sleep } = require("node:timers/promises");
const { createApp } = require("../../src/app");
const { InMemoryEventStore, InMemorySnapshotStore } = require("../helpers/fakes");

function toUrl(server, path) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}${path}`;
}

async function waitForOrderStatus(server, orderId, expectedStatus, timeoutMs = 5000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const res = await fetch(toUrl(server, `/api/orders/${orderId}`));
    if (res.status === 200) {
      const data = await res.json();
      if (data?.data?.status === expectedStatus) {
        return data.data;
      }
    }

    await sleep(60);
  }

  throw new Error(`Timeout esperando estado ${expectedStatus} para order ${orderId}`);
}

test("E2E: flujo completo API + orquestador en simulacion", async () => {
  const eventStore = new InMemoryEventStore();
  const snapshotStore = new InMemorySnapshotStore();

  const { app, services } = createApp({
    simulatePlc: true,
    eventStore,
    snapshotStore,
    orchestratorConfig: {
      tickMs: 20,
      baseBackoffMs: 1,
      maxRetries: 2,
      commandAckTimeoutMs: 200,
    },
  });

  const server = app.listen(0);
  await services.orchestrator.start();

  try {
    const healthRes = await fetch(toUrl(server, "/health"));
    const healthData = await healthRes.json();
    assert.equal(healthRes.status, 200);
    assert.equal(healthData.ok, true);
    assert.equal(healthData.mode, "simulation");

    const registerCarroRes = await fetch(toUrl(server, "/api/devices/register"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        robotId: "1",
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
        robotId: "1",
        type: "ELEVADOR",
        host: "127.0.0.1",
        port: 502,
      }),
    });
    assert.equal(registerElevadorRes.status, 201);

    const simulateRes = await fetch(toUrl(server, "/api/orders/simulate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "PICK",
        locationCode: "3X04AA3",
      }),
    });
    const simulateData = await simulateRes.json();
    assert.equal(simulateRes.status, 200);
    assert.equal(simulateData.ok, true);
    assert.equal(simulateData.data.order.robotId, "1");
    assert.equal(simulateData.data.commandPreview.carroBring.commandCode, 30201);
    assert.equal(simulateData.data.commandPreview.elevadorGoLevel.commandCode, 101);

    const createOrderRes = await fetch(toUrl(server, "/api/orders"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "PICK",
        locationCode: "3X04AA3",
      }),
    });
    const createOrderData = await createOrderRes.json();
    assert.equal(createOrderRes.status, 202);
    assert.equal(createOrderData.ok, true);

    const createdOrderId = createOrderData.data.id;
    const finalOrder = await waitForOrderStatus(server, createdOrderId, "DONE", 6000);
    assert.equal(finalOrder.status, "DONE");
    assert.equal(finalOrder.currentStepIndex, 6);

    const robotsRes = await fetch(toUrl(server, "/api/devices/robots"));
    const robotsData = await robotsRes.json();
    assert.equal(robotsRes.status, 200);
    assert.equal(robotsData.ok, true);
    assert.equal(Array.isArray(robotsData.data), true);
    assert.equal(robotsData.data.length >= 1, true);

    const robot1 = robotsData.data.find((robot) => String(robot.id) === "1");
    assert.ok(robot1);
    assert.equal(robot1.status, "IDLE");
    assert.equal(robot1.queue.activeOrderId, null);

    assert.ok(eventStore.events.length > 0);
    assert.ok(snapshotStore.last);
    assert.ok(Array.isArray(snapshotStore.last.orders));
    assert.ok(Array.isArray(snapshotStore.last.slots));

    const occupiedSlot = snapshotStore.last.slots.find((slot) => slot.status === "OCCUPIED");
    assert.ok(occupiedSlot);
    assert.equal(occupiedSlot.locationCode, "3X02AE1");
  } finally {
    await services.orchestrator.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});
