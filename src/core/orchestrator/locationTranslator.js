const LEVEL_MIN = "A".charCodeAt(0);
const LEVEL_MAX = "L".charCodeAt(0);

function normalizeAction(action) {
  if (!action) {
    return null;
  }

  const normalized = String(action).trim().toUpperCase();
  if (normalized === "T") {
    return "T";
  }

  if (normalized === "D" || normalized === "L") {
    return "D";
  }

  return null;
}

function levelToNumber(levelLetter) {
  const code = String(levelLetter || "").toUpperCase().charCodeAt(0);
  if (!Number.isFinite(code) || code < LEVEL_MIN || code > LEVEL_MAX) {
    throw new Error("Nivel invalido. Debe ser entre A y L");
  }

  return code - LEVEL_MIN + 1;
}

function inferRobotIdFromEstanteria(estanteriaCode, options = {}) {
  const normalized = String(estanteriaCode || "").toUpperCase();
  const explicitMap = options.robotByEstanteria || {
    "3X": "1",
  };

  if (explicitMap[normalized]) {
    return String(explicitMap[normalized]);
  }

  // Si no hay mapeo explicito, usamos el identificador de estanteria
  // como robotId para permitir prefijos arbitrarios (ej: 3X, 3Y, RACKA1).
  return normalized || null;
}

function parseLocationCode(input, options = {}) {
  const value = String(input || "").trim().toUpperCase();
  const regex = /^([A-Z0-9]+)(\d{2})A([A-L])(\d)([TDL])?$/;
  const match = value.match(regex);

  if (!match) {
    throw new Error("Formato de ubicacion invalido. Esperado: ID04AA3, ID04AA3T o ID04AA3D");
  }

  const [, estanteriaCode, moduleCode, levelLetter, positionText, actionRaw] = match;
  const moduleNumber = Number(moduleCode);
  const position = Number(positionText);
  const sideBit = moduleNumber % 2 === 0 ? 0 : 1;
  const side = sideBit === 0 ? "RIGHT" : "LEFT";
  const levelNumber = levelToNumber(levelLetter);
  const action = normalizeAction(actionRaw || options.defaultAction || null);

  return {
    raw: value,
    baseCode: `${estanteriaCode}${moduleCode}A${levelLetter}${position}`,
    estanteriaCode,
    robotId: inferRobotIdFromEstanteria(estanteriaCode, options),
    moduleCode,
    moduleNumber,
    side,
    sideBit,
    levelLetter,
    levelNumber,
    position,
    action,
    actionBit: action === null ? null : action === "T" ? 1 : 0,
  };
}

function hasLocationActionSuffix(input) {
  return /[TDL]$/i.test(String(input || "").trim());
}

function toParanteCode(moduleNumber) {
  const numericModule = Number(moduleNumber);
  if (!Number.isFinite(numericModule) || numericModule <= 0) {
    throw new Error("Modulo invalido para comando carro");
  }

  return String(Math.ceil(numericModule / 2)).padStart(2, "0");
}

function toCarroCommand(location, actionOverride) {
  const parsed = typeof location === "string" ? parseLocationCode(location) : location;
  const action = normalizeAction(actionOverride || parsed.action);

  if (!action) {
    throw new Error("No se pudo determinar accion para comando carro. Usar T o D");
  }

  const actionBit = action === "T" ? 1 : 0;
  const moduleNumber = parsed.moduleNumber ?? Number(parsed.moduleCode);
  const paranteCode = toParanteCode(moduleNumber);
  const command = `${parsed.position}${paranteCode}${parsed.sideBit}${actionBit}`;

  return {
    command,
    commandCode: Number(command),
    action,
    actionBit,
  };
}

function toElevadorGoLevelCommand(location) {
  const parsed = typeof location === "string" ? parseLocationCode(location) : location;
  const commandCode = 100 + parsed.levelNumber;

  return {
    commandCode,
    levelNumber: parsed.levelNumber,
    levelLetter: parsed.levelLetter,
  };
}

module.exports = {
  parseLocationCode,
  hasLocationActionSuffix,
  inferRobotIdFromEstanteria,
  levelToNumber,
  toCarroCommand,
  toElevadorGoLevelCommand,
};
