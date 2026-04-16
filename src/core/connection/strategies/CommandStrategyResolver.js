class CommandStrategyResolver {
  constructor(options = {}) {
    this.byProtocol = {
      ...(options.byProtocol || {}),
    };
    this.byType = {
      ...(options.byType || {}),
    };
    this.defaultStrategy = options.defaultStrategy;
  }

  resolve(device) {
    const normalizedProtocol = String(device?.protocol || "").trim().toLowerCase();
    const protocolStrategy = this.byProtocol[normalizedProtocol];
    if (protocolStrategy) {
      return { strategy: protocolStrategy, name: normalizedProtocol };
    }

    const typeKey = String(device?.type || "").trim().toUpperCase();
    const typeStrategy = this.byType[typeKey];
    if (typeStrategy) {
      return { strategy: typeStrategy, name: typeKey.toLowerCase() };
    }

    if (!this.defaultStrategy) {
      throw new Error("No hay estrategia de comando configurada por defecto");
    }

    return { strategy: this.defaultStrategy, name: "default" };
  }
}

module.exports = {
  CommandStrategyResolver,
};
