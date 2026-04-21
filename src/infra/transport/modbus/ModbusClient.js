const ModbusRTU = require("modbus-serial");

class ModbusClient {
  constructor(options) {
    this.host = options.host;
    this.port = options.port || 502;
    this.unitId = options.unitId || 1;
    this.timeoutMs = options.timeoutMs || 2000;
    this.operationTimeoutMs = 15000;
    this.retryAttempts = options.retryAttempts || 3;
    this.retryBackoffMs = options.retryBackoffMs || 300;
    this.clientFactory = options.clientFactory || (() => new ModbusRTU());
    this.client = this.clientFactory();
    this.connected = false;
  }

  async sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  markDisconnected() {
    this.connected = false;
  }

  async recreateClient() {
    const previous = this.client;
    this.connected = false;

    if (previous?.close) {
      await new Promise((resolve) => {
        try {
          previous.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }

    this.client = this.clientFactory();
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
    if (!this.connected && !this.client?.close) {
      return;
    }

    await this.recreateClient();
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
        return await this.runWithOperationTimeout(async () => {
          await this.ensureConnected();
          return action();
        });
      } catch (error) {
        lastError = error;
        await this.recreateClient();

        if (attempt >= this.retryAttempts) {
          throw error;
        }

        await this.sleep(this.retryBackoffMs * attempt);
      }
    }

    throw lastError || new Error("Operacion Modbus fallo");
  }

  async runWithOperationTimeout(action) {
    let timeoutId = null;

    try {
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          const timeoutError = new Error(
            `Operacion Modbus excedio timeout de ${this.operationTimeoutMs}ms`
          );
          timeoutError.code = "MODBUS_OPERATION_TIMEOUT";
          reject(timeoutError);
        }, this.operationTimeoutMs);
      });

      return await Promise.race([action(), timeoutPromise]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
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
