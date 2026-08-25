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
  const guildModel = publicAllianceEventsGuildModel(payload, expectedProfile);
  return Object.freeze({
    profile: expectedProfile,
    communityCode: expectedCode,
    alliances: guildModel.alliances,
  });
}

export function publicAllianceEventsGuildModel(payload, expectedProfile) {
  if (!payload || payload.ok !== true || payload.profile !== expectedProfile
      || !Array.isArray(payload.alliances) || payload.alliances.length > 1000) {
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
    alliances: Object.freeze(alliances),
  });
}

function compareAlliance(left, right) {
  return left.name.localeCompare(right.name, "en", { sensitivity: "base" });
}

export function createAllianceEventsClient({ config, fetchImplementation = fetch,
  now = Date.now, createNonce = undefined, cache = new Map(), cacheTtlMs = 30_000 }) {
  if (!config || !PROFILE_SET.has(config.profile)) throw new AllianceEventsUnavailableError();
  return Object.freeze({
    async read(communityCode, guildIds) {
      if (!Array.isArray(guildIds) || guildIds.length > 1000
          || guildIds.some((guildId) => !/^\d{15,22}$/.test(String(guildId)))) {
        throw new AllianceEventsUnavailableError();
      }
      const cacheKey = `${config.profile}:${communityCode}`;
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > now()) return cached.value;
      let models;
      try {
        models = await Promise.all(guildIds.map(async (guildId) => {
          const path = `/internal/v1/public-alliance-events/guild/${guildId}`;
          const response = await fetchImplementation(`${config.baseUrl}${path}`, {
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
          if (!response.ok) throw new AllianceEventsUnavailableError();
          return publicAllianceEventsGuildModel(await response.json(), config.profile);
        }));
      } catch {
        throw new AllianceEventsUnavailableError();
      }
      const value = publicAllianceEventsModel({
        ok: true,
        profile: config.profile,
        communityCode,
        alliances: models.flatMap((model) => model.alliances).sort(compareAlliance),
      }, config.profile, communityCode);
      cache.set(cacheKey, { value, expiresAt: now() + cacheTtlMs });
      if (cache.size > 200) cache.delete(cache.keys().next().value);
      return value;
    },
  });
}
