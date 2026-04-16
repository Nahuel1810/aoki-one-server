const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../../src/app");
const { InMemoryEventStore, InMemorySnapshotStore } = require("../helpers/fakes");

function toUrl(server, path) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}${path}`;
}

test("API health responde en modo simulacion", async () => {
  const { app } = createApp({
    simulatePlc: true,
    eventStore: new InMemoryEventStore(),
    snapshotStore: new InMemorySnapshotStore(),
  });

  const server = app.listen(0);

  try {
    const res = await fetch(toUrl(server, "/health"));
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.mode, "simulation");
  } finally {
    server.close();
  }
});

test("API permite registrar dispositivo y crear orden", async () => {
  const { app } = createApp({
    simulatePlc: true,
    eventStore: new InMemoryEventStore(),
    snapshotStore: new InMemorySnapshotStore(),
  });

  const server = app.listen(0);

  try {
    const registerRes = await fetch(toUrl(server, "/api/devices/register"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        robotId: "1",
        type: "CARRO",
        host: "192.168.1.10",
        port: 502,
      }),
    });

    assert.equal(registerRes.status, 201);

    const orderRes = await fetch(toUrl(server, "/api/orders"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "PICK",
        robotId: "1",
        locationCode: "3X04AA3",
      }),
    });

    const orderData = await orderRes.json();
    assert.equal(orderRes.status, 202);
    assert.equal(orderData.ok, true);

    const listRes = await fetch(toUrl(server, "/api/orders"));
    const listData = await listRes.json();
    assert.equal(listData.ok, true);
    assert.ok(Array.isArray(listData.data));
    assert.equal(listData.data.length, 1);
  } finally {
    server.close();
  }
});

test("API simula traduccion de ubicacion sin crear orden", async () => {
  const { app } = createApp({
    simulatePlc: true,
    eventStore: new InMemoryEventStore(),
    snapshotStore: new InMemorySnapshotStore(),
  });

  const server = app.listen(0);

  try {
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
    assert.equal(simulateData.data.commandPreview.carroReturn.commandCode, 30200);
    assert.equal(simulateData.data.commandPreview.elevadorGoLevel.commandCode, 101);
    assert.equal(Array.isArray(simulateData.data.stepCommands), true);
    assert.equal(simulateData.data.stepCommands.length > 0, true);

    const listRes = await fetch(toUrl(server, "/api/orders"));
    const listData = await listRes.json();
    assert.equal(listRes.status, 200);
    assert.equal(listData.ok, true);
    assert.equal(Array.isArray(listData.data), true);
    assert.equal(listData.data.length, 0);
  } finally {
    server.close();
  }
});

test("API rechaza locationCode con accion final en alta de orden", async () => {
  const { app } = createApp({
    simulatePlc: true,
    eventStore: new InMemoryEventStore(),
    snapshotStore: new InMemorySnapshotStore(),
  });

  const server = app.listen(0);

  try {
    const orderRes = await fetch(toUrl(server, "/api/orders"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "PICK",
        locationCode: "3X04AA3T",
      }),
    });

    const orderData = await orderRes.json();
    assert.equal(orderRes.status, 400);
    assert.equal(orderData.ok, false);
    assert.match(orderData.error, /locationCode no debe incluir accion final/i);
  } finally {
    server.close();
  }
});
