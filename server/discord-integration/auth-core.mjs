import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const PROFILES = new Set(["wos", "kingshot"]);
const SIGNATURE_PATTERN = /^v1=([0-9a-f]{64})$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
export const INTEGRATION_CLOCK_TOLERANCE_SECONDS = 300;

export class DiscordIntegrationAuthenticationError extends Error {
  constructor(code, message = "Discord integration authentication failed.") {
    super(message);
    this.name = "DiscordIntegrationAuthenticationError";
    this.code = code;
  }
}

export function discordIntegrationCanonicalRequest({ method, path, timestamp, nonce, body }) {
  return [
    "v1",
    String(method).toUpperCase(),
    String(path),
    String(timestamp),
    String(nonce),
    createHash("sha256").update(String(body), "utf8").digest("hex"),
  ].join("\n");
}

export function signDiscordIntegrationRequest({ secret, ...request }) {
  if (typeof secret !== "string" || secret.length < 32) throw new TypeError("Integration secret must contain at least 32 characters.");
  return `v1=${createHmac("sha256", secret).update(discordIntegrationCanonicalRequest(request), "utf8").digest("hex")}`;
}

export function verifyDiscordIntegrationRequest({
  profile, secret, method, path, timestamp, nonce, body, signature,
  now = () => new Date(), toleranceSeconds = INTEGRATION_CLOCK_TOLERANCE_SECONDS,
}) {
  if (!PROFILES.has(profile) || typeof secret !== "string" || secret.length < 32) {
    throw new DiscordIntegrationAuthenticationError("configuration");
  }
  if (!/^\d{10}$/.test(String(timestamp)) || !NONCE_PATTERN.test(String(nonce))) {
    throw new DiscordIntegrationAuthenticationError("invalid_headers");
  }
  const requestSeconds = Number(timestamp);
  const nowSeconds = Math.floor(now().getTime() / 1000);
  if (Math.abs(nowSeconds - requestSeconds) > toleranceSeconds) {
    throw new DiscordIntegrationAuthenticationError("stale_request");
  }
  const match = SIGNATURE_PATTERN.exec(String(signature));
  if (!match) throw new DiscordIntegrationAuthenticationError("invalid_signature");
  const expected = signDiscordIntegrationRequest({ secret, method, path, timestamp, nonce, body });
  const suppliedBuffer = Buffer.from(match[1], "hex");
  const expectedBuffer = Buffer.from(expected.slice(3), "hex");
  if (suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    throw new DiscordIntegrationAuthenticationError("invalid_signature");
  }
  return Object.freeze({ profile, nonce: String(nonce), expiresAt: new Date((requestSeconds + toleranceSeconds) * 1000) });
}
