import { AllianceBadge } from "@/components/appointment-board/alliance-badge";
import { CommunitySectionNavigation } from "@/components/community-section-navigation";
import type { GameProfile } from "@/brands/types";

import { BrowserLocalTime } from "./browser-local-time";

export interface PublicAllianceEvent {
  readonly name: string;
  readonly recurrence: { readonly days: number; readonly summary: string };
  readonly upcoming: readonly { readonly at: string; readonly group: string | null }[];
}

export interface PublicAllianceSchedule {
  readonly name: string;
  readonly abbreviation: string | null;
  readonly events: readonly PublicAllianceEvent[];
}

function utcTime(instant: string) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).format(new Date(instant));
}

function eventOccurrences(event: PublicAllianceEvent) {
  const grouped = event.upcoming.some((occurrence) => occurrence.group !== null);
  if (!grouped) return event.upcoming.slice(0, 1);
  const groupNames = new Set<string>();
  return event.upcoming.filter((occurrence) => {
    const group = occurrence.group ?? "";
    if (group && !groupNames.has(group)) {
      groupNames.add(group);
      return true;
    }
    return false;
  });
}

function OccurrenceTime({ instant }: { readonly instant: string }) {
  return <span className="alliance-occurrence-time">
    <time dateTime={instant}>{utcTime(instant)} UTC</time>
    <span aria-hidden="true">·</span>
    <BrowserLocalTime instant={instant} />
  </span>;
}

export function AllianceEvents({ profile, community, alliances, unavailable }: {
  readonly profile: GameProfile;
  readonly community: { readonly code: string; readonly displayName: string };
  readonly alliances: readonly PublicAllianceSchedule[];
  readonly unavailable: boolean;
}) {
  const noun = profile === "kingshot" ? "Kingdom" : "State";
  return (
    <article className="alliance-events-page">
      <header className="alliance-events-page__heading">
        <p className="booking-kicker">{noun} {community.code}</p>
        <h1>{community.displayName}</h1>
      </header>
      <CommunitySectionNavigation communityCode={community.code} current="events" profile={profile} />
      <section aria-labelledby="alliance-events-title" className="alliance-events-schedule">
        <header>
          <h2 id="alliance-events-title">Alliance Events</h2>
          <p>Public schedules for participating alliances in this {noun.toLowerCase()}.</p>
        </header>
        {unavailable
          ? <p className="alliance-events-message" role="status">Alliance event schedules are temporarily unavailable.</p>
          : alliances.length === 0
            ? <p className="alliance-events-message">No alliance events are currently scheduled.</p>
            : <div className="alliance-sections">
              {alliances.map((alliance, allianceIndex) => (
                <section className="alliance-schedule" key={`${alliance.name}:${allianceIndex}`}>
                  <header>
                    {alliance.abbreviation ? <AllianceBadge abbreviation={alliance.abbreviation} /> : null}
                    <h3>{alliance.name}</h3>
                  </header>
                  <div className="alliance-event-list">
                    {alliance.events.map((event, eventIndex) => (
                      <article className="alliance-event" key={`${event.name}:${eventIndex}`}>
                        <h4>{event.name}</h4>
                        {(() => {
                          const occurrences = eventOccurrences(event);
                          const grouped = occurrences.some((occurrence) => occurrence.group !== null);
                          return grouped
                            ? <dl className="alliance-event-groups">
                              {occurrences.map((occurrence) => (
                                <div className="alliance-event-group" key={`${occurrence.at}:${occurrence.group}`}>
                                  <dt>{occurrence.group}</dt>
                                  <dd><OccurrenceTime instant={occurrence.at} /></dd>
                                </div>
                              ))}
                            </dl>
                            : occurrences[0]
                              ? <p className="alliance-event-time">
                                <OccurrenceTime instant={occurrences[0].at} />
                              </p>
                              : null;
                        })()}
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </div>}
      </section>
    </article>
  );
}
