const test = require("node:test");
const assert = require("node:assert/strict");
const { StateManager, SLOT_STATUS } = require("../../src/core/state/StateManager");

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

test("StateManager administra slots y los persiste en snapshot", () => {
  const state = new StateManager({
    pickSlots: ["3X02AE1", "3X02AE2"],
  });

  const firstReserve = state.reserveSlot("3X02AE1", "order-1");
  assert.ok(firstReserve);
  assert.equal(firstReserve.status, SLOT_STATUS.RESERVED);

  const secondReserve = state.reserveSlot("3X02AE1", "order-2");
  assert.equal(secondReserve, null);

  const occupied = state.markSlotOccupied("3X02AE1", "order-1", {
    sourceLocationCode: "3X04AE3",
    pickOrderId: "order-1",
  });

  assert.equal(occupied.status, SLOT_STATUS.OCCUPIED);
  assert.equal(occupied.currentBox.pickOrderId, "order-1");
  assert.equal(occupied.logicalPickStackDepth, 1);

  const found = state.findOccupiedPickSlotBySource("3X04AE3");
  assert.ok(found);
  assert.equal(found.locationCode, "3X02AE1");

  state.incrementLogicalPickStack("3X02AE1");
  assert.equal(state.getLogicalPickStackDepth("3X02AE1"), 2);
  state.decrementLogicalPickStack("3X02AE1");
  assert.equal(state.getLogicalPickStackDepth("3X02AE1"), 1);

  const reservedForPut = state.reserveOccupiedSlotForPut("3X02AE1", "order-put");
  assert.ok(reservedForPut);
  assert.equal(reservedForPut.status, SLOT_STATUS.RESERVED);

  const released = state.releaseSlot("3X02AE1");
  assert.equal(released.status, SLOT_STATUS.FREE);
  assert.equal(released.currentBox, null);

  const snapshot = state.getSnapshot();
  assert.equal(Array.isArray(snapshot.slots), true);
  assert.equal(snapshot.slots.length, 2);
});
