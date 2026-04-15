const test = require("node:test");
const assert = require("node:assert/strict");
const { StateManager } = require("../../src/core/state/StateManager");

test("StateManager crea y actualiza orden", () => {
  const state = new StateManager();
  const order = state.createOrder({
    type: "PICK",
    locationCode: "30501",
    targetLocation: "90001",
    robotId: "3",
    steps: [],
  });

  assert.equal(order.status, "PENDING");
  const updated = state.updateOrder(order.id, { status: "IN_PROGRESS" });
  assert.equal(updated.status, "IN_PROGRESS");
});

test("StateManager registra comandos y errores", () => {
  const state = new StateManager();
  const command = state.addCommand({ orderId: "o1", stepId: 1, deviceId: "3:CARRO" });

  state.updateCommand(command.id, { status: "DONE" });
  state.addError({ entityType: "ORDER", entityId: "o1", message: "fallo" });

  const snapshot = state.getSnapshot();
  assert.equal(snapshot.commands.length, 1);
  assert.equal(snapshot.errors.length, 1);
  assert.equal(snapshot.commands[0].status, "DONE");
});
