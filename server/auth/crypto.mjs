import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export function createOpaqueToken() {
  return randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createCsrfToken(sessionToken, gameProfile, secret) {
  return createHmac("sha256", secret)
    .update(`${gameProfile}\0${sessionToken}`, "utf8")
    .digest("base64url");
}

export function safelyEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function verifyCsrfToken(
  suppliedToken,
  sessionToken,
  gameProfile,
  secret,
) {
  return safelyEqual(
    suppliedToken,
    createCsrfToken(sessionToken, gameProfile, secret),
  );
}
