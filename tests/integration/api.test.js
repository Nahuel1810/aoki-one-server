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
        locationCode: "10501",
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
