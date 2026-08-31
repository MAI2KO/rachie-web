import { randomUUID } from "node:crypto";

const PROFILES = new Set(["wos", "kingshot"]);

export function createDiscordCommunitySetupService({
  gameProfile,
  repository,
  createId = randomUUID,
}) {
  if (!PROFILES.has(gameProfile) || repository.gameProfile !== gameProfile) {
    throw new TypeError("Community setup profile mismatch.");
  }

  return Object.freeze({
    async reconcile({ communityCode, guildId, guildName, alliance, actorId, dryRun }) {
      return repository.withTransaction(async (session) => {
        await session.lockCommunitySetup(communityCode, guildId);
        let community = await session.findCommunityByLocationCode(communityCode);
        const linked = await session.findCommunityForDiscordGuild(guildId);
        if (linked && (!community || linked.id !== community.id)) {
          return { error: "guild_conflict" };
        }
        if (community && community.status !== "active") {
          return { error: "community_inactive" };
        }
        let created = false;
        if (!community) {
          if (gameProfile !== "wos") return { error: "kingshot_defaults_unavailable" };
          if (dryRun) {
            return {
              community: { code: communityCode, displayName: guildName },
              status: "ready to create native community",
              bookingsOpen: false,
              created: true,
            };
          }
          const communityId = createId();
          const correlationId = createId();
          community = await session.createWosCommunityDefaults({
            id: communityId,
            locationCode: communityCode,
            displayName: guildName,
            actorId,
          });
          await session.insertCommunitySetupAudit({
            id: createId(),
            communityId,
            actorId,
            correlationId,
            afterData: {
              action: "native_community_created",
              communityCode,
              discordGuildId: guildId,
              allianceAbbreviation: alliance,
            },
          });
          created = true;
        }
        if (!community) throw new Error("community_creation_failed");

        if (!linked && !created) {
          const pending = await session.findPendingCommunityGuildLinkRequest(
            community.id, guildId,
          );
          if (dryRun) {
            return {
              community: { code: community.location_code, displayName: community.display_name },
              status: pending ? "alliance link approval pending" : "ready to request alliance link",
              linkStatus: pending ? "pending" : "requestable",
              bookingsOpen: Boolean(community.bookings_open),
              created: false,
            };
          }
          if (!pending) {
            const requestId = createId();
            const correlationId = createId();
            await session.insertCommunityGuildLinkRequest({
              id: requestId, communityId: community.id, discordGuildId: guildId,
              discordGuildName: guildName, alliance, actorId,
            });
            await session.insertCommunityGuildLinkRequestAudit({
              id: createId(), requestId, communityId: community.id, actorId, correlationId,
              afterData: { action: "alliance_guild_link_requested", discordGuildId: guildId,
                discordGuildName: guildName, allianceAbbreviation: alliance },
            });
          }
          return {
            community: { code: community.location_code, displayName: community.display_name },
            status: pending ? "alliance link approval pending" : "alliance link approval requested",
            linkStatus: "pending",
            bookingsOpen: Boolean(community.bookings_open),
            created: false,
          };
        }

        if (!dryRun) {
          const link = await session.linkDiscordGuild({
            discordGuildId: guildId,
            communityId: community.id,
            discordGuildName: guildName,
            actorId,
          });
          if (link.status === "conflict") return { error: "guild_conflict" };
        }
        return {
          community: {
            code: community.location_code,
            displayName: community.display_name,
          },
          status: dryRun
            ? linked ? "already linked" : "ready to link"
            : created ? "native community created and linked"
              : linked ? "linked and reconciled" : "linked",
          bookingsOpen: Boolean(community.bookings_open),
          created,
        };
      });
    },
  });
}
