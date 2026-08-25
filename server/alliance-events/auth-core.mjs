import { createHmac, randomUUID } from "node:crypto";

export function canonicalAllianceEventsRequest({ method, path, profile, timestamp, nonce }) {
  return ["v1", String(method).toUpperCase(), String(path), String(profile),
    String(timestamp), String(nonce)].join("\n");
}

export function signAllianceEventsRequest({ secret, ...request }) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new TypeError("Alliance-events integration secret must contain at least 32 characters.");
  }
  return `v1=${createHmac("sha256", secret)
    .update(canonicalAllianceEventsRequest(request), "utf8").digest("hex")}`;
}

export function allianceEventsRequestHeaders({ secret, profile, method, path,
  now = Date.now, createNonce = randomUUID }) {
  const timestamp = String(Math.floor(now() / 1000));
  const nonce = createNonce();
  return Object.freeze({
    "x-alliance-events-profile": profile,
    "x-alliance-events-timestamp": timestamp,
    "x-alliance-events-nonce": nonce,
    "x-alliance-events-signature": signAllianceEventsRequest({
      secret, method, path, profile, timestamp, nonce,
    }),
  });
}
