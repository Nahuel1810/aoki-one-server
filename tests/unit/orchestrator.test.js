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
    locationCode: "3X04AA3",
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
  const order = orchestrator.submitOrder({ type: "PICK", robotId: "2", locationCode: "4X04AA3" });

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
  const order = orchestrator.submitOrder({ type: "PICK", robotId: "3", locationCode: "5X04AA3" });

  const result = await orchestrator.executeStepWithRetry(order, order.steps[0]);
  assert.equal(result.ok, false);
  assert.equal(fakeConnection.calls.length, 3);
});

test("Orchestrator rehidrata snapshot y reencola ordenes pendientes", () => {
  const fakeConnection = createFakeConnectionService();
  const { orchestrator, queueManager, stateManager } = buildOrchestrator(fakeConnection);

  const snapshot = {
    orders: [
      {
        id: "o-pending",
        type: "PICK",
        status: "PENDING",
        robotId: "1",
        currentStepIndex: 0,
        steps: [{ id: 1, type: "HOMING", deviceType: "CARRO", status: "PENDING", retries: 0 }],
        history: [],
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "o-running",
        type: "PICK",
        status: "IN_PROGRESS",
        robotId: "1",
        currentStepIndex: 0,
        steps: [{ id: 1, type: "HOMING", deviceType: "CARRO", status: "IN_PROGRESS", retries: 0 }],
        history: [],
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: "o-done",
        type: "PICK",
        status: "DONE",
        robotId: "1",
        currentStepIndex: 1,
        steps: [{ id: 1, type: "HOMING", deviceType: "CARRO", status: "DONE", retries: 0 }],
        history: [],
        createdAt: 3,
        updatedAt: 3,
      },
    ],
    robots: [{ id: "1", status: "BUSY", currentOrderId: "o-running", enabled: true, updatedAt: 1 }],
    devices: [],
    commands: [],
    errors: [],
  };

  orchestrator.rehydrateFromSnapshot(snapshot);

  assert.equal(stateManager.getOrder("o-running").status, "PENDING");
  assert.equal(queueManager.dequeueNext("1"), "o-pending");
  assert.equal(queueManager.dequeueNext("1"), "o-running");
  assert.equal(queueManager.dequeueNext("1"), null);
});

test("Orchestrator asigna slot automaticamente en PICK", async () => {
  const fakeConnection = createFakeConnectionService();
  const { orchestrator, stateManager } = buildOrchestrator(fakeConnection);

  stateManager.configurePickSlots(["3X02AE3", "3X02AE2", "3X02AE1"]);
  const order = orchestrator.submitOrder({ type: "PICK", robotId: "1", locationCode: "3X04AE1" });

  stateManager.upsertRobot({ id: "1", status: "IDLE", enabled: true });
  orchestrator.queueManager.setActive("1", order.id);
  await orchestrator.processOrder("1", order.id);

  const updated = stateManager.getOrder(order.id);
  assert.equal(updated.slotLocationCode, "3X02AE1");
});

test("Orchestrator deja la orden en espera si no hay slots libres", async () => {
  const fakeConnection = createFakeConnectionService();
  const { orchestrator, stateManager, queueManager } = buildOrchestrator(fakeConnection);

  stateManager.configurePickSlots(["3X02AE1"]);
  stateManager.markSlotOccupied("3X02AE1", "existing", { sourceLocationCode: "3X04AE1" });

  const order = orchestrator.submitOrder({ type: "PICK", robotId: "1", locationCode: "3X04AE1" });
  stateManager.upsertRobot({ id: "1", status: "IDLE", enabled: true });
  queueManager.setActive("1", order.id);

  await orchestrator.processOrder("1", order.id);

  const updated = stateManager.getOrder(order.id);
  assert.equal(updated.status, "PENDING");
  assert.equal(updated.waitingForSlot, true);
  assert.equal(queueManager.isRobotBusy("1"), false);
});
