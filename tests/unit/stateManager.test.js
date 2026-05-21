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

test("reserveSlotForPut acepta slots LIBRE y OCUPADO, rechaza otros", () => {
  const state = new StateManager({
    pickSlots: ["3X02AE1", "3X02AE2", "3X02AE3"],
  });

  // Caso 1: slot LIBRE → reserva permitida con previousStatus FREE.
  const reservedFromFree = state.reserveSlotForPut("3X02AE1", "order-put-free");
  assert.ok(reservedFromFree);
  assert.equal(reservedFromFree.previousStatus, SLOT_STATUS.FREE);
  assert.equal(reservedFromFree.slot.status, SLOT_STATUS.RESERVED);
  assert.equal(reservedFromFree.slot.reservedByOrderId, "order-put-free");

  // Caso 2: slot OCUPADO → reserva permitida, previousStatus OCCUPIED y currentBox preservado.
  state.markSlotOccupied("3X02AE2", "order-pick", {
    sourceLocationCode: "3X05AE3",
    pickOrderId: "order-pick",
  });
  const reservedFromOccupied = state.reserveSlotForPut("3X02AE2", "order-put-occ");
  assert.ok(reservedFromOccupied);
  assert.equal(reservedFromOccupied.previousStatus, SLOT_STATUS.OCCUPIED);
  assert.equal(reservedFromOccupied.slot.status, SLOT_STATUS.RESERVED);
  assert.equal(reservedFromOccupied.slot.reservedByOrderId, "order-put-occ");
  assert.ok(reservedFromOccupied.slot.currentBox);
  assert.equal(reservedFromOccupied.slot.currentBox.sourceLocationCode, "3X05AE3");

  // Caso 3: slot ya RESERVADO → rechazo.
  const doubleReserve = state.reserveSlotForPut("3X02AE1", "order-put-other");
  assert.equal(doubleReserve, null);

  // Caso 4: slot BLOQUEADO → rechazo.
  state.blockSlot("3X02AE3", "fallo de prueba");
  const blockedReserve = state.reserveSlotForPut("3X02AE3", "order-put-blocked");
  assert.equal(blockedReserve, null);

  // Caso 5: slot inexistente → rechazo.
  const missing = state.reserveSlotForPut("9X99AE9", "order-put-missing");
  assert.equal(missing, null);
});
