const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../../src/app");
const {
  InMemoryEventStore,
  InMemorySnapshotStore,
  createFakeConnectionService,
} = require("../helpers/fakes");

function toUrl(server, path) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}${path}`;
}

test("Se puede inyectar ConnectionService fake sin tocar orquestador", async () => {
  const fakeConnection = createFakeConnectionService({ simulate: true });
  const { services } = createApp({
    connectionService: fakeConnection,
    eventStore: new InMemoryEventStore(),
    snapshotStore: new InMemorySnapshotStore(),
  });

  assert.equal(services.connectionService, fakeConnection);

  const order = services.orchestrator.submitOrder({
    type: "PICK",
    robotId: "9",
    locationCode: "9X04A3",
  });

  const result = await services.orchestrator.executeStepWithRetry(order, order.steps[0]);
  assert.equal(result.ok, true);
  assert.equal(fakeConnection.calls.length, 1);
});

test("Se puede levantar app sin API (componente desconectable)", async () => {
  const { app } = createApp({
    enableApi: false,
    eventStore: new InMemoryEventStore(),
    snapshotStore: new InMemorySnapshotStore(),
  });

  const server = app.listen(0);

  try {
    const healthRes = await fetch(toUrl(server, "/health"));
    assert.equal(healthRes.status, 200);

    const ordersRes = await fetch(toUrl(server, "/api/orders"));
    assert.equal(ordersRes.status, 404);
  } finally {
    server.close();
  }
});
