export function resolveDatabaseUrl(environment = process.env) {
  const value = String(environment.DATABASE_URL ?? "").trim();
  return value || null;
}
