const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseLocationCode,
  toCarroCommand,
  toElevadorGoLevelCommand,
  inferRobotIdFromEstanteria,
} = require("../../src/core/orchestrator/locationTranslator");

test("parsea ubicacion con accion traer", () => {
  const parsed = parseLocationCode("3X04AA3T");

  assert.equal(parsed.robotId, "1");
  assert.equal(parsed.moduleCode, "04");
  assert.equal(parsed.sideBit, 0);
  assert.equal(parsed.levelNumber, 1);
  assert.equal(parsed.position, 3);
  assert.equal(parsed.action, "T");
  assert.equal(parsed.actionBit, 1);
});

test("parsea ubicacion con accion devolver", () => {
  const parsed = parseLocationCode("3X05AL1D");

  assert.equal(parsed.moduleCode, "05");
  assert.equal(parsed.sideBit, 1);
  assert.equal(parsed.levelNumber, 12);
  assert.equal(parsed.position, 1);
  assert.equal(parsed.action, "D");
  assert.equal(parsed.actionBit, 0);
});

test("construye comando de carro desde ubicacion", () => {
  const parsed = parseLocationCode("3X04AA3T");
  const cmd = toCarroCommand(parsed);

  assert.equal(cmd.command, "30401");
  assert.equal(cmd.commandCode, 30401);
});

test("permite override de accion para comando carro", () => {
  const parsed = parseLocationCode("3X04AA3");
  const bringCmd = toCarroCommand(parsed, "T");
  const returnCmd = toCarroCommand(parsed, "D");

  assert.equal(bringCmd.commandCode, 30401);
  assert.equal(returnCmd.commandCode, 30400);
});

test("construye comando elevador segun nivel", () => {
  const parsed = parseLocationCode("3X04AC3T");
  const cmd = toElevadorGoLevelCommand(parsed);

  assert.equal(cmd.levelNumber, 3);
  assert.equal(cmd.commandCode, 103);
});

test("mapeo de estanteria a robot configurable", () => {
  assert.equal(inferRobotIdFromEstanteria("3X"), "1");
  assert.equal(inferRobotIdFromEstanteria("4X"), "2");
  assert.equal(inferRobotIdFromEstanteria("8X", { robotByEstanteria: { "8X": "99" } }), "99");
});
