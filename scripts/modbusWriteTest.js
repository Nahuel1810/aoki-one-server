const { ModbusClient } = require("../src/infra/transport/modbus/ModbusClient");

process.on("uncaughtException", (error) => {
  console.error("UNCAUGHT_EXCEPTION", error?.stack || error?.message || error);
});

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED_REJECTION", reason?.stack || reason?.message || reason);
});

async function main() {
  const client = new ModbusClient({
    host: "192.168.0.50",
    port: 502,
    unitId: 255,
    timeoutMs: 2000,
    retryAttempts: 1,
    retryBackoffMs: 100,
  });

  try {
    console.log("STEP connect:start");
    await client.connect();
    console.log("STEP connect:ok");
    // 40001 in manual notation usually maps to address 0 (zero-based)
    console.log("STEP write:start address=0 value=104");
    console.log("STEP read:start address=2 length=3");
    const values = await client.readHoldingRegisters(0);
    console.log("READ_OK address=2 length=3 values=", values);
    values.forEach((value, index) => {
      console.log(`HOLDING_REGISTER address=${2 + index} value=${value}`);
    });
    console.log("WRITE_OK address=0 value=104");
  } catch (error) {
    console.error("WRITE_ERROR", error?.message || error);
    process.exitCode = 1;
  } finally {
    await client.disconnect();
  }
}

main();
