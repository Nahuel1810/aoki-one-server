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

test("API GET /api/orders/queue/status devuelve snapshot (no confunde con /:id)", async () => {
  const { app } = createApp({
    simulatePlc: true,
    eventStore: new InMemoryEventStore(),
    snapshotStore: new InMemorySnapshotStore(),
  });

  const server = app.listen(0);

  try {
    const res = await fetch(toUrl(server, "/api/orders/queue/status"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.data));
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

test("API /api/orders/pick deduplica por id numerico", async () => {
  const { app } = createApp({
    simulatePlc: true,
    eventStore: new InMemoryEventStore(),
    snapshotStore: new InMemorySnapshotStore(),
  });

  const server = app.listen(0);

  try {
    const firstRes = await fetch(toUrl(server, "/api/orders/pick"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: 2001,
        locationCode: "3X04AA3",
      }),
    });
    const firstData = await firstRes.json();

    assert.equal(firstRes.status, 202);
    assert.equal(firstData.ok, true);
    assert.equal(firstData.created, true);

    const secondRes = await fetch(toUrl(server, "/api/orders/pick"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: 2001,
        locationCode: "3X04AA3",
      }),
    });
    const secondData = await secondRes.json();

    assert.equal(secondRes.status, 200);
    assert.equal(secondData.ok, true);
    assert.equal(secondData.created, false);
    assert.equal(secondData.data.id, firstData.data.id);

    const listRes = await fetch(toUrl(server, "/api/orders"));
    const listData = await listRes.json();
    assert.equal(listRes.status, 200);
    assert.equal(listData.ok, true);
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

test("API expone estado de slots de pickeo", async () => {
  const { app } = createApp({
    simulatePlc: true,
    eventStore: new InMemoryEventStore(),
    snapshotStore: new InMemorySnapshotStore(),
    pickSlots: ["3X02AE1", "3X02AE2"],
  });

  const server = app.listen(0);

  try {
    const listRes = await fetch(toUrl(server, "/api/slots"));
    const listData = await listRes.json();

    assert.equal(listRes.status, 200);
    assert.equal(listData.ok, true);
    assert.equal(Array.isArray(listData.data), true);
    assert.equal(listData.data.length, 2);
    assert.equal(listData.data[0].status, "LIBRE");

    const releaseRes = await fetch(toUrl(server, "/api/slots/3X02AE1/release"), {
      method: "POST",
    });

    assert.equal(releaseRes.status, 200);
  } finally {
    server.close();
  }
});

test("API permite comando directo y lectura de estado por dispositivo", async () => {
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

    const commandRes = await fetch(toUrl(server, "/api/devices/1/carro/command"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        value: 10201,
      }),
    });
    const commandData = await commandRes.json();

    assert.equal(commandRes.status, 200);
    assert.equal(commandData.ok, true);
    assert.equal(commandData.data.response.ack, "DONE");

    const stateRes = await fetch(toUrl(server, "/api/devices/1/carro/state"));
    const stateData = await stateRes.json();

    assert.equal(stateRes.status, 200);
    assert.equal(stateData.ok, true);
    assert.equal(stateData.data.type, "CARRO");
    assert.equal(stateData.data.values.messageIn1, 0);
    assert.equal(stateData.data.values.messageIn2, 0);
    assert.equal(stateData.data.values.messageOut, 0);
    assert.equal(stateData.data.simulated, true);
  } finally {
    server.close();
  }
});
