const test = require("node:test");
const assert = require("node:assert/strict");
const { isConnectivityError } = require("../../src/infra/transport/modbus/modbusConnectivity");

test("isConnectivityError detecta codigos de socket comunes", () => {
  assert.equal(isConnectivityError({ code: "ECONNREFUSED" }), true);
  assert.equal(isConnectivityError({ code: "ETIMEDOUT" }), true);
  assert.equal(isConnectivityError({ code: "ENOTFOUND" }), true);
  assert.equal(isConnectivityError({ message: "Port not open" }), true);
  assert.equal(isConnectivityError({ message: "TCP connection timed out" }), true);
});

test("isConnectivityError no clasifica errores de aplicacion genericos", () => {
  assert.equal(isConnectivityError({ message: "Comando de carro invalido" }), false);
  assert.equal(isConnectivityError({ message: "No hay dispositivo" }), false);
  assert.equal(isConnectivityError(null), false);
});
