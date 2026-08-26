import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

import pg from "pg";

import { reconcileAutomaticWosBookingCycles } from "../server/automatic-booking-cycle/repository-core.mjs";
import { loadMigrations, runMigrations } from "../server/database/migrations.mjs";
import { runtimePrivilegeStatements } from "../server/database/runtime-privileges.mjs";
import { createBookingCreationService } from "../server/native-booking/booking-creation-service-core.mjs";
import { createBookingMutationService } from "../server/native-booking/booking-mutation-service-core.mjs";
import { createProfileScopedBookingAdminRepository } from "../server/booking-admin/repository-core.mjs";
import { createBookingAdminService } from "../server/booking-admin/service-core.mjs";
import { createProfileScopedBookingRepository } from "../server/native-booking/repository-core.mjs";
import { createRegistrationService } from "../server/native-booking/registration-service-core.mjs";

const databaseUrl = String(process.env.TEST_DATABASE_URL ?? "").trim();

async function withProfile(pool, profile, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.game_profile',$1,true)", [profile]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

test("staging-equivalent runtime grants support native booking writes", { skip: !databaseUrl && "TEST_DATABASE_URL is not configured" }, async (t) => {
  const schema = `runtime_grants_${randomUUID().replaceAll("-", "")}`;
  const role = `runtime_grants_role_${randomUUID().replaceAll("-", "")}`;
  const password = `test_${randomUUID()}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const owner = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  let runtime;

  try {
    await runMigrations(owner, await loadMigrations(fileURLToPath(new URL("../db/migrations/", import.meta.url))));
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    for (const sql of runtimePrivilegeStatements(role, { includeRowLockPrivileges: false })) await owner.query(sql);

    const communityId = randomUUID();
    const windowId = randomUUID();
    const serviceDateId = randomUUID();
    const slotIds = [randomUUID(), randomUUID()];
    await withProfile(owner, "wos", async (client) => {
      await client.query(
        `INSERT INTO booking_communities (game_profile,id,location_code,display_name,status,bookings_open)
         VALUES ('wos',$1,'9999','Test Server','active',true)`,
        [communityId],
      );
      await client.query(
        `INSERT INTO booking_settings (game_profile,community_id)
         VALUES ('wos',$1)`,
        [communityId],
      );
      await client.query(
        `INSERT INTO booking_windows
           (game_profile,id,community_id,status,created_by_actor_type)
         VALUES ('wos',$1,$2,'open','system')`,
        [windowId, communityId],
      );
      await client.query(
        `INSERT INTO booking_service_dates
           (game_profile,id,community_id,window_id,service_code,booking_date)
         VALUES ('wos',$1,$2,$3,'construction','2026-09-01')`,
        [serviceDateId, communityId, windowId],
      );
      for (const [ordinal, slotId] of slotIds.entries()) {
        await client.query(
          `INSERT INTO appointment_slots
             (game_profile,id,community_id,window_id,service_date_id,service_code,
              booking_date,ordinal,display_time_label,local_start_time,time_zone)
           VALUES ('wos',$1,$2,$3,$4,'construction','2026-09-01',$5,$6,$7,'Europe/London')`,
          [
            slotId,
            communityId,
            windowId,
            serviceDateId,
            ordinal,
            `${String(9 + ordinal).padStart(2, "0")}:00`,
            `${String(9 + ordinal).padStart(2, "0")}:00`,
          ],
        );
      }
      for (const [serviceCode, bookingDate] of [["research", "2026-09-02"], ["troop", "2026-09-03"]]) {
        const dateId = randomUUID();
        await client.query(
          `INSERT INTO booking_service_dates
             (game_profile,id,community_id,window_id,service_code,booking_date)
           VALUES ('wos',$1,$2,$3,$4,$5)`,
          [dateId, communityId, windowId, serviceCode, bookingDate],
        );
        await client.query(
          `INSERT INTO appointment_slots
             (game_profile,id,community_id,window_id,service_date_id,service_code,
              booking_date,ordinal,display_time_label,local_start_time,time_zone)
           VALUES ('wos',$1,$2,$3,$4,$5,$6,0,'09:00','09:00','Europe/London')`,
          [randomUUID(), communityId, windowId, dateId, serviceCode, bookingDate],
        );
      }
    });

    const url = new URL(databaseUrl);
    url.username = role;
    url.password = password;
    runtime = new pg.Pool({ connectionString: url.toString(), options: `-c search_path=${schema}` });
    const roleState = await runtime.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
    assert.deepEqual(roleState.rows, [{ rolsuper: false, rolbypassrls: false }]);
    await assert.rejects(runtime.query("SELECT version FROM app_schema_migrations"), (error) => error.code === "42501");

    const context = { gameProfile: "wos", community: { id: communityId }, discordUser: { id: "runtime-user" } };
    const repository = createProfileScopedBookingRepository("wos", runtime);
    await createRegistrationService({ context, repository }).upsert(
      { playerId: "99990001", inGameName: "Runtime Test", alliance: "TST" },
      "runtime-register-0001",
    );
    const creator = createBookingCreationService({ context, repository });
    const choice = (slotId) => ({ serviceCode: "construction", slotId, requirements: {} });

    await t.test("the documented SELECT-only configuration grant reproduces SQLSTATE 42501", async () => {
      await assert.rejects(
        creator.create(choice(slotIds[0]), "runtime-booking-before-lock-grants"),
        (error) => error.code === "42501" && /booking_communities/.test(error.message),
      );
      const started = await withProfile(runtime, "wos", (client) => client.query(
        "SELECT count(*)::int AS count FROM booking_idempotency_keys WHERE operation='booking_create'",
      ));
      assert.equal(started.rows[0].count, 0);
    });

    await owner.query(`GRANT UPDATE (updated_at) ON booking_communities TO "${role}"`);
    await t.test("fixing only the community lock exposes the second appointment-slot lock requirement", async () => {
      await assert.rejects(
        creator.create(choice(slotIds[0]), "runtime-booking-community-lock-only"),
        (error) => error.code === "42501" && /appointment_slots/.test(error.message),
      );
    });

    await owner.query(`GRANT UPDATE (updated_at) ON appointment_slots TO "${role}"`);
    await t.test("column-level lock grants allow creation, reschedule, and cancellation", async () => {
      const created = await creator.create(choice(slotIds[0]), "runtime-booking-create-0001");
      assert.equal(created.status, 201);
      const mutations = createBookingMutationService({ context, repository });
      const rescheduled = await mutations.reschedule(
        created.body.booking.bookingId,
        { slotId: slotIds[1], requirements: {} },
        "runtime-booking-reschedule-0001",
      );
      assert.equal(rescheduled.body.outcome, "rescheduled");
      const cancelled = await mutations.cancel(
        rescheduled.body.booking.bookingId,
        "runtime-booking-cancel-0001",
      );
      assert.equal(cancelled.body.booking.status, "cancelled");
    });

    await t.test("admin grants permit only the intended booking configuration columns", async () => {
      const privileges = await runtime.query(
        `SELECT
           has_table_privilege(current_user,'booking_communities','UPDATE') AS community_table_update,
           has_column_privilege(current_user,'booking_communities','updated_at','UPDATE') AS community_lock_column,
           has_column_privilege(current_user,'booking_communities','bookings_open','UPDATE') AS community_business_column,
           has_column_privilege(current_user,'booking_communities','status','UPDATE') AS community_status_column,
           has_table_privilege(current_user,'appointment_slots','UPDATE') AS slot_table_update,
           has_column_privilege(current_user,'appointment_slots','updated_at','UPDATE') AS slot_lock_column,
           has_column_privilege(current_user,'appointment_slots','status','UPDATE') AS slot_business_column`,
      );
      assert.deepEqual(privileges.rows[0], {
        community_table_update: false,
        community_lock_column: true,
        community_business_column: true,
        community_status_column: false,
        slot_table_update: false,
        slot_lock_column: true,
        slot_business_column: false,
      });
      await assert.rejects(withProfile(runtime, "wos", (client) => client.query(
        "UPDATE booking_communities SET status='archived' WHERE id=$1",
        [communityId],
      )), (error) => error.code === "42501");
      await assert.rejects(withProfile(runtime, "wos", (client) => client.query(
        "UPDATE appointment_slots SET status='blocked' WHERE id=$1",
        [slotIds[0]],
      )), (error) => error.code === "42501");
    });

    await t.test("runtime role can persist audited Booking Admin settings", async () => {
      const managerContext = {
        gameProfile: "wos", authorizedCommunityId: communityId,
        discordUserId: "111111111111111111", displayName: "Runtime Manager",
      };
      const adminService = createBookingAdminService({
        gameProfile: "wos", communityId, managerContext,
        repository: createProfileScopedBookingAdminRepository("wos", runtime),
      });
      assert.equal((await adminService.update({ section: "booking", enabled: false }))
        .community.bookingsEnabled, false);
      assert.equal((await adminService.update({
        section: "service", serviceCode: "construction", enabled: false,
      })).services.find(({ code }) => code === "construction").enabled, false);
      assert.equal((await adminService.update({
        section: "requirement", serviceCode: "construction", requirementCode: "fc", enabled: true,
      })).services.find(({ code }) => code === "construction")
        .requirements.find(({ code }) => code === "fc").enabled, true);
    });

    await t.test("runtime role can reconcile deterministic automatic WOS cycles", async () => {
      const result = await reconcileAutomaticWosBookingCycles({
        pool: runtime, now: new Date("2026-09-01T00:00:00.000Z"),
      });
      assert.equal(result.communities.length, 1);
      assert.equal(result.communities[0].cycles.every(({ status }) => status === "draft"), true);
      const automaticWindows = await withProfile(runtime, "wos", (client) => client.query(
        `SELECT count(*)::int AS count FROM booking_windows
          WHERE community_id=$1 AND created_by_actor_id='automatic-wos-28-day-cycle-v1'`,
        [communityId],
      ));
      assert.equal(automaticWindows.rows[0].count, 2);
    });
  } finally {
    await runtime?.end();
    await owner.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  }
});
