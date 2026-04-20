const DEFAULT_DEVICE_REGISTER_MAPS = {
  CARRO: {
    messageIn: 0,
    messageOut: 0
  },
  ELEVADOR: {
    messageIn: 0,
    messageOut: 0,
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
