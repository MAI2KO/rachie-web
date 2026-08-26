export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startAutomaticBookingCycleWorker } = await import("./server/automatic-booking-cycle/runtime");
    await startAutomaticBookingCycleWorker();
  }
}
