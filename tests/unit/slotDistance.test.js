const test = require("node:test");
const assert = require("node:assert/strict");
const {
  selectNearestPickSlot,
  sortPickSlotsByDistance,
} = require("../../src/core/orchestrator/slotDistance");

test("no cruza de lado: ignora slots del lado opuesto", () => {
  const source = "3X04AE1"; // modulo 4 -> lado derecho
  const slots = [
    { id: "left-1", locationCode: "3X01AE1", status: "FREE" },
    { id: "right-1", locationCode: "3X02AE1", status: "FREE" },
  ];

  const best = selectNearestPickSlot(source, slots);

  assert.equal(best.id, "right-1");
  assert.equal(best.locationCode, "3X02AE1");
});

test("prioriza mismo nivel para evitar elevador", () => {
  const source = "3X04AE1"; // nivel E (5)
  const slots = [
    { id: "other-level", locationCode: "3X02AD3", status: "FREE" },
    { id: "same-level", locationCode: "3X02AE3", status: "FREE" },
  ];

  const best = selectNearestPickSlot(source, slots);

  assert.equal(best.id, "same-level");
  assert.equal(best.locationCode, "3X02AE3");
});

test("si no hay mismo nivel, minimiza distancia vertical y luego horizontal", () => {
  const source = "3X04AE2";
  const slots = [
    { id: "lvl-3-mod-2", locationCode: "3X02AC3", status: "FREE" }, // nivel diff 2
    { id: "lvl-4-mod-6", locationCode: "3X06AD1", status: "FREE" }, // nivel diff 1
    { id: "lvl-4-mod-2", locationCode: "3X02AD1", status: "FREE" }, // nivel diff 1, modulo mas cerca
  ];

  const best = selectNearestPickSlot(source, slots);

  assert.equal(best.id, "lvl-4-mod-2");
  assert.equal(best.locationCode, "3X02AD1");
});

test("prioriza posiciones 1 -> 2 -> 3", () => {
  const source = "3X04AE1";
  const slots = [
    { id: "pos-1", locationCode: "3X02AE1", status: "FREE" },
    { id: "pos-2", locationCode: "3X02AE2", status: "FREE" },
    { id: "pos-3", locationCode: "3X02AE3", status: "FREE" },
  ];

  const ranked = sortPickSlotsByDistance(source, slots);

  assert.deepEqual(
    ranked.map((slot) => slot.id),
    ["pos-1", "pos-2", "pos-3"],
  );
});

test("prioriza posiciones 1 -> 2 -> 3 para cualquier nivel", () => {
  const levels = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];

  for (const level of levels) {
    const source = `3X04A${level}2`;
    const slots = [
      { id: `${level}-pos-3`, locationCode: `3X02A${level}3`, status: "FREE" },
      { id: `${level}-pos-1`, locationCode: `3X02A${level}1`, status: "FREE" },
      { id: `${level}-pos-2`, locationCode: `3X02A${level}2`, status: "FREE" },
    ];

    const ranked = sortPickSlotsByDistance(source, slots);

    assert.deepEqual(
      ranked.map((slot) => slot.id),
      [`${level}-pos-1`, `${level}-pos-2`, `${level}-pos-3`],
    );
  }
});

test("solo considera slots libres", () => {
  const source = "3X04AE1";
  const slots = [
    { id: "occupied", locationCode: "3X02AE3", status: "OCCUPIED" },
    { id: "free", locationCode: "3X02AE2", status: "FREE" },
  ];

  const best = selectNearestPickSlot(source, slots);

  assert.equal(best.id, "free");
  assert.equal(best.locationCode, "3X02AE2");
});
