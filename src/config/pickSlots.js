const { parseLocationCode } = require("../core/orchestrator/locationTranslator");

const DEFAULT_PICK_SLOTS = [
  "3X02AE1",
  "3X02AE2",
  "3X02AE3",
  "3X01AE1",
  "3X01AE2",
  "3X01AE3",
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
