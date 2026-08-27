import "server-only";

import { getDatabasePool } from "@/server/database/pool";
import { getBookingIntegrationSecret } from "@/server/discord-integration/config";

import { reconcileAutomaticWosBookingCycles } from "./repository-core.mjs";

const INTERVAL_MS = 60_000;
const globalWorker = globalThis as typeof globalThis & {
  automaticBookingCycleWorker?: ReturnType<typeof setInterval>;
};

async function reconcile() {
  const pool = getDatabasePool();
  if (!pool) return;
  try {
    await reconcileAutomaticWosBookingCycles({
      pool,
      guestTokenSecret: getBookingIntegrationSecret("wos"),
    });
  } catch (error) {
    console.error("[Automatic booking cycle] Reconciliation failed.", error);
  }
}

export async function startAutomaticBookingCycleWorker() {
  if (globalWorker.automaticBookingCycleWorker) return;
  await reconcile();
  const timer = setInterval(() => void reconcile(), INTERVAL_MS);
  timer.unref();
  globalWorker.automaticBookingCycleWorker = timer;
}
