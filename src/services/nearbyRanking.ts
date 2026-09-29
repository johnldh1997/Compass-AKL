// --- Nearby Search Ranking ---
// Pure geometry and ranking logic for "what's within N minutes of me" queries — no Expo or
// network imports, so it runs directly under `node --test` (see nearbyRanking.test.ts).
//
// The real problem this solves: checking every place Google Places returns for a category
// against the live Routes API (to get an actual walk/transit time) doesn't scale — each check
// is a network call, and a broad category search can return dozens of candidates. Straight-line
// distance is free and instant, so it prunes the candidate set before any expensive call is
// made. The tradeoff is that straight-line distance isn't proportional to transit time (a train
// can easily beat a "closer" straight-line walk), so the prune radius has to stay generous
// enough not to wrongly exclude a real match — see PRUNE_RADIUS_METERS below.

export interface NearbyCandidate {
  id: string;
  name: string;
  lat: number;
  lon: number;
  // Display-only fields from Places — never used for ranking/pruning, only shown to the user,
  // so each is optional rather than the whole candidate failing when Places lacks one of them.
  rating?: number;
  userRatingCount?: number;
  editorialSummary?: string;
  mapsUri?: string;
  // Whether it's confirmed open at the relevant moment (the stated time, or now if none was
  // given) — informational only; a query with no stated time no longer filters by this, it
  // just shows it, since "open right now" isn't something the user actually asked for.
  isOpenNow?: boolean;
  // A human-readable hours line for the relevant day (Google's own formatted text), so the
  // user can judge for themselves rather than just seeing an open/closed flag.
  todayHoursText?: string;
}

export interface PrunedCandidate extends NearbyCandidate {
  straightLineMeters: number;
}

export type TravelMode = 'WALK' | 'TRANSIT';

export interface RoutedCandidate extends PrunedCandidate {
  durationMinutes: number;
  mode: TravelMode;
  // Only present for a TRANSIT result — the line the rider would take.
  routeShortName?: string;
}

// Beyond this, straight-line distance alone can't justify the cost of a real routing call —
// no realistic Auckland transit connection turns a >6km straight line into a <20 min trip once
// walk-to-stop, wait, and walk-from-stop time are included. Only valid when the caller actually
// has a time budget to prune against — see UNBOUNDED_PRUNE_RADIUS_METERS for "closest X" queries
// with no stated limit, where excluding a real match by this reasoning would be wrong.
export const PRUNE_RADIUS_METERS = 6000;

// Used instead of PRUNE_RADIUS_METERS when the user gave no time/distance limit at all (a plain
// "closest X" query) — there's no duration to prune against, so this just bounds cost across
// greater Auckland rather than expressing any real constraint on the answer.
export const UNBOUNDED_PRUNE_RADIUS_METERS = 25_000;

// How many pruned candidates actually get a real (expensive) routing call — this is the number
// that bounds API cost per search, not the number of results shown to the user.
export const DEFAULT_MAX_ROUTED_CANDIDATES = 8;

// Below this straight-line distance, walking is checked instead of transit — waiting for a bus
// to go four blocks is almost never faster than just walking it.
export const WALKABLE_THRESHOLD_METERS = 1500;

const EARTH_RADIUS_METERS = 6371000;

export function distanceMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

// Cheap, no-network first pass: drops anything implausibly far, then keeps only the closest
// `maxCandidates` — those are the only ones that go on to cost a real routing call.
export function pruneByStraightLineDistance(
  userLocation: { lat: number; lon: number },
  candidates: NearbyCandidate[],
  maxCandidates: number = DEFAULT_MAX_ROUTED_CANDIDATES,
  pruneRadiusMeters: number = PRUNE_RADIUS_METERS
): PrunedCandidate[] {
  return candidates
    .map((c) => ({ ...c, straightLineMeters: distanceMeters(userLocation, c) }))
    .filter((c) => c.straightLineMeters <= pruneRadiusMeters)
    .sort((a, b) => a.straightLineMeters - b.straightLineMeters)
    .slice(0, maxCandidates);
}

// Which mode is worth an actual routing call for this candidate — a pure heuristic, not a
// guess by the model.
export function chooseTravelMode(
  straightLineMeters: number,
  walkableThresholdMeters: number = WALKABLE_THRESHOLD_METERS
): TravelMode {
  return straightLineMeters <= walkableThresholdMeters ? 'WALK' : 'TRANSIT';
}

