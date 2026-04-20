const ModbusRTU = require("modbus-serial");

class ModbusClient {
  constructor(options) {
    this.host = options.host;
    this.port = options.port || 502;
    this.unitId = options.unitId || 1;
    this.timeoutMs = options.timeoutMs || 2000;
    this.retryAttempts = options.retryAttempts || 3;
    this.retryBackoffMs = options.retryBackoffMs || 300;
    this.client = new ModbusRTU();
    this.connected = false;
  }

  async sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  markDisconnected() {
    this.connected = false;
  }

  async connect() {
    if (this.connected) {
      return;
    }

    await this.client.connectTCP(this.host, { port: this.port });
    this.client.setID(this.unitId);
    this.client.setTimeout(this.timeoutMs);
    this.connected = true;
  }

  async disconnect() {
    if (!this.connected) {
      return;
    }

    this.client.close(() => {});
    this.connected = false;
  }

  async ensureConnected() {
    if (this.connected) {
      return;
    }

    await this.connect();
  }

  async runWithRetry(action) {
    let lastError = null;

    for (let attempt = 1; attempt <= this.retryAttempts; attempt += 1) {
      try {
        await this.ensureConnected();
        return await action();
      } catch (error) {
        lastError = error;
        this.markDisconnected();

        if (attempt >= this.retryAttempts) {
          throw error;
        }

        await this.sleep(this.retryBackoffMs * attempt);
      }
    }

    throw lastError || new Error("Operacion Modbus fallo");
  }

  async writeSingleRegister(address, value) {
    await this.runWithRetry(async () => {
      await this.client.writeRegister(address, value);
    });
  }

  async readHoldingRegisters(address, length = 1) {
    return this.runWithRetry(async () => {
      const data = await this.client.readHoldingRegisters(address, length);
      return data?.data || [];
    });
  }

  async readInputRegisters(address, length = 1) {
    return this.runWithRetry(async () => {
      const data = await this.client.readInputRegisters(address, length);
      return data?.data || [];
    });
  }
}

module.exports = {
  ModbusClient,
};
