export const MINISTER_SERVICE_CODES = Object.freeze([
  "construction",
  "research",
  "troop",
]);

const ministerServiceCodeSet = new Set(MINISTER_SERVICE_CODES);

export function isKnownMinisterServiceCode(value) {
  return typeof value === "string" && ministerServiceCodeSet.has(value);
}