// Final pass, after real routing times are known: soonest first, dropping anything over budget
// when there is one. maxMinutes is null for a plain "closest X" query with no stated limit —
// the user asked for the closest, not the closest-within-some-number-we-picked, so nothing gets
// filtered out by duration in that case, only ranked.
export function filterAndRankByDuration(
  routed: RoutedCandidate[],
  maxMinutes: number | null,
  limit: number = 6
): RoutedCandidate[] {
  return routed
    .filter((c) => maxMinutes === null || c.durationMinutes <= maxMinutes)
    .sort((a, b) => a.durationMinutes - b.durationMinutes)
    .slice(0, limit);
}

// --- Target Day/Time Resolution ---
// The model only ever extracts what the user actually said (a day word, an hour, a minute) —
// it never computes an actual timestamp itself, since that kind of date arithmetic (today vs.
// tomorrow, "next Friday" vs. this one, timezone handling) is exactly where a model is most
// likely to quietly get it wrong. This turns those plain fields into a real Date instead.
export type TargetDay = 'today' | 'tomorrow' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

const WEEKDAY_ORDER: TargetDay[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function resolveTargetDateTime(now: Date, targetDay: TargetDay | null, hour: number | null, minute: number | null): Date | null {
  if (targetDay === null && hour === null) return null;

  const result = new Date(now);
  if (targetDay === 'tomorrow') {
    result.setDate(result.getDate() + 1);
  } else if (targetDay !== null && targetDay !== 'today') {
    const targetIndex = WEEKDAY_ORDER.indexOf(targetDay);
    let daysAhead = (targetIndex - result.getDay() + 7) % 7;
    // Naming today's own weekday means "next week" — "today" is its own explicit option
    // for literally today, so a same-named weekday shouldn't collapse back onto it.
    if (daysAhead === 0) daysAhead = 7;
    result.setDate(result.getDate() + daysAhead);
  }

  if (hour !== null) {
    result.setHours(hour, minute ?? 0, 0, 0);
    // No day was stated and that time has already passed today — "at 5pm" said at 8pm almost
    // always means the next occurrence, not a moment already gone.
    if (targetDay === null && result.getTime() < now.getTime()) {
      result.setDate(result.getDate() + 1);
    }
  }

  return result;
}

// --- Opening Hours ---
// day is 0=Sunday..6=Saturday, matching Google Places' own regularOpeningHours.periods shape —
// kept as a plain structural type here (not importing anything Places-specific) so this stays
// pure and network-free like the rest of this file.
export interface OpeningPeriod {
  openDay: number;
  openHour: number;
  openMinute: number;
  closeDay: number;
  closeHour: number;
  closeMinute: number;
}

const MINUTES_PER_WEEK = 7 * 24 * 60;

function minutesSinceWeekStart(day: number, hour: number, minute: number): number {
  return day * 24 * 60 + hour * 60 + minute;
}

// null periods means "no opening-hours data at all" — that's unknown, not closed, so it passes
// through rather than being excluded; excluding a place we simply have no data for would throw
// away real matches over a data gap, not a real fact about whether they're open.
export function isOpenAt(periods: OpeningPeriod[] | null, at: Date): boolean {
  if (periods === null) return true;
  const targetMinutes = minutesSinceWeekStart(at.getDay(), at.getHours(), at.getMinutes());
  return periods.some((p) => {
    const openMinutes = minutesSinceWeekStart(p.openDay, p.openHour, p.openMinute);
    let closeMinutes = minutesSinceWeekStart(p.closeDay, p.closeHour, p.closeMinute);
    // A period that crosses midnight (or wraps past the end of the week) has a close time
    // that's numerically earlier than its open time — push it a week ahead so the range is
    // linear, then check the target both as-is and shifted a week ahead, so a period that
    // wraps past Saturday night into Sunday still matches an early-Sunday target correctly.
    if (closeMinutes <= openMinutes) closeMinutes += MINUTES_PER_WEEK;
    return (
      (targetMinutes >= openMinutes && targetMinutes < closeMinutes) ||
      (targetMinutes + MINUTES_PER_WEEK >= openMinutes && targetMinutes + MINUTES_PER_WEEK < closeMinutes)
    );
  });
}
