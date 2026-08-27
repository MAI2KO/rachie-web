import { createHmac } from "node:crypto";

import {
  guestShareTokenHint,
  hashGuestShareToken,
} from "../booking-approval/domain-core.mjs";

export function automaticWindowGuestToken(secret, profile, communityId, windowId) {
  if (typeof secret !== "string" || secret.length < 32) return null;
  return createHmac("sha256", secret)
    .update(`booking-window-guest:v1:${profile}:${communityId}:${windowId}`, "utf8")
    .digest("base64url");
}

export function automaticWindowGuestTokenRecord(secret, profile, communityId, windowId) {
  const token = automaticWindowGuestToken(secret, profile, communityId, windowId);
  return token ? Object.freeze({
    tokenHash: hashGuestShareToken(token),
    tokenHint: guestShareTokenHint(token),
  }) : null;
}
