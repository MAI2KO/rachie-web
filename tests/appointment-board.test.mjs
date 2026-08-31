import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  managerAppointmentBoard,
  publicAppointmentBoard,
} from "../server/booking-approval/domain-core.mjs";
import {
  createCommunityManagerAuthorizer,
  ManagerAccessDeniedError,
  ManagerVerificationUnavailableError,
} from "../server/booking-board/manager-authorization-core.mjs";
import { createDiscordGuildManagerVerifier } from "../server/auth/discord-guild-membership-verifier-core.mjs";

const community = { id: "community-wos", location_code: "9999", display_name: "Test Server" };
const publicRows = [
  { service_code: "construction", service_label: "Construction", booking_date: "2030-08-21", display_time_label: "14:00", is_confirmed: false, has_active_hold: false },
  { service_code: "construction", service_label: "Construction", booking_date: "2030-08-21", display_time_label: "14:30", is_confirmed: false, has_active_hold: true },
  { service_code: "construction", service_label: "Construction", booking_date: "2030-08-21", display_time_label: "15:00", is_confirmed: true, has_active_hold: false, confirmed_alliance: "VIS", confirmed_player_name: "Visible Player" },
];

test("public board serializer exposes only the documented anonymous fields", () => {
  const board = publicAppointmentBoard(community, publicRows.map((row) => ({
    ...row,
    confirmed_player_id: "12345678",
    discord_user_id: "123456789012345678",
    pending_alliance: "SEC",
    pending_player_name: "Private Pending Player",
    requirements: [{ code: "speedups", value: 99 }],
    pending_request_id: "private-request",
  })));
  assert.deepEqual(board.community, { code: "9999", displayName: "Test Server" });
  assert.deepEqual(board.services[0].slots, [
    { time: "14:00", state: "available" },
    { time: "14:30", state: "pending" },
    { time: "15:00", state: "confirmed", playerAlliance: "VIS", playerName: "Visible Player" },
  ]);
  const serialized = JSON.stringify(board);
  assert.doesNotMatch(serialized, /12345678|123456789012345678|SEC|Private Pending Player|speedups|private-request|discord|requestId|bookingId/i);
  assert.match(serialized, /"playerAlliance":"VIS"/);
});

test("manager board serializer includes operational fields and bounded human-readable activity", () => {
  const board = managerAppointmentBoard(community, [{
    slot_id: "slot-1", service_code: "construction", service_label: "Construction",
    booking_date: "2030-08-21", display_time_label: "14:00",
    pending_request_id: "request-1", pending_player_name: "Guest Player",
    pending_player_id: "87654321", pending_alliance: "GST",
    pending_discord_user_id: "111111111111111111",
    pending_hold_expires_at: "2030-08-21T14:30:00Z",
    pending_requirements: [{ code: "speedups", label: "Speed-ups (days)", value: 12, unit: "days" }],
  }], [{
    action: "submitted", category: "approvals", player_name: "Guest Player",
    player_id: "87654321", actor_discord_user_id: null, actor_display_name: null,
    service_code: "construction", previous_state: null,
    resulting_state: "pending_approval", created_at: "2030-08-21T14:00:00Z",
  }], {
    gameProfile: "wos",
    currentDiscordUserId: "111111111111111111",
    settings: { construction_speedups_required: true },
  });
  assert.equal(board.services[0].slots[0].player.playerId, "87654321");
  assert.equal(board.services[0].slots[0].player.alliance, "GST");
  assert.equal(board.services[0].slots[0].player.isCurrentUser, true);
  assert.equal(board.services[0].slots[0].requirements[0].value, 12);
  assert.deepEqual(board.services[0].requirementColumns, [
    { code: "speedups", label: "Speed-ups (days)", unit: "days" },
  ]);
  assert.deepEqual(Object.keys(board.activity[0]).sort(), [
    "action", "actorDiscordUserId", "actorDisplayName", "category", "createdAt", "playerId",
    "playerName", "previousState", "resultingState", "serviceCode",
  ]);
  assert.equal(board.activity[0].playerId, "87654321");
});

