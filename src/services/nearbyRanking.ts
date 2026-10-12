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
  // 0 (free) to 4 (very expensive), as Places reports it. Absent for the many places it has no
  // price for — which is "unknown", not "cheap".
  priceLevel?: number;
  // Likewise tri-state: true / false when Places knows, absent when it doesn't.
  servesVegetarianFood?: boolean;
  outdoorSeating?: boolean;
  // Raw opening hours as Places returned them, kept on the candidate until routing says when the
  // user would actually get there (see withArrivalHours). null means Places had no hours at all.
  openingPeriods?: OpeningPeriod[] | null;
  // Google's own formatted text, one entry per day, Monday-first (index 0 = Monday).
  weekdayDescriptions?: string[] | null;
  // Whether it's open at the moment the user would ARRIVE (departure + travel time), not at the
  // moment they leave — a place that closes ten minutes after you set off isn't open for a
  // twenty-minute walk. Absent when Places gave no hours, so the UI shows nothing rather than
  // a guess. A query with no stated time still isn't filtered by this, only annotated.
  isOpenOnArrival?: boolean;
  // Only set when it's open on arrival but closes within CLOSING_SOON_MINUTES after it — "you'd
  // have 25 minutes".
  closesInMinutes?: number;
  // A human-readable hours line for the day of arrival (Google's own formatted text), so the
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

// --- Ranking Preference & Requirements ---
// What the user asked for beyond a category: closest (the default) or best rated, and optional
// "cheap" / "vegetarian" / "outdoor seating" asks. The model only flags these; every judgement
// about an actual place is made here, against real Places data.
export type RankBy = 'nearest' | 'best';

export interface SearchRequirements {
  wantsCheap?: boolean;
  wantsVegetarian?: boolean;
  wantsOutdoorSeating?: boolean;
}

export interface RankOptions {
  rankBy?: RankBy;
  requirements?: SearchRequirements;
}

// Places reports price as an enum; this is the 0-4 scale NearbyCandidate.priceLevel uses.
const PRICE_LEVELS: Record<string, number> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

export function priceLevelFromPlaces(level: string | undefined): number | undefined {
  return level ? PRICE_LEVELS[level] : undefined;
}

// How well a place meets what was asked for: 'yes' (Places confirms every ask), 'no' (Places says it
// doesn't meet at least one), or 'unknown' (no ask is contradicted, but at least one has no data —
// Places is missing these details for a lot of places, so absence can't be read as "no").
export type RequirementMatch = 'yes' | 'unknown' | 'no';

export function requirementMatch(candidate: NearbyCandidate, requirements: SearchRequirements): RequirementMatch {
  const checks: (boolean | undefined)[] = [];
  if (requirements.wantsCheap) checks.push(candidate.priceLevel === undefined ? undefined : candidate.priceLevel <= 1);
  if (requirements.wantsVegetarian) checks.push(candidate.servesVegetarianFood);
  if (requirements.wantsOutdoorSeating) checks.push(candidate.outdoorSeating);
  if (checks.includes(false)) return 'no';
  return checks.includes(undefined) ? 'unknown' : 'yes';
}

// Confirmed matches sort ahead of unconfirmed ones.
function matchTier(candidate: NearbyCandidate, requirements: SearchRequirements): number {
  return requirementMatch(candidate, requirements) === 'yes' ? 0 : 1;
}

// A rating alone misleads: 5.0 from three reviews isn't better than 4.6 from eight hundred. This
// pulls a thinly reviewed place toward a typical rating, so it takes real volume to rank high.
const TYPICAL_RATING = 4.0;
const TYPICAL_RATING_WEIGHT = 20; // reviews' worth of pull toward the typical rating
export function qualityScore(rating: number | undefined, ratingCount: number | undefined): number {
  const count = ratingCount ?? 0;
  return ((rating ?? TYPICAL_RATING) * count + TYPICAL_RATING * TYPICAL_RATING_WEIGHT) / (count + TYPICAL_RATING_WEIGHT);
}

// A "best" search ignores places with fewer reviews than this (unless that would leave nothing).
export const MIN_REVIEWS_FOR_BEST = 10;

// Which candidates earn a real (expensive) routing call. "Nearest" takes the closest few. "Best"
// can't: the best place is often not among the closest, so it takes the highest quality score
// among everything within range instead. Either way, a place Places says doesn't meet a stated
// ask is dropped, and confirmed matches go first.
export function selectCandidatesForRouting(
  origin: { lat: number; lon: number },
  candidates: NearbyCandidate[],
  options: RankOptions & { maxCandidates?: number; radiusMeters?: number } = {}
): PrunedCandidate[] {
  const { rankBy = 'nearest', requirements = {}, maxCandidates = DEFAULT_MAX_ROUTED_CANDIDATES, radiusMeters = PRUNE_RADIUS_METERS } = options;
  let pool = pruneByStraightLineDistance(origin, candidates, Number.POSITIVE_INFINITY, radiusMeters).filter(
    (c) => requirementMatch(c, requirements) !== 'no'
  );
  if (rankBy === 'best') {
    const reviewed = pool.filter((c) => (c.userRatingCount ?? 0) >= MIN_REVIEWS_FOR_BEST);
    if (reviewed.length > 0) pool = reviewed;
  }
  const quality = (c: NearbyCandidate) => (rankBy === 'best' ? qualityScore(c.rating, c.userRatingCount) : 0);
  return pool
    .sort((a, b) => matchTier(a, requirements) - matchTier(b, requirements) || quality(b) - quality(a) || a.straightLineMeters - b.straightLineMeters)
    .slice(0, maxCandidates);
}

