const CARRO = {
  COMMANDS: {
    INIT: 40000,
    PUENTE_DER: 50000,
    PUENTE_IZQ: 51000,
    EXECUTE_LIST: 90000,
  },
  SUCCESS: 100,
  ERROR_CODES: {
    1: "Carro trabado avanzando",
    2: "Carro trabado volviendo",
    6: "No hay cajon",
    7: "Problema con el puente",
    14: "Inicio con cajon cargado",
    16: "Bateria baja",
    17: "Obstaculo volviendo",
    18: "Obstaculo avanzando",
    99: "No logro recuperarse",
  },
};

const ELEVADOR = {
  COMMANDS: {
    QUERY_LEVEL: 200,
    QUERY_CAR_PRESENCE: 300,
    INIT: 400,
    EXECUTE_LIST: 900,
  },
  SUCCESS: 100,
  ERROR_CODES: {
    1: "Elev trabado subiendo",
    2: "Elev trabado bajando",
    3: "Nivel incorrecto",
    17: "Elev llego a limite inferior",
    18: "Elev llego a limite superior",
    55: "Ambas direcciones simultaneas",
    66: "Llego a Home sin ir a Home",
    99: "No logro recuperarse",
  },
};

function buildElevadorIrNivel(level) {
  const safe = Math.max(0, Math.min(99, Number(level) || 0));
  return 100 + safe;
}

function buildElevadorSetNivel(level) {
  const safe = Math.max(0, Math.min(99, Number(level) || 0));
  return 500 + safe;
}

function isErrorResponse(code) {
  return Number.isFinite(code) && code >= 101 && code <= 199;
}

function isLevelResponse(code) {
  return Number.isFinite(code) && code >= 200 && code <= 299;
}

function decodeResponse(code) {
  const normalized = Number(code);
  if (!Number.isFinite(normalized)) {
    return { kind: "UNKNOWN", ok: false };
  }

  if (normalized === 100) {
    return { kind: "OK", ok: true };
  }

  if (normalized === 300) {
    return { kind: "CAR_PRESENT", ok: true };
  }

  if (normalized === 301) {
    return { kind: "CAR_ABSENT", ok: true };
  }

  if (isLevelResponse(normalized)) {
    return { kind: "LEVEL", level: normalized - 200, ok: true };
  }

  if (isErrorResponse(normalized)) {
    const errorCode = normalized - 100;
    return {
      kind: "ERROR",
      errorCode,
      ok: false,
      message: CARRO.ERROR_CODES[errorCode] || ELEVADOR.ERROR_CODES[errorCode] || "Error PLC",
    };
  }

  return { kind: "UNKNOWN", ok: false };
}

module.exports = {
  CARRO,
  ELEVADOR,
  buildElevadorIrNivel,
  buildElevadorSetNivel,
  decodeResponse,
};