test("manager requirement columns follow enabled, disabled, and service-specific configuration", () => {
  const rows = [
    { slot_id: "c", service_code: "construction", service_label: "Construction", booking_date: "2030-08-21", display_time_label: "10:00" },
    { slot_id: "r", service_code: "research", service_label: "Research", booking_date: "2030-08-22", display_time_label: "10:00" },
    { slot_id: "t", service_code: "troop", service_label: "Troop", booking_date: "2030-08-23", display_time_label: "10:00" },
  ];
  const board = managerAppointmentBoard(community, rows, [], {
    gameProfile: "wos",
    currentDiscordUserId: "manager",
    settings: {
      construction_fc_required: true,
      construction_rfc_required: false,
      construction_speedups_required: true,
      research_shards_required: false,
      research_speedups_required: true,
      troop_speedups_required: false,
    },
  });
  assert.deepEqual(board.services.map((service) => ({
    code: service.code,
    columns: service.requirementColumns.map((column) => column.code),
  })), [
    { code: "construction", columns: ["fc", "speedups"] },
    { code: "research", columns: ["speedups"] },
    { code: "troop", columns: [] },
  ]);
  assert.doesNotMatch(JSON.stringify(board.services[0].requirementColumns), /Refined Fire Crystals/);
  assert.doesNotMatch(JSON.stringify(board.services.flatMap((service) => service.requirementColumns)), /alliance/i);
  assert.equal(board.services[2].requirementColumns.length, 0);
});

test("alliance named YOU remains separate from current-user status", () => {
  const rows = [
    {
      slot_id: "not-current", service_code: "construction", service_label: "Construction",
      booking_date: "2030-08-21", display_time_label: "10:00", confirmed_booking_id: "booking-1",
      confirmed_player_name: "Alliance Member", confirmed_player_id: "1", confirmed_alliance: "YOU",
      confirmed_discord_user_id: "someone-else", confirmed_requirements: [],
    },
    {
      slot_id: "current", service_code: "construction", service_label: "Construction",
      booking_date: "2030-08-21", display_time_label: "10:30", confirmed_booking_id: "booking-2",
      confirmed_player_name: "Current Manager", confirmed_player_id: "2", confirmed_alliance: "ABC",
      confirmed_discord_user_id: "manager", confirmed_requirements: [],
    },
  ];
  const board = managerAppointmentBoard(community, rows, [], {
    gameProfile: "wos", currentDiscordUserId: "manager", settings: {},
  });
  assert.deepEqual(board.services[0].slots.map((slot) => ({
    alliance: slot.player.alliance, isCurrentUser: slot.player.isCurrentUser,
  })), [
    { alliance: "YOU", isCurrentUser: false },
    { alliance: "ABC", isCurrentUser: true },
  ]);
});

function repositoryFor({ target = community, guilds = [] } = {}) {
  return {
    gameProfile: "wos",
    withTransaction(work) {
      return work({
        findActiveCommunityByLocationCode: async (code) => code === "9999" ? target : null,
        listLinkedManagerGuilds: async () => guilds,
      });
    },
  };
}

const session = {
  gameProfile: "wos",
  discordUser: { id: "111111111111111111", username: "manager", globalName: "Manager Name" },
};

test("manager authorization accepts Administrator or bot-manager role through any linked guild", async () => {
  const guilds = [
    { discord_guild_id: "guild-one", bot_manager_role_id: "role-one" },
    { discord_guild_id: "guild-two", bot_manager_role_id: "role-two" },
  ];
  for (const via of ["administrator", "bot_manager_role"]) {
    const checked = [];
    const authorizer = createCommunityManagerAuthorizer({
      gameProfile: "wos",
      repository: repositoryFor({ guilds }),
      async verifyDiscordGuildManager(input) {
        checked.push(input.guildId);
        return input.guildId === "guild-two"
          ? { status: "authorized", via, guildId: input.guildId }
          : { status: "denied", reason: "insufficient_permissions" };
      },
    });
    const context = await authorizer.authorize(session, "9999");
    assert.equal(context.authorizedCommunityId, "community-wos");
    assert.equal(context.authorization.via, via);
    assert.deepEqual(checked, ["guild-one", "guild-two"]);
  }
});

