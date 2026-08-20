export async function withDevelopmentTiming(label, work) {
  if (process.env.NODE_ENV !== "development") return work();
  const startedAt = performance.now();
  try {
    return await work();
  } finally {
    const elapsedMilliseconds = Math.round((performance.now() - startedAt) * 10) / 10;
    console.info(`[development timing] ${label}: ${elapsedMilliseconds}ms`);
  }
}
