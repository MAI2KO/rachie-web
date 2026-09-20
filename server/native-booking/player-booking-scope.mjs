export const PLAYER_BOOKING_SCOPES = Object.freeze({
  configuredActive: "configured_active",
  outsideBookingScope: "outside_booking_scope",
  inactiveCommunity: "inactive_community",
  staleMirrorRelationship: "stale_mirror_relationship",
  unknownOther: "unknown/other",
});

export function classifyPlayerBookingScope({ communityCode, community, activeMirrorCount }) {
  if (communityCode === null) return PLAYER_BOOKING_SCOPES.unknownOther;
  if (community?.status === "active") return PLAYER_BOOKING_SCOPES.configuredActive;
  if (community) return PLAYER_BOOKING_SCOPES.inactiveCommunity;
  if (Number(activeMirrorCount) > 0) return PLAYER_BOOKING_SCOPES.staleMirrorRelationship;
  return PLAYER_BOOKING_SCOPES.outsideBookingScope;
}
