import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import pg from "pg";

import { hashGuestShareToken } from "../server/booking-approval/domain-core.mjs";
import { createProfileScopedApprovalRepository } from "../server/booking-approval/repository-core.mjs";
import { createGuestBookingPageService } from "../server/booking-approval/service-core.mjs";
import { GuestLinkOperatorError, formatGuestLinkResult, manageGuestLink, parseGuestLinkArguments } from "../server/bootstrap/guest-link-operator.mjs";
import { loadMigrations, runMigrations } from "../server/database/migrations.mjs";

const databaseUrl = String(process.env.TEST_DATABASE_URL ?? "").trim();

test("guest-link arguments require one action and an explicit base URL for plaintext-producing actions", () => {
  assert.deepEqual(parseGuestLinkArguments(["--profile", "wos", "--community", "9999", "--create", "--base-url", "https://staging.example"]),
    { profile: "wos", communityCode: "9999", action: "create", baseUrl: "https://staging.example" });
  assert.deepEqual(parseGuestLinkArguments(["--profile", "kingshot", "--community", "9999", "--status"]),
    { profile: "kingshot", communityCode: "9999", action: "status", baseUrl: null });
  for (const argv of [[], ["--profile", "wos", "--community", "9999", "--create"], ["--profile", "wos", "--community", "9999", "--status", "--revoke"], ["--profile", "bad", "--community", "9999", "--status"]]) {
    assert.throws(() => parseGuestLinkArguments(argv), GuestLinkOperatorError);
  }
});

test("status formatting never prints a plaintext token", () => {
  const output = formatGuestLinkResult({ profile: "wos", communityCode: "9999", active: true, tokenHint: "abcdef", url: null, changed: false, action: "status" });
  assert.match(output, /State: 9999/); assert.match(output, /Token hint: abcdef/); assert.doesNotMatch(output, /\/book\/|Plaintext token/);
});

test("guest-link lifecycle is transactional and profile-isolated in PostgreSQL", { skip: !databaseUrl && "TEST_DATABASE_URL is not configured" }, async (t) => {
  const schema = `guest_link_${randomUUID().replaceAll("-", "")}`;
  const runtimeRole = `guest_link_runtime_${randomUUID().replaceAll("-", "")}`;
  const password = `pw_${randomUUID()}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const operator = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  let runtime;
  try {
    await runMigrations(operator, await loadMigrations(fileURLToPath(new URL("../db/migrations/", import.meta.url))));
    for (const profile of ["wos", "kingshot"]) {
      await operator.query("BEGIN");
      await operator.query("SELECT set_config('app.game_profile',$1,true)", [profile]);
      await operator.query(`INSERT INTO booking_communities (game_profile,id,location_code,display_name,status)
        VALUES ($1,$2,'9999',$3,'active')`, [profile, randomUUID(), `${profile} Test Server`]);
      await operator.query(`INSERT INTO booking_settings (game_profile,community_id)
        SELECT game_profile,id FROM booking_communities WHERE game_profile=$1 AND location_code='9999'`, [profile]);
      await operator.query("COMMIT");
    }
    const generated = ["a".repeat(43), "b".repeat(43), "c".repeat(43)];
    let index = 0;
    const createToken = () => generated[index++];
    const created = await manageGuestLink({ pool: operator, profile: "wos", communityCode: "9999", action: "create", baseUrl: "https://wos.example", createToken });
    assert.equal(created.url, `https://wos.example/book/${generated[0]}`);
    assert.equal((await manageGuestLink({ pool: operator, profile: "wos", communityCode: "9999", action: "status", baseUrl: null })).token, null);
    const stored = await operator.query("SELECT token_hash,token_hint,revoked_at FROM booking_guest_share_links ORDER BY created_at");
    assert.equal(stored.rows[0].token_hash, hashGuestShareToken(generated[0]));
    assert.doesNotMatch(JSON.stringify(stored.rows), new RegExp(generated[0]));

    const rotated = await manageGuestLink({ pool: operator, profile: "wos", communityCode: "9999", action: "rotate", baseUrl: "https://wos.example", createToken });
    assert.match(rotated.url, new RegExp(generated[1]));
    const links = await operator.query("SELECT token_hash,revoked_at FROM booking_guest_share_links ORDER BY created_at,id");
    assert.ok(links.rows.find((row) => row.token_hash === hashGuestShareToken(generated[0])).revoked_at);
    assert.equal(links.rows.find((row) => row.token_hash === hashGuestShareToken(generated[1])).revoked_at, null);
    const pageService = createGuestBookingPageService({
      gameProfile: "wos", repository: createProfileScopedApprovalRepository("wos", operator),
    });
    await assert.rejects(pageService.read(generated[0]), (error) => error.code === "invalid_share_link");
    assert.deepEqual((await pageService.read(generated[1])).community, { code: "9999", displayName: "wos Test Server" });
    assert.equal((await manageGuestLink({ pool: operator, profile: "kingshot", communityCode: "9999", action: "status", baseUrl: null })).active, false);

    await assert.rejects(manageGuestLink({ pool: operator, profile: "wos", communityCode: "9999", action: "rotate", baseUrl: "https://wos.example", createToken, injectFailure: true }), /Injected/);
    assert.equal((await manageGuestLink({ pool: operator, profile: "wos", communityCode: "9999", action: "status", baseUrl: null })).tokenHint, generated[1].slice(0, 6));
    assert.equal((await manageGuestLink({ pool: operator, profile: "wos", communityCode: "9999", action: "revoke", baseUrl: null })).active, false);
    await assert.rejects(pageService.read(generated[1]), (error) => error.code === "invalid_share_link");

    const expiredToken = "z".repeat(43);
    await operator.query("BEGIN");
    await operator.query("SELECT set_config('app.game_profile','kingshot',true)");
    await operator.query(`INSERT INTO booking_guest_share_links
      (game_profile,id,community_id,token_hash,token_hint,created_at,expires_at)
      SELECT 'kingshot',$1,id,$2,'zzzzzz',now()-interval '2 hours',now()-interval '1 hour'
      FROM booking_communities WHERE game_profile='kingshot' AND location_code='9999'`,
    [randomUUID(), hashGuestShareToken(expiredToken)]);
    await operator.query("COMMIT");
    const replacement = await manageGuestLink({ pool: operator, profile: "kingshot", communityCode: "9999", action: "create", baseUrl: "https://kingshot.example", createToken });
    assert.match(replacement.url, new RegExp(generated[2]));
    const expired = await operator.query("SELECT revoked_at FROM booking_guest_share_links WHERE token_hash=$1", [hashGuestShareToken(expiredToken)]);
    assert.ok(expired.rows[0].revoked_at);

    await admin.query(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}`);
    await operator.query(`GRANT SELECT ON booking_communities,booking_guest_share_links TO ${runtimeRole}`);
    const url = new URL(databaseUrl); url.username = runtimeRole; url.password = password;
    runtime = new pg.Pool({ connectionString: url.toString(), options: `-c search_path=${schema}` });
    await t.test("website runtime role is refused", async () => assert.rejects(
      manageGuestLink({ pool: runtime, profile: "wos", communityCode: "9999", action: "status", baseUrl: null }),
      (error) => error.code === "insufficient_role",
    ));
  } finally {
    await runtime?.end(); await operator.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.query(`DROP ROLE IF EXISTS ${runtimeRole}`); await admin.end();
  }
});
