const { parseLocationCode } = require("./locationTranslator");

function isSlotAvailable(slot) {
  const status = String(slot?.status || "LIBRE").toUpperCase();
  return status === "LIBRE" || status === "AVAILABLE";
}

function toParsedSlot(slot) {
  if (!slot || !slot.locationCode) {
    throw new Error("Slot invalido: falta locationCode");
  }

  const parsed = parseLocationCode(slot.locationCode);
  return {
    ...slot,
    parsed,
    normalizedLocationCode: parsed.baseCode,
  };
}

function positionPreferenceRank(source, candidate) {
  return candidate.position - 1;
}

function comparePickSlotCandidates(sourceParsed, a, b) {
  const sameLevelA = a.parsed.levelNumber === sourceParsed.levelNumber ? 0 : 1;
  const sameLevelB = b.parsed.levelNumber === sourceParsed.levelNumber ? 0 : 1;
  if (sameLevelA !== sameLevelB) {
    return sameLevelA - sameLevelB;
  }

  const levelDistanceA = Math.abs(a.parsed.levelNumber - sourceParsed.levelNumber);
  const levelDistanceB = Math.abs(b.parsed.levelNumber - sourceParsed.levelNumber);
  if (levelDistanceA !== levelDistanceB) {
    return levelDistanceA - levelDistanceB;
  }

  const moduleDistanceA = Math.abs(a.parsed.moduleNumber - sourceParsed.moduleNumber);
  const moduleDistanceB = Math.abs(b.parsed.moduleNumber - sourceParsed.moduleNumber);
  if (moduleDistanceA !== moduleDistanceB) {
    return moduleDistanceA - moduleDistanceB;
  }

  if (a.parsed.moduleNumber !== b.parsed.moduleNumber) {
    return a.parsed.moduleNumber - b.parsed.moduleNumber;
  }

  const positionRankA = positionPreferenceRank(sourceParsed, a.parsed);
  const positionRankB = positionPreferenceRank(sourceParsed, b.parsed);
  if (positionRankA !== positionRankB) {
    return positionRankA - positionRankB;
  }

  return a.normalizedLocationCode.localeCompare(b.normalizedLocationCode);
}

function sortPickSlotsByDistance(sourceLocationCode, slots) {
  const sourceParsed =
    typeof sourceLocationCode === "string" ? parseLocationCode(sourceLocationCode) : sourceLocationCode;

  const candidates = (slots || [])
    .filter((slot) => isSlotAvailable(slot))
    .map((slot) => toParsedSlot(slot))
    .filter((slot) => slot.parsed.sideBit === sourceParsed.sideBit)
    .sort((a, b) => comparePickSlotCandidates(sourceParsed, a, b));

  return candidates.map((slot) => ({
    ...slot,
    locationCode: slot.normalizedLocationCode,
  }));
}

function selectNearestPickSlot(sourceLocationCode, slots) {
  const ranked = sortPickSlotsByDistance(sourceLocationCode, slots);
  return ranked.length > 0 ? ranked[0] : null;
}

module.exports = {
  selectNearestPickSlot,
  sortPickSlotsByDistance,
  comparePickSlotCandidates,
};
