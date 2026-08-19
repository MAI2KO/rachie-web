export const REGISTRATION_LIMITS = Object.freeze({
  playerIdMaxLength: 20,
  inGameNameMaxLength: 30,
  allianceLength: 3,
  idempotencyKeyMinLength: 16,
  idempotencyKeyMaxLength: 128,
});

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;
const PLAYER_ID_PATTERN = /^\d+$/;
const ALLIANCE_PATTERN = /^[A-Z0-9]{3}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export class InvalidRegistrationError extends Error {
  constructor(fields) {
    super("Registration details are invalid.");
    this.name = "InvalidRegistrationError";
    this.fields = fields;
  }
}

export class InvalidIdempotencyKeyError extends Error {
  constructor() {
    super("A valid Idempotency-Key header is required.");
    this.name = "InvalidIdempotencyKeyError";
  }
}

function normalizedString(value) {
  return typeof value === "string" ? value.trim().normalize("NFC") : "";
}

export function validateRegistrationInput(input) {
  const fields = {};
  const playerId = normalizedString(input?.playerId);
  const inGameName = normalizedString(input?.inGameName);
  const alliance = normalizedString(input?.alliance).toUpperCase();

  if (
    !PLAYER_ID_PATTERN.test(playerId) ||
    playerId.length > REGISTRATION_LIMITS.playerIdMaxLength
  ) {
    fields.playerId = "Must contain 1 to 20 digits.";
  }
  if (
    !inGameName ||
    inGameName.length > REGISTRATION_LIMITS.inGameNameMaxLength ||
    CONTROL_CHARACTER_PATTERN.test(inGameName)
  ) {
    fields.inGameName = "Must contain 1 to 30 characters without control characters.";
  }
  if (!ALLIANCE_PATTERN.test(alliance)) {
    fields.alliance = "Must contain exactly three letters or digits.";
  }

  if (Object.keys(fields).length > 0) {
    throw new InvalidRegistrationError(fields);
  }
  return Object.freeze({ playerId, inGameName, alliance });
}

export function validateIdempotencyKey(value) {
  const key = typeof value === "string" ? value.trim() : "";
  if (
    key.length < REGISTRATION_LIMITS.idempotencyKeyMinLength ||
    key.length > REGISTRATION_LIMITS.idempotencyKeyMaxLength ||
    !IDEMPOTENCY_KEY_PATTERN.test(key)
  ) {
    throw new InvalidIdempotencyKeyError();
  }
  return key;
}