test("ordinary, stale, wrong-community, and cross-profile manager claims fail closed", async () => {
  const guilds = [{ discord_guild_id: "guild-one", bot_manager_role_id: "role-one" }];
  const denied = createCommunityManagerAuthorizer({
    gameProfile: "wos", repository: repositoryFor({ guilds }),
    verifyDiscordGuildManager: async () => ({ status: "denied", reason: "insufficient_permissions" }),
  });
  await assert.rejects(denied.authorize(session, "9999"), ManagerAccessDeniedError);
  await assert.rejects(denied.authorize(session, "8888"), (error) => error.code === "community_not_found");
  await assert.rejects(denied.authorize({ ...session, gameProfile: "kingshot" }, "9999"), ManagerAccessDeniedError);

  const stale = createCommunityManagerAuthorizer({
    gameProfile: "wos", repository: repositoryFor({ guilds }),
    verifyDiscordGuildManager: async () => ({ status: "unavailable", reason: "timeout", retryAfterSeconds: null }),
  });
  await assert.rejects(stale.authorize(session, "9999"), ManagerVerificationUnavailableError);
});

test("live Discord verifier detects configured role and Administrator permission without trusting stored roles", async () => {
  const calls = [];
  const fetchImplementation = async (url) => {
    calls.push(url);
    if (url.endsWith("/members/111111111111111111")) {
      return Response.json({ user: { id: "111111111111111111" }, roles: ["admin-role"] });
    }
    if (url.endsWith("/roles")) {
      return Response.json([
        { id: "222222222222222222", permissions: "0" },
        { id: "admin-role", permissions: "8" },
      ]);
    }
    return Response.json({ owner_id: "333333333333333333" });
  };
  const verifier = createDiscordGuildManagerVerifier({
    resolveBotToken: () => "secret-token",
    fetchImplementation,
  });
  const result = await verifier({
    gameProfile: "wos", discordUserId: "111111111111111111",
    guildId: "222222222222222222", managerRoleId: null,
  });
  assert.deepEqual(result, { status: "authorized", via: "administrator", guildId: "222222222222222222" });
  assert.equal(calls.length, 3);

  const roleVerifier = createDiscordGuildManagerVerifier({
    resolveBotToken: () => "secret-token",
    fetchImplementation: async () => Response.json({
      user: { id: "111111111111111111" }, roles: ["444444444444444444"],
    }),
  });
  assert.equal((await roleVerifier({
    gameProfile: "wos", discordUserId: "111111111111111111",
    guildId: "222222222222222222", managerRoleId: "444444444444444444",
  })).via, "bot_manager_role");
});

