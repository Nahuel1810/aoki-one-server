const { parseLocationCode } = require("../core/orchestrator/locationTranslator");

const DEFAULT_PICK_SLOTS = [
  "3X02AE1",
  "3X02AC1",
  "3X02AA1",

  "3X01AE1",
  "3X01AE2",
  "3X01AE3",

  "3X01AC1",
  "3X01AC2",
  "3X01AC3",

  "3X01AA1",
  "3X01AA2",
  "3X01AA3",
];

function normalizeUniqueSlots(locationCodes = []) {
  const unique = new Set();

  for (const code of locationCodes) {
    const parsed = parseLocationCode(code);
    unique.add(parsed.baseCode);
  }

  return [...unique];
}

function resolvePickSlotsConfig(options = {}) {
  if (Array.isArray(options.pickSlots) && options.pickSlots.length > 0) {
    return normalizeUniqueSlots(options.pickSlots);
  }

  const fromEnv = String(process.env.PICK_SLOTS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (fromEnv.length > 0) {
    return normalizeUniqueSlots(fromEnv);
  }

  return normalizeUniqueSlots(DEFAULT_PICK_SLOTS);
}

module.exports = {
  DEFAULT_PICK_SLOTS,
  resolvePickSlotsConfig,
};
