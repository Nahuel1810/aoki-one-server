const ModbusRTU = require("modbus-serial");

class ModbusClient {
  constructor(options) {
    this.host = options.host;
    this.port = options.port || 502;
    this.unitId = options.unitId || 255;
    this.timeoutMs = options.timeoutMs || 2000;
    this.client = new ModbusRTU();
    this.connected = false;
    this.logger = options.logger || null;
    this.connectionLabel = options.label || `${this.host}:${this.port}`;
    /** Marca de tiempo tras connectTCP exitoso (para duración de sesión hasta close). */
    this.tcpConnectedAt = null;
  }

  markDisconnected() {
    if (this.connected) {
      this.logger?.info?.("[modbus] marcado desconectado (bandera; puede seguir TCP hasta disconnect)", {
        label: this.connectionLabel,
        host: this.host,
        port: this.port,
      });
    }
    this.connected = false;
  }

  async connect() {
    if (this.connected) {
      return;
    }

    const t0 = Date.now();
    try {
      await this.client.connectTCP(this.host, { port: this.port });
      const handshakeMs = Date.now() - t0;
      this.client.setID(this.unitId);
      this.client.setTimeout(this.timeoutMs);
      this.connected = true;
      this.tcpConnectedAt = Date.now();
      this.logger?.info?.("[modbus] tcp conectado", {
        label: this.connectionLabel,
        host: this.host,
        port: this.port,
        unitId: this.unitId,
        handshakeMs,
      });
    } catch (error) {
      this.logger?.warn?.("[modbus] tcp connect fallo", {
        label: this.connectionLabel,
        host: this.host,
        port: this.port,
        handshakeMs: Date.now() - t0,
        error: error.message,
      });
      throw error;
    }
  }

  async disconnect() {
    if (this.tcpConnectedAt == null && !this.connected) {
      return;
    }

    const sessionMs = this.tcpConnectedAt != null ? Date.now() - this.tcpConnectedAt : null;
    try {
      this.client.close(() => {});
    } catch (error) {
      this.logger?.warn?.("[modbus] error al cerrar socket", {
        label: this.connectionLabel,
        error: error.message,
      });
    }
    this.connected = false;
    this.tcpConnectedAt = null;
    this.logger?.info?.("[modbus] tcp desconectado", {
      label: this.connectionLabel,
      host: this.host,
      port: this.port,
      sessionDurationMs: sessionMs,
    });
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
