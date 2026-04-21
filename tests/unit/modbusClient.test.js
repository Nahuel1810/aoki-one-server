const test = require("node:test");
const assert = require("node:assert/strict");
const { ModbusClient } = require("../../src/infra/transport/modbus/ModbusClient");

function createUnderlyingClient({ failWrite = false }) {
  return {
    async connectTCP() {},
    setID() {},
    setTimeout() {},
    close(callback) {
      if (typeof callback === "function") {
        callback();
      }
    },
    async writeRegister() {
      if (failWrite) {
        throw new Error("write failed");
      }
    },
    async readHoldingRegisters() {
      return { data: [123] };
    },
    async readInputRegisters() {
      return { data: [100] };
    },
  };
}

test("ModbusClient recrea cliente interno y reintenta tras fallo", async () => {
  let creations = 0;
  const clientFactory = () => {
    creations += 1;
    if (creations === 1) {
      return createUnderlyingClient({ failWrite: true });
    }

    return createUnderlyingClient({ failWrite: false });
  };

  const client = new ModbusClient({
    host: "127.0.0.1",
    port: 502,
    unitId: 1,
    retryAttempts: 2,
    retryBackoffMs: 0,
    clientFactory,
  });

  await client.writeSingleRegister(0, 107);

  assert.equal(creations, 2);
});

test("ModbusClient recrea cliente cuando una operacion se cuelga mas del timeout", async () => {
  let creations = 0;
  const clientFactory = () => {
    creations += 1;

    if (creations === 1) {
      return {
        async connectTCP() {},
        setID() {},
        setTimeout() {},
        close(callback) {
          if (typeof callback === "function") {
            callback();
          }
        },
        async writeRegister() {
          return new Promise(() => {});
        },
        async readHoldingRegisters() {
          return { data: [0] };
        },
        async readInputRegisters() {
          return { data: [0] };
        },
      };
    }

    return createUnderlyingClient({ failWrite: false });
  };

  const client = new ModbusClient({
    host: "127.0.0.1",
    port: 502,
    unitId: 1,
    retryAttempts: 2,
    retryBackoffMs: 0,
    operationTimeoutMs: 30,
    clientFactory,
  });

  await client.writeSingleRegister(0, 107);

  assert.equal(creations, 2);
});