test("shared board UI uses State/Kingdom terms, mobile swipe panels, Copy Mode, and guarded Edit Mode", () => {
  const source = fs.readFileSync(new URL("../components/appointment-board/appointment-board.tsx", import.meta.url), "utf8");
  const navigation = fs.readFileSync(new URL("../components/community-section-navigation.tsx", import.meta.url), "utf8");
  const badge = fs.readFileSync(new URL("../components/appointment-board/alliance-badge.tsx", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(navigation, /profile === "kingshot" \? "Kingdom" : "State"/);
  assert.match(source, /Player name/);
  assert.match(source, /<th scope="col">Time<\/th>[\s\S]*<th scope="col">Alliance<\/th>[\s\S]*<th scope="col">Player<\/th>[\s\S]*<th scope="col">Player ID<\/th>[\s\S]*service\.requirementColumns\.map/);
  assert.match(source, /Player ID/);
  assert.match(source, /<table className="manager-table">/);
  assert.match(source, /<tr className=\{`manager-row/);
  assert.match(source, /import \{ AllianceBadge \} from "\.\/alliance-badge"/);
  assert.equal(source.match(/<AllianceBadge abbreviation=/g)?.length, 2);
  assert.match(badge, /export type AllianceBadgeVariant = "solid"/);
  assert.match(badge, /variant = "solid"/);
  assert.match(badge, /\{abbreviation\}/);
  assert.doesNotMatch(badge, /\[\{abbreviation\}\]/);
  assert.doesNotMatch(source, /manager-current-user-badge|>YOURS<|slot\.player\.isCurrentUser \?/);
  assert.match(source, /isCurrentUser: boolean/);
  assert.match(source, /public-confirmed-player/);
  assert.match(source, /onCopy\(value, `\$\{key\}:name`\)/);
  assert.match(source, /value=\{slot\.player\.inGameName\}/);
  assert.match(source, /value=\{slot\.player\.alliance\}/);
  assert.match(source, /<CopyButton alliance/);
  assert.match(source, /onCopy\(value, `\$\{key\}:alliance`\)/);
  assert.match(source, /service\.requirementColumns\.map/);
  assert.match(source, /Copy mode/);
  assert.match(source, /aria-pressed=\{editMode\}/);
  assert.match(source, /aria-pressed=\{!editMode\}/);
  assert.match(source, /Edit appointments/);
  assert.match(source, /editMode \? <td>\{slot\.state === "pending"/);
  assert.match(source, /slot\.state === "confirmed" && slot\.bookingId/);
  assert.match(source, />Reschedule<\/button>/);
  assert.match(source, />Cancel<\/button>/);
  assert.match(source, />Confirm cancel<\/button>/);
  assert.match(source, />Confirm move<\/button>/);
  assert.match(source, /manager-row__actions"><button className="booking-button"[\s\S]*Book this slot/);
  assert.match(source, /Troop Training/);
  assert.match(source, /candidate\.state === "available" && candidate\.date === slot\.date/);
  assert.match(source, /method: action === "cancel" \? "DELETE" : "PATCH"/);
  assert.match(source, /"idempotency-key": crypto\.randomUUID\(\)/);
  assert.match(css, /overflow-x: auto/);
  assert.match(css, /scroll-snap-type: inline mandatory/);
  assert.match(css, /grid-template-columns: repeat\(3/);
  assert.match(css, /copy-field--copied/);
  assert.match(css, /\.alliance-badge--solid \{[^}]*background: var\(--brand-accent-strong\)/);
  assert.doesNotMatch(css, /\.manager-current-user-badge/);
  assert.match(css, /\.manager-table-scroll \{[^}]*overflow-x: auto/);
  assert.match(css, /\.manager-row__actions \.booking-button \{[^}]*min-height: 2rem;[^}]*padding: 0\.25rem 0\.5rem;[^}]*font-size: 0\.75rem/);
  assert.doesNotMatch(css, /\.manager-row[^}]*flex-direction: column/);
});

test("public State and Kingdom routes are profile-specific while API profile remains hostname-derived", () => {
  const state = fs.readFileSync(new URL("../app/state/[communityCode]/page.tsx", import.meta.url), "utf8");
  const kingdom = fs.readFileSync(new URL("../app/kingdom/[communityCode]/page.tsx", import.meta.url), "utf8");
  const handler = fs.readFileSync(new URL("../server/booking-board/route-handler.ts", import.meta.url), "utf8");
  assert.match(state, /requiredProfile="wos"/);
  assert.match(kingdom, /requiredProfile="kingshot"/);
  assert.match(handler, /resolveNativeBookingRequestContext\(request\)/);
  assert.doesNotMatch(handler, /searchParams\.get\(["'](?:profile|gameProfile)/);
});
