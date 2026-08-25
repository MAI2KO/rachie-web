import { allianceEventsRequestHeaders } from "./auth-core.mjs";

const PROFILE_SET = new Set(["wos", "kingshot"]);

export class AllianceEventsUnavailableError extends Error {
  constructor() {
    super("Alliance event schedules are unavailable.");
    this.name = "AllianceEventsUnavailableError";
  }
}

function boundedText(value, maximum) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= maximum ? text : null;
}

export function publicAllianceEventsModel(payload, expectedProfile, expectedCode) {
  if (!payload || payload.ok !== true || payload.profile !== expectedProfile
      || payload.communityCode !== expectedCode || !Array.isArray(payload.alliances)
      || payload.alliances.length > 1000) {
    throw new AllianceEventsUnavailableError();
  }
  const alliances = payload.alliances.map((rawAlliance) => {
    const name = boundedText(rawAlliance?.name, 100);
    const abbreviation = rawAlliance?.abbreviation === null
      ? null : boundedText(rawAlliance?.abbreviation, 16);
    if (!name || !Array.isArray(rawAlliance?.events) || rawAlliance.events.length > 1000) {
      throw new AllianceEventsUnavailableError();
    }
    const events = rawAlliance.events.map((rawEvent) => {
      const eventName = boundedText(rawEvent?.name, 100);
      const days = Number(rawEvent?.recurrence?.days);
      const summary = boundedText(rawEvent?.recurrence?.summary, 60);
      if (!eventName || !Number.isInteger(days) || days < 1 || days > 366 || !summary
          || !Array.isArray(rawEvent?.upcoming) || rawEvent.upcoming.length > 10) {
        throw new AllianceEventsUnavailableError();
      }
      const upcoming = rawEvent.upcoming.map((rawOccurrence) => {
        const at = boundedText(rawOccurrence?.at, 40);
        const group = rawOccurrence?.group === null ? null : boundedText(rawOccurrence?.group, 100);
        if (!at || !Number.isFinite(new Date(at).getTime())) throw new AllianceEventsUnavailableError();
        return Object.freeze({ at: new Date(at).toISOString(), group });
      });
      return Object.freeze({
        name: eventName,
        recurrence: Object.freeze({ days, summary }),
        upcoming: Object.freeze(upcoming),
      });
    });
    return Object.freeze({ name, abbreviation, events: Object.freeze(events) });
  });
  return Object.freeze({
    profile: expectedProfile,
    communityCode: expectedCode,
    alliances: Object.freeze(alliances),
  });
}

export function createAllianceEventsClient({ config, fetchImplementation = fetch,
  now = Date.now, createNonce = undefined, cache = new Map(), cacheTtlMs = 30_000 }) {
  if (!config || !PROFILE_SET.has(config.profile)) throw new AllianceEventsUnavailableError();
  return Object.freeze({
    async read(communityCode) {
      const cacheKey = `${config.profile}:${communityCode}`;
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > now()) return cached.value;
      const path = `/internal/v1/public-alliance-events/${encodeURIComponent(communityCode)}`;
      let response;
      try {
        response = await fetchImplementation(`${config.baseUrl}${path}`, {
          method: "GET",
          headers: allianceEventsRequestHeaders({
            secret: config.secret,
            profile: config.profile,
            method: "GET",
            path,
            now,
            ...(createNonce ? { createNonce } : {}),
          }),
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        throw new AllianceEventsUnavailableError();
      }
      if (!response.ok) throw new AllianceEventsUnavailableError();
      let payload;
      try { payload = await response.json(); } catch { throw new AllianceEventsUnavailableError(); }
      const value = publicAllianceEventsModel(payload, config.profile, communityCode);
      cache.set(cacheKey, { value, expiresAt: now() + cacheTtlMs });
      if (cache.size > 200) cache.delete(cache.keys().next().value);
      return value;
    },
  });
}
