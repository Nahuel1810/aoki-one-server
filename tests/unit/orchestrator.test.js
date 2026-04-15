const test = require("node:test");
const assert = require("node:assert/strict");
const { QueueManager } = require("../../src/core/queue/QueueManager");
const { StateManager } = require("../../src/core/state/StateManager");
const { ErrorHandler } = require("../../src/core/errors/ErrorHandler");
const { OrchestratorService } = require("../../src/core/orchestrator/OrchestratorService");
const {
  InMemoryEventStore,
  InMemorySnapshotStore,
  createFakeConnectionService,
} = require("../helpers/fakes");

function buildOrchestrator(connectionService, config = {}) {
  const queueManager = new QueueManager();
  const stateManager = new StateManager();
  const errorHandler = new ErrorHandler({ logger: { error() {} } });
  const eventStore = new InMemoryEventStore();
  const snapshotStore = new InMemorySnapshotStore();

  const orchestrator = new OrchestratorService({
    logger: { error() {} },
    queueManager,
    stateManager,
    connectionService,
    errorHandler,
    eventStore,
    snapshotStore,
    config: {
      maxRetries: 3,
      baseBackoffMs: 1,
      ...config,
    },
  });

  return { orchestrator, queueManager, stateManager, eventStore, snapshotStore };
}

test("Orchestrator acepta connection service fake (desacople)", async () => {
  const fakeConnection = createFakeConnectionService();
  const { orchestrator } = buildOrchestrator(fakeConnection);

  const order = orchestrator.submitOrder({
    type: "PICK",
    robotId: "1",
    locationCode: "10501",
  });

  const step = order.steps[0];
  const result = await orchestrator.executeStepWithRetry(order, step);

  assert.equal(result.ok, true);
  assert.equal(fakeConnection.calls.length, 1);
});

test("Orchestrator hace retry y luego completa", async () => {
  const transient = new Error("timeout");
  transient.fatal = false;

  const fakeConnection = createFakeConnectionService({
    plan: [transient, { ack: "DONE", stateOk: true, raw: { ok: true } }],
  });

  const { orchestrator } = buildOrchestrator(fakeConnection);
  const order = orchestrator.submitOrder({ type: "PICK", robotId: "2", locationCode: "20501" });

  const result = await orchestrator.executeStepWithRetry(order, order.steps[0]);
  assert.equal(result.ok, true);
  assert.equal(fakeConnection.calls.length, 2);
});

test("Orchestrator marca error cuando agota retries", async () => {
  const transient = new Error("timeout");
  transient.fatal = false;

  const fakeConnection = createFakeConnectionService({
    plan: [transient, transient, transient],
  });

  const { orchestrator } = buildOrchestrator(fakeConnection, { maxRetries: 3 });
  const order = orchestrator.submitOrder({ type: "PICK", robotId: "3", locationCode: "30501" });

  const result = await orchestrator.executeStepWithRetry(order, order.steps[0]);
  assert.equal(result.ok, false);
  assert.equal(fakeConnection.calls.length, 3);
});