export const DEFAULT_RESULT_LIMIT = 6;

// Final pass, after real routing times are known: drop anything over the time budget when there is
// one, then order — soonest first by default, best rated first for a "best" search, and always
// confirmed matches ahead of unconfirmed ones. maxMinutes is null for a plain "closest X" query with
// no stated limit — the user asked for the closest, not the closest-within-some-number-we-picked, so
// nothing gets filtered out by duration in that case, only ranked.
export function filterAndRankByDuration(
  routed: RoutedCandidate[],
  maxMinutes: number | null,
  limit: number = DEFAULT_RESULT_LIMIT,
  options: RankOptions = {}
): RoutedCandidate[] {
  const { rankBy = 'nearest', requirements = {} } = options;
  const quality = (c: RoutedCandidate) => (rankBy === 'best' ? qualityScore(c.rating, c.userRatingCount) : 0);
  return routed
    .filter((c) => (maxMinutes === null || c.durationMinutes <= maxMinutes) && requirementMatch(c, requirements) !== 'no')
    .sort((a, b) => matchTier(a, requirements) - matchTier(b, requirements) || quality(b) - quality(a) || a.durationMinutes - b.durationMinutes)
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

// What to send Google's Routes API as the departure time. It rejects one that has already passed by
// the time the request arrives, and "open now" resolves to exactly the current moment — so a time
// that is now, or only moments away, is left out, which routes for leaving right now.
export const ROUTING_MIN_LEAD_MS = 60_000;

export function departureForRouting(departure: Date | null, now: Date = new Date()): Date | null {
  return departure !== null && departure.getTime() > now.getTime() + ROUTING_MIN_LEAD_MS ? departure : null;
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

// --- Opening Hours At Arrival ---
// How long the place stays open from `at`, following back-to-back periods (a place open 11-14 and
// 14-22 is open straight through, so a split shift isn't reported as "closes at 14:00"). null when
// there are no hours data or it isn't open at `at`.
export function minutesUntilClosing(periods: OpeningPeriod[] | null, at: Date): number | null {
  if (periods === null) return null;
  const start = minutesSinceWeekStart(at.getDay(), at.getHours(), at.getMinutes());

  // Minutes the period covering `t` (a minute of the week) still has left, or null if none covers it.
  function remainingAt(t: number): number | null {
    let best: number | null = null;
    for (const p of periods!) {
      const openMinutes = minutesSinceWeekStart(p.openDay, p.openHour, p.openMinute);
      let closeMinutes = minutesSinceWeekStart(p.closeDay, p.closeHour, p.closeMinute);
      if (closeMinutes <= openMinutes) closeMinutes += MINUTES_PER_WEEK;
      for (const shifted of [t, t + MINUTES_PER_WEEK]) {
        if (shifted >= openMinutes && shifted < closeMinutes) {
          best = Math.max(best ?? 0, closeMinutes - shifted);
        }
      }
    }
    return best;
  }

  let total = 0;
  for (let i = 0; i <= periods.length; i++) {
    const remaining = remainingAt((start + total) % MINUTES_PER_WEEK);
    if (remaining === null) break;
    total += remaining;
    // Open all week round (a 24/7 place) — nothing to follow, and chaining would only loop.
    if (total >= MINUTES_PER_WEEK) break;
  }
  return total > 0 ? total : null;
}

// Whether the place is open at any point from `from` to `to`. Used before routing, when the
// travel time isn't known yet: a place that opens ten minutes after you set off can still be open
// when you arrive, so only places closed for the whole possible trip are dropped here. Checked at
// ten-minute steps — plenty fine for opening hours, which are on the quarter hour.
export function isOpenDuring(periods: OpeningPeriod[] | null, from: Date, to: Date): boolean {
  if (periods === null) return true;
  const STEP_MS = 10 * 60_000;
  for (let t = from.getTime(); t < to.getTime(); t += STEP_MS) {
    if (isOpenAt(periods, new Date(t))) return true;
  }
  return isOpenAt(periods, to);
}

// Within this long of closing on arrival, the result is flagged rather than simply called open.
export const CLOSING_SOON_MINUTES = 60;

// Annotates a routed result with its opening status at the moment the user would arrive, now that
// the real travel time is known: open/closed on arrival, a heads-up if it closes soon after, and
// the hours line for the day they'd arrive on (a late trip can land after midnight).
export function withArrivalHours<T extends RoutedCandidate>(candidate: T, departure: Date): T {
  const arrival = new Date(departure.getTime() + candidate.durationMinutes * 60_000);
  const periods = candidate.openingPeriods ?? null;
  const isOpen = periods === null ? undefined : isOpenAt(periods, arrival);
  const remaining = isOpen ? minutesUntilClosing(periods, arrival) : null;
  const hoursText = candidate.weekdayDescriptions?.[(arrival.getDay() + 6) % 7];
  return {
    ...candidate,
    isOpenOnArrival: isOpen,
    closesInMinutes: remaining !== null && remaining <= CLOSING_SOON_MINUTES ? remaining : undefined,
    todayHoursText: hoursText,
  };
}
