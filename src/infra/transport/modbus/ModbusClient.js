const ModbusRTU = require("modbus-serial");

class ModbusClient {
  constructor(options) {
    this.host = options.host;
    this.port = options.port || 502;
    this.unitId = options.unitId || 255;
    this.timeoutMs = options.timeoutMs || 2000;
    this.client = new ModbusRTU();
    this.connected = false;
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

  async writeSingleRegister(address, value) {
    await this.ensureConnected();
    await this.client.writeRegister(address, value);
  }

  async readHoldingRegisters(address, length = 1) {
    await this.ensureConnected();
    const data = await this.client.readHoldingRegisters(address, length);
    return data?.data || [];
  }

  async readInputRegisters(address, length = 1) {
    await this.ensureConnected();
    const data = await this.client.readInputRegisters(address, length);
    return data?.data || [];
  }
}

module.exports = {
  ModbusClient,
};
