const DEFAULT_DEVICE_REGISTER_MAPS = {
  CARRO: {
    messageIn: Number(process.env.CARRO_MESSAGE_IN_REGISTER ?? process.env.MODBUS_MESSAGE_IN_REGISTER ?? 0),
    messageOut: Number(process.env.CARRO_MESSAGE_OUT_REGISTER ?? process.env.MODBUS_MESSAGE_OUT_REGISTER ?? 1),
  },
  ELEVADOR: {
    messageIn: Number(process.env.ELEVADOR_MESSAGE_IN_REGISTER ?? process.env.MODBUS_MESSAGE_IN_REGISTER ?? 0),
    messageOut: Number(process.env.ELEVADOR_MESSAGE_OUT_REGISTER ?? process.env.MODBUS_MESSAGE_OUT_REGISTER ?? 1),
  },
};

function normalizeDeviceType(type) {
  return String(type || "").trim().toUpperCase();
}

function getDefaultRegisterMap(deviceType) {
  const type = normalizeDeviceType(deviceType);
  return {
    ...(DEFAULT_DEVICE_REGISTER_MAPS[type] || {}),
  };
}

function mergeRegisterMaps(deviceType, customMap = {}) {
  return {
    ...getDefaultRegisterMap(deviceType),
    ...(customMap || {}),
  };
}

module.exports = {
  DEFAULT_DEVICE_REGISTER_MAPS,
  getDefaultRegisterMap,
  mergeRegisterMaps,
};
