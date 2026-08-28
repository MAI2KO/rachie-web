import { randomUUID } from "node:crypto";

import {
  assertTrustedManagerContext,
  generateGuestShareToken,
  guestShareTokenHint,
  hashGuestShareToken,
} from "../booking-approval/domain-core.mjs";
import {
  bookingAdminModel,
  BookingAdminTopologyDeniedError,
  BookingAdminTopologyUnavailableError,
  BookingAdminValidationError,
  validateCycleScheduleTiming,
  validateBookingAdminChange,
} from "./domain-core.mjs";

export class BookingAdminUnavailableError extends Error {
  constructor(message = "Booking administration is unavailable.") {
    super(message);
    this.name = "BookingAdminUnavailableError";
    this.code = "booking_admin_unavailable";
  }
}

export function createBookingAdminService({
  gameProfile,
  communityId,
  managerContext,
  repository,
  createId = randomUUID,
  createGuestToken = generateGuestShareToken,
  verifyGuildOwner = async (input) => {
    void input;
    return { status: "unavailable" };
  },
  now = () => new Date(),
}) {
  if (repository.gameProfile !== gameProfile) throw new TypeError("Booking-admin repository profile mismatch.");
  const actor = assertTrustedManagerContext(managerContext, gameProfile, communityId);

  async function ownershipFor(snapshot) {
    const ownership = new Map();
    const active = (snapshot.guilds ?? []).filter((guild) => guild.link_status === "active");
    const stateGuild = active.find((guild) => guild.guild_kind === "state");
    const checks = await Promise.all(active.map(async (guild) => ({
      guild,
      result: await verifyGuildOwner({
        gameProfile,
        guildId: guild.discord_guild_id,
        discordUserId: actor.discordUserId,
      }),
    })));
    for (const { guild, result } of checks) {
      ownership.set(guild.discord_guild_id, result.status === "owner");
      if (stateGuild?.discord_guild_id === guild.discord_guild_id) {
        ownership.set("state", result.status === "owner");
      }
    }
    return ownership;
  }

  async function modelForSnapshot(snapshot) {
    return bookingAdminModel(gameProfile, snapshot, now(), await ownershipFor(snapshot));
  }

  async function read() {
    const snapshot = await repository.withTransaction(async (session) => {
      const snapshot = await session.readSnapshot(communityId);
      if (!snapshot) throw new BookingAdminUnavailableError();
      return snapshot;
    });
    return modelForSnapshot(snapshot);
  }

  async function update(rawChange) {
    const change = validateBookingAdminChange(rawChange);
    if (!["booking", "service", "requirement"].includes(change.section)) {
      throw new BookingAdminValidationError();
    }
    const snapshot = await repository.withTransaction(async (session) => {
      const community = await session.lockCommunity(communityId);
      if (!community || community.status !== "active") throw new BookingAdminUnavailableError();
      const beforeSnapshot = await session.readSnapshot(communityId, community);
      if (!beforeSnapshot) throw new BookingAdminUnavailableError();
      let previousEnabled;
      if (change.section === "booking") {
        previousEnabled = Boolean(community.bookings_open);
        await session.setBookingEnabled(communityId, change.enabled);
      } else if (change.section === "service") {
        previousEnabled = Boolean(beforeSnapshot.services.find(
          (service) => service.service_code === change.serviceCode,
        )?.enabled);
        await session.setServiceEnabled(communityId, change.serviceCode, change.enabled, actor.discordUserId);
      } else {
        previousEnabled = Boolean(beforeSnapshot.settings?.[
          `${change.serviceCode}_${change.requirementCode}_required`
        ]);
        await session.setRequirementEnabled(
          communityId, change.serviceCode, change.requirementCode, change.enabled,
        );
      }
      const correlationId = createId();
      await session.insertAudit({
        id: createId(), communityId, actorId: actor.discordUserId, correlationId,
        beforeData: { ...change, enabled: previousEnabled }, afterData: change,
      });
      const snapshot = await session.readSnapshot(communityId, {
        ...community,
        bookings_open: change.section === "booking" ? change.enabled : community.bookings_open,
      });
      if (!snapshot) throw new BookingAdminUnavailableError();
      return snapshot;
    });
    return modelForSnapshot(snapshot);
  }

  async function updateGuestLink(rawChange) {
    const change = validateBookingAdminChange(rawChange);
    if (change.section !== "guestLink") throw new BookingAdminUnavailableError();
    const result = await repository.withTransaction(async (session) => {
      const community = await session.lockCommunity(communityId);
      if (!community || community.status !== "active") throw new BookingAdminUnavailableError();
      const existing = await session.lockGuestLinks(communityId);
      const active = Boolean(existing && (!existing.expires_at || new Date(existing.expires_at) > now()));
      if (change.action === "generate" && active) {
        throw new BookingAdminValidationError(
          "active_link_exists", "An active guest link already exists. Rotate it instead.",
        );
      }
      if (["rotate", "revoke"].includes(change.action) && !active) {
        throw new BookingAdminValidationError(
          "no_active_link", "There is no active guest link to change.",
        );
      }
      if (existing) await session.revokeGuestLink(existing.id, actor.discordUserId);

      let token = null;
      let aggregateId = existing?.id ?? communityId;
      if (change.action !== "revoke") {
        token = createGuestToken();
        aggregateId = createId();
        await session.insertGuestLink({
          id: aggregateId, communityId, tokenHash: hashGuestShareToken(token),
          tokenHint: guestShareTokenHint(token), actorId: actor.discordUserId,
          rotatedFromLinkId: change.action === "rotate" ? existing.id : null,
        });
      }
      const correlationId = createId();
      await session.insertGuestLinkAudit({
        id: createId(), communityId, actorId: actor.discordUserId, correlationId,
        aggregateId, action: change.action,
        beforeData: { status: active ? "active" : "inactive" },
        afterData: { status: token ? "active" : "revoked" },
      });
      const snapshot = await session.readSnapshot(communityId, community);
      if (!snapshot) throw new BookingAdminUnavailableError();
      return { snapshot, guestLinkPath: token ? `/book/${token}` : null };
    });
    return Object.freeze({
      configuration: await modelForSnapshot(result.snapshot),
      guestLinkPath: result.guestLinkPath,
    });
  }

  async function unlinkAllianceGuild(rawChange) {
    const change = validateBookingAdminChange(rawChange);
    if (change.section !== "discordAccess") throw new BookingAdminUnavailableError();
    const initial = await repository.withTransaction((session) => session.readSnapshot(communityId));
    if (!initial) throw new BookingAdminUnavailableError();
    const target = initial.guilds.find((guild) => guild.discord_guild_id === change.guildId);
    if (!target || target.guild_kind !== "alliance") {
      throw new BookingAdminTopologyDeniedError("That alliance Discord is not linked to this community.");
    }
    const state = initial.guilds.find((guild) => guild.guild_kind === "state"
      && guild.link_status === "active");
    const [targetOwner, stateOwner] = await Promise.all([
      verifyGuildOwner({ gameProfile, guildId: target.discord_guild_id,
        discordUserId: actor.discordUserId }),
      state ? verifyGuildOwner({ gameProfile, guildId: state.discord_guild_id,
        discordUserId: actor.discordUserId }) : Promise.resolve({ status: "not_owner" }),
    ]);
    if (targetOwner.status !== "owner" && stateOwner.status !== "owner") {
      if (targetOwner.status === "unavailable" || stateOwner.status === "unavailable") {
        throw new BookingAdminTopologyUnavailableError();
      }
      throw new BookingAdminTopologyDeniedError();
    }
    const result = await repository.withTransaction(async (session) => {
      const topology = await session.lockDiscordTopology(communityId);
      const lockedTarget = topology.find((guild) => guild.discord_guild_id === change.guildId);
      if (!lockedTarget || lockedTarget.guild_kind !== "alliance") {
        throw new BookingAdminTopologyDeniedError("That alliance Discord is not linked to this community.");
      }
      const revoked = await session.revokeAllianceGuildAccess({
        communityId, guildId: change.guildId, actorId: actor.discordUserId,
      });
      if (revoked.changed) {
        const correlationId = createId();
        await session.insertGuildUnlinkAudit({
          id: createId(), communityId, actorId: actor.discordUserId, correlationId,
          beforeData: { guildId: change.guildId, guildName: lockedTarget.discord_guild_name,
            status: "active" },
          afterData: { guildId: change.guildId, status: "revoked",
            affectedGrantCount: revoked.affectedGrantCount },
        });
      }
      const snapshot = await session.readSnapshot(communityId);
      if (!snapshot) throw new BookingAdminUnavailableError();
      return { snapshot, ...revoked };
    });
    return Object.freeze({ configuration: await modelForSnapshot(result.snapshot),
      unlink: Object.freeze({ guildId: change.guildId, affectedGrantCount: result.affectedGrantCount,
        changed: result.changed }) });
  }

  async function updateCycleSchedule(rawChange) {
    const change = validateBookingAdminChange(rawChange);
    if (change.section !== "cycleSchedule" || gameProfile !== "wos") {
      throw new BookingAdminValidationError();
    }
    const before = await repository.withTransaction((session) => session.readSnapshot(communityId));
    if (!before) throw new BookingAdminUnavailableError();
    const existing = before.scheduleOverrides.find(
      (override) => Number(override.cycle_index) === change.cycleIndex,
    ) ?? null;
    const timing = validateCycleScheduleTiming(change, now(), existing);
    const result = await repository.withTransaction(async (session) => {
      const community = await session.lockCommunity(communityId);
      if (!community || community.status !== "active") throw new BookingAdminUnavailableError();
      let changed = false;
      if (change.action === "restore") {
        changed = Boolean(await session.removeCycleScheduleOverride(communityId, change.cycleIndex));
      } else {
        changed = !existing || new Date(existing.opens_at).toISOString() !== timing.opensAt
          || new Date(existing.closes_at).toISOString() !== timing.closesAt;
        await session.upsertCycleScheduleOverride({ communityId, cycleIndex: change.cycleIndex,
          opensAt: timing.opensAt, closesAt: timing.closesAt, actorId: actor.discordUserId });
      }
      if (changed) {
        const eventType = change.action === "restore" ? "booking_cycle_override_removed"
          : existing ? "booking_cycle_override_changed" : "booking_cycle_override_created";
        await session.insertCycleScheduleAudit({ id: createId(), communityId,
          actorId: actor.discordUserId, correlationId: createId(), eventType,
          beforeData: { cycleIndex: change.cycleIndex,
            opensAt: existing ? new Date(existing.opens_at).toISOString() : timing.defaults.opensAt,
            closesAt: existing ? new Date(existing.closes_at).toISOString() : timing.defaults.closesAt },
          afterData: { cycleIndex: change.cycleIndex, opensAt: timing.opensAt,
            closesAt: timing.closesAt, automatic: change.action === "restore" },
        });
      }
      const snapshot = await session.readSnapshot(communityId, community);
      if (!snapshot) throw new BookingAdminUnavailableError();
      return { snapshot, changed };
    });
    return Object.freeze({ configuration: await modelForSnapshot(result.snapshot), changed: result.changed });
  }

  return Object.freeze({ read, update, updateGuestLink, unlinkAllianceGuild, updateCycleSchedule });
}
