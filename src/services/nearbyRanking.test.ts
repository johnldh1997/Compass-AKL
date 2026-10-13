import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceMeters,
  pruneByStraightLineDistance,
  chooseTravelMode,
  filterAndRankByDuration,
  resolveTargetDateTime,
  isOpenAt,
  isOpenDuring,
  minutesUntilClosing,
  withArrivalHours,
  qualityScore,
  departureForRouting,
  mergeCandidates,
  placeTypesFor,
  requirementMatch,
  priceLevelFromPlaces,
  selectCandidatesForRouting,
  type NearbyCandidate,
  type RoutedCandidate,
  type TargetDay,
  type OpeningPeriod,
} from './nearbyRanking.ts';

const USER = { lat: -36.8485, lon: 174.7633 }; // Sky Tower area

test('distanceMeters: same point is zero', () => {
  assert.equal(distanceMeters(USER, USER), 0);
});

test('distanceMeters: known ~1.1km separation (roughly Britomart to Sky Tower)', () => {
  const britomart = { lat: -36.8443, lon: 174.7645 };
  const d = distanceMeters(USER, britomart);
  assert.ok(d > 400 && d < 700, `expected ~400-700m, got ${d}`);
});

test('pruneByStraightLineDistance: drops anything past the radius', () => {
  const near = { id: 'a', name: 'Near', lat: -36.85, lon: 174.764 };
  const far = { id: 'b', name: 'Far (Hamilton)', lat: -37.787, lon: 175.279 };
  const result = pruneByStraightLineDistance(USER, [near, far], 8, 6000);
  assert.deepEqual(
    result.map((r) => r.id),
    ['a']
  );
});

test('pruneByStraightLineDistance: sorts closest-first and caps at maxCandidates', () => {
  const candidates = [
    { id: 'far', name: 'Far', lat: -36.86, lon: 174.78 },
    { id: 'near', name: 'Near', lat: -36.849, lon: 174.764 },
    { id: 'mid', name: 'Mid', lat: -36.855, lon: 174.77 },
  ];
  const result = pruneByStraightLineDistance(USER, candidates, 2);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 'near');
  assert.ok(result[0].straightLineMeters < result[1].straightLineMeters);
});

test('chooseTravelMode: short distance walks, long distance transits', () => {
  assert.equal(chooseTravelMode(400), 'WALK');
  assert.equal(chooseTravelMode(1500), 'WALK'); // at the threshold, still walkable
  assert.equal(chooseTravelMode(1501), 'TRANSIT');
  assert.equal(chooseTravelMode(5000), 'TRANSIT');
});

test('filterAndRankByDuration: drops over-budget results and sorts soonest-first', () => {
  const routed = [
    { id: 'a', name: 'A', lat: 0, lon: 0, straightLineMeters: 900, durationMinutes: 25, mode: 'WALK' as const },
    { id: 'b', name: 'B', lat: 0, lon: 0, straightLineMeters: 1800, durationMinutes: 12, mode: 'TRANSIT' as const },
    { id: 'c', name: 'C', lat: 0, lon: 0, straightLineMeters: 600, durationMinutes: 8, mode: 'WALK' as const },
  ];
  const result = filterAndRankByDuration(routed, 20);
  assert.deepEqual(
    result.map((r) => r.id),
    ['c', 'b']
  );
});

test('filterAndRankByDuration: respects the limit', () => {
  const routed = Array.from({ length: 10 }, (_, i) => ({
    id: String(i),
    name: String(i),
    lat: 0,
    lon: 0,
    straightLineMeters: 100,
    durationMinutes: i,
    mode: 'WALK' as const,
  }));
  const result = filterAndRankByDuration(routed, 20, 3);
  assert.equal(result.length, 3);
});

test('filterAndRankByDuration: null maxMinutes keeps everything, just ranked', () => {
  const routed = [
    { id: 'a', name: 'A', lat: 0, lon: 0, straightLineMeters: 900, durationMinutes: 45, mode: 'TRANSIT' as const },
    { id: 'b', name: 'B', lat: 0, lon: 0, straightLineMeters: 1800, durationMinutes: 12, mode: 'TRANSIT' as const },
  ];
  const result = filterAndRankByDuration(routed, null);
  assert.deepEqual(
    result.map((r) => r.id),
    ['b', 'a']
  );
});

test('resolveTargetDateTime: no day and no time at all means "now" (null)', () => {
  const now = new Date(2026, 8, 29, 10, 0, 0);
  assert.equal(resolveTargetDateTime(now, null, null, null), null);
});

test('resolveTargetDateTime: tomorrow at a given time', () => {
  const now = new Date(2026, 8, 29, 10, 0, 0);
  const result = resolveTargetDateTime(now, 'tomorrow', 17, 0);
  assert.equal(result?.getDate(), 30);
  assert.equal(result?.getHours(), 17);
  assert.equal(result?.getMinutes(), 0);
});

test('resolveTargetDateTime: a stated time later today, with no day, stays today', () => {
  const now = new Date(2026, 8, 29, 10, 0, 0);
  const result = resolveTargetDateTime(now, null, 17, 0);
  assert.equal(result?.getDate(), 29);
  assert.equal(result?.getHours(), 17);
});

test('resolveTargetDateTime: a stated time already passed today, with no day, rolls to tomorrow', () => {
  const now = new Date(2026, 8, 29, 20, 0, 0);
  const result = resolveTargetDateTime(now, null, 17, 0);
  assert.equal(result?.getDate(), 30);
  assert.equal(result?.getHours(), 17);
});

test('resolveTargetDateTime: an explicit "today" is kept even if that time already passed', () => {
  const now = new Date(2026, 8, 29, 20, 0, 0);
  const result = resolveTargetDateTime(now, 'today', 17, 0);
  assert.equal(result?.getDate(), 29);
  assert.equal(result?.getHours(), 17);
});

test('resolveTargetDateTime: naming the current weekday means next week, not today', () => {
  const now = new Date(2026, 8, 29, 10, 0, 0);
  const dayNames: TargetDay[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const todayName = dayNames[now.getDay()];
  const result = resolveTargetDateTime(now, todayName, 12, 0);
  const expected = new Date(now);
  expected.setDate(expected.getDate() + 7);
  expected.setHours(12, 0, 0, 0);
  assert.equal(result?.getTime(), expected.getTime());
});

test('resolveTargetDateTime: a day with no time keeps the current time-of-day', () => {
  const now = new Date(2026, 8, 29, 10, 30, 0);
  const result = resolveTargetDateTime(now, 'tomorrow', null, null);
  assert.equal(result?.getDate(), 30);
  assert.equal(result?.getHours(), 10);
  assert.equal(result?.getMinutes(), 30);
});

test('isOpenAt: null periods (no data) is treated as open, not closed', () => {
  assert.equal(isOpenAt(null, new Date(2026, 8, 29, 12, 0)), true);
});

test('isOpenAt: within a normal same-day period', () => {
  const periods: OpeningPeriod[] = [{ openDay: 2, openHour: 9, openMinute: 0, closeDay: 2, closeHour: 17, closeMinute: 0 }]; // Tuesday 9-5
  const tuesdayNoon = new Date(2026, 8, 29, 12, 0); // 2026-09-29 is a Tuesday
  assert.equal(isOpenAt(periods, tuesdayNoon), true);
});

test('isOpenAt: outside a normal same-day period', () => {
  const periods: OpeningPeriod[] = [{ openDay: 2, openHour: 9, openMinute: 0, closeDay: 2, closeHour: 17, closeMinute: 0 }];
  const tuesdayEvening = new Date(2026, 8, 29, 20, 0);
  assert.equal(isOpenAt(periods, tuesdayEvening), false);
});

test('isOpenAt: a different day entirely is closed', () => {
  const periods: OpeningPeriod[] = [{ openDay: 2, openHour: 9, openMinute: 0, closeDay: 2, closeHour: 17, closeMinute: 0 }];
  const wednesdayNoon = new Date(2026, 8, 30, 12, 0);
  assert.equal(isOpenAt(periods, wednesdayNoon), false);
});

test('isOpenAt: an overnight period is open just after midnight', () => {
  // Friday 22:00 - Saturday 02:00
  const periods: OpeningPeriod[] = [{ openDay: 5, openHour: 22, openMinute: 0, closeDay: 6, closeHour: 2, closeMinute: 0 }];
  const saturdayAt1am = new Date(2026, 9, 3, 1, 0); // 2026-10-03 is a Saturday
  assert.equal(isOpenAt(periods, saturdayAt1am), true);
});

test('isOpenAt: an overnight period is closed well after it ends', () => {
  const periods: OpeningPeriod[] = [{ openDay: 5, openHour: 22, openMinute: 0, closeDay: 6, closeHour: 2, closeMinute: 0 }];
  const saturdayAtNoon = new Date(2026, 9, 3, 12, 0);
  assert.equal(isOpenAt(periods, saturdayAtNoon), false);
});

// --- Opening Hours At Arrival ---
const TUESDAY_9_TO_5: OpeningPeriod[] = [{ openDay: 2, openHour: 9, openMinute: 0, closeDay: 2, closeHour: 17, closeMinute: 0 }];

function routed(overrides: Partial<RoutedCandidate>): RoutedCandidate {
  return { id: 'p', name: 'Place', lat: 0, lon: 0, straightLineMeters: 1000, durationMinutes: 20, mode: 'WALK', ...overrides };
}

test('minutesUntilClosing: counts down to the closing time', () => {
  assert.equal(minutesUntilClosing(TUESDAY_9_TO_5, new Date(2026, 8, 29, 16, 30)), 30);
});

test('minutesUntilClosing: null when it is closed, or there is no hours data', () => {
  assert.equal(minutesUntilClosing(TUESDAY_9_TO_5, new Date(2026, 8, 29, 18, 0)), null);
  assert.equal(minutesUntilClosing(null, new Date(2026, 8, 29, 12, 0)), null);
});

test('minutesUntilClosing: an overnight period counts across midnight', () => {
  const periods: OpeningPeriod[] = [{ openDay: 5, openHour: 22, openMinute: 0, closeDay: 6, closeHour: 2, closeMinute: 0 }];
  assert.equal(minutesUntilClosing(periods, new Date(2026, 9, 3, 1, 15)), 45); // Saturday 01:15, closes 02:00
});

test('minutesUntilClosing: back-to-back periods (a split shift) are one stretch of being open', () => {
  const periods: OpeningPeriod[] = [
    { openDay: 2, openHour: 11, openMinute: 0, closeDay: 2, closeHour: 14, closeMinute: 0 },
    { openDay: 2, openHour: 14, openMinute: 0, closeDay: 2, closeHour: 22, closeMinute: 0 },
  ];
  assert.equal(minutesUntilClosing(periods, new Date(2026, 8, 29, 13, 30)), 8 * 60 + 30);
});

test('minutesUntilClosing: a gap between periods is still a closing time', () => {
  const periods: OpeningPeriod[] = [
    { openDay: 2, openHour: 11, openMinute: 0, closeDay: 2, closeHour: 14, closeMinute: 0 },
    { openDay: 2, openHour: 17, openMinute: 0, closeDay: 2, closeHour: 22, closeMinute: 0 },
  ];
  assert.equal(minutesUntilClosing(periods, new Date(2026, 8, 29, 13, 30)), 30);
});

test('minutesUntilClosing: an always-open place never reads as closing soon', () => {
  const periods: OpeningPeriod[] = [{ openDay: 0, openHour: 0, openMinute: 0, closeDay: 0, closeHour: 0, closeMinute: 0 }];
  const remaining = minutesUntilClosing(periods, new Date(2026, 8, 29, 12, 0));
  assert.ok(remaining !== null && remaining > 24 * 60, `expected well over a day, got ${remaining}`);
});

test('isOpenDuring: a place that opens before the end of the window counts', () => {
  const from = new Date(2026, 8, 29, 8, 50);
  assert.equal(isOpenDuring(TUESDAY_9_TO_5, from, new Date(2026, 8, 29, 9, 20)), true);
});

test('isOpenDuring: closed for the whole window is out; no data is never out', () => {
  assert.equal(isOpenDuring(TUESDAY_9_TO_5, new Date(2026, 8, 29, 18, 0), new Date(2026, 8, 29, 19, 0)), false);
  assert.equal(isOpenDuring(null, new Date(2026, 8, 29, 18, 0), new Date(2026, 8, 29, 19, 0)), true);
});

test('withArrivalHours: open when you leave but closed by the time you arrive is closed', () => {
  // Closes at 17:10; leave at 17:00 with a 20 minute walk -> arrive 17:20, ten minutes too late.
  const periods: OpeningPeriod[] = [{ openDay: 2, openHour: 9, openMinute: 0, closeDay: 2, closeHour: 17, closeMinute: 10 }];
  const departure = new Date(2026, 8, 29, 17, 0);
  assert.equal(isOpenAt(periods, departure), true);
  const result = withArrivalHours(routed({ openingPeriods: periods, durationMinutes: 20 }), departure);
  assert.equal(result.isOpenOnArrival, false);
  assert.equal(result.closesInMinutes, undefined);
});

test('withArrivalHours: open on arrival but closing soon says how long you would have', () => {
  const periods: OpeningPeriod[] = [{ openDay: 2, openHour: 9, openMinute: 0, closeDay: 2, closeHour: 17, closeMinute: 40 }];
  const result = withArrivalHours(routed({ openingPeriods: periods, durationMinutes: 20 }), new Date(2026, 8, 29, 17, 0));
  assert.equal(result.isOpenOnArrival, true);
  assert.equal(result.closesInMinutes, 20);
});

test('withArrivalHours: plenty of time left is just open, with no closing warning', () => {
  const result = withArrivalHours(routed({ openingPeriods: TUESDAY_9_TO_5, durationMinutes: 20 }), new Date(2026, 8, 29, 12, 0));
  assert.equal(result.isOpenOnArrival, true);
  assert.equal(result.closesInMinutes, undefined);
});

test('withArrivalHours: a place Google has no hours for gets no open/closed claim at all', () => {
  const result = withArrivalHours(routed({ openingPeriods: null }), new Date(2026, 8, 29, 12, 0));
  assert.equal(result.isOpenOnArrival, undefined);
  assert.equal(result.closesInMinutes, undefined);
});

test('withArrivalHours: the hours line is for the day you arrive, even past midnight', () => {
  const weekdayDescriptions = ['Monday: a', 'Tuesday: b', 'Wednesday: c', 'Thursday: d', 'Friday: e', 'Saturday: f', 'Sunday: g'];
  // Leave Tuesday 23:50, a 30 minute trip lands on Wednesday.
  const result = withArrivalHours(routed({ weekdayDescriptions, durationMinutes: 30 }), new Date(2026, 8, 29, 23, 50));
  assert.equal(result.todayHoursText, 'Wednesday: c');
});

// --- Best Rating & Requirements ---
// ~0.0027 degrees of latitude is ~300 m, so these sit at known distances from USER.
function place(id: string, metersNorth: number, extra: Partial<NearbyCandidate> = {}): NearbyCandidate {
  return { id, name: id, lat: USER.lat + metersNorth / 111_000, lon: USER.lon, ...extra };
}

test('qualityScore: a thin 5.0 does not beat a well-reviewed 4.6', () => {
  assert.ok(qualityScore(4.6, 800) > qualityScore(5.0, 3));
});

test('qualityScore: more reviews at the same rating scores higher', () => {
  assert.ok(qualityScore(4.5, 400) > qualityScore(4.5, 15));
});

test('selectCandidatesForRouting: "nearest" takes the closest place', () => {
  const candidates = [place('close', 100, { rating: 3.9, userRatingCount: 200 }), place('great', 900, { rating: 4.8, userRatingCount: 600 })];
  const picked = selectCandidatesForRouting(USER, candidates, { rankBy: 'nearest', maxCandidates: 1 });
  assert.deepEqual(picked.map((c) => c.id), ['close']);
});

test('selectCandidatesForRouting: "best" picks a higher-rated place than the closest one', () => {
  const candidates = [place('close', 100, { rating: 3.9, userRatingCount: 200 }), place('great', 900, { rating: 4.8, userRatingCount: 600 })];
  const picked = selectCandidatesForRouting(USER, candidates, { rankBy: 'best', maxCandidates: 1 });
  assert.deepEqual(picked.map((c) => c.id), ['great']);
});

test('selectCandidatesForRouting: "best" ignores thinly reviewed places while better evidence exists', () => {
  const candidates = [place('thin', 100, { rating: 5.0, userRatingCount: 3 }), place('solid', 500, { rating: 4.4, userRatingCount: 300 })];
  const picked = selectCandidatesForRouting(USER, candidates, { rankBy: 'best', maxCandidates: 2 });
  assert.deepEqual(picked.map((c) => c.id), ['solid']);
});

test('selectCandidatesForRouting: "best" still returns something when nothing has enough reviews', () => {
  const candidates = [place('a', 100, { rating: 4.5, userRatingCount: 4 }), place('b', 300, { rating: 4.9, userRatingCount: 2 })];
  const picked = selectCandidatesForRouting(USER, candidates, { rankBy: 'best', maxCandidates: 2 });
  assert.equal(picked.length, 2);
});

test('selectCandidatesForRouting: still honours the search radius', () => {
  const candidates = [place('near', 500, { rating: 4.0, userRatingCount: 50 }), place('far', 9000, { rating: 5.0, userRatingCount: 900 })];
  const picked = selectCandidatesForRouting(USER, candidates, { rankBy: 'best', radiusMeters: 6000 });
  assert.deepEqual(picked.map((c) => c.id), ['near']);
});

test('requirementMatch: nothing asked for is always a match', () => {
  assert.equal(requirementMatch(place('a', 100), {}), 'yes');
});

test('requirementMatch: cheap is confirmed, contradicted or unknown by price level', () => {
  assert.equal(requirementMatch(place('a', 100, { priceLevel: 1 }), { wantsCheap: true }), 'yes');
  assert.equal(requirementMatch(place('a', 100, { priceLevel: 3 }), { wantsCheap: true }), 'no');
  assert.equal(requirementMatch(place('a', 100), { wantsCheap: true }), 'unknown');
});

test('requirementMatch: one contradicted ask is a no, however many others are confirmed', () => {
  const p = place('a', 100, { servesVegetarianFood: true, outdoorSeating: false });
  assert.equal(requirementMatch(p, { wantsVegetarian: true, wantsOutdoorSeating: true }), 'no');
});

test('requirementMatch: a confirmed ask plus an unknown one is unknown, not yes', () => {
  const p = place('a', 100, { servesVegetarianFood: true });
  assert.equal(requirementMatch(p, { wantsVegetarian: true, wantsOutdoorSeating: true }), 'unknown');
});

test('selectCandidatesForRouting: drops places Places says do not match, and puts confirmed ones first', () => {
  const candidates = [
    place('unknown-close', 100),
    place('not-veg', 150, { servesVegetarianFood: false }),
    place('veg-further', 700, { servesVegetarianFood: true }),
  ];
  const picked = selectCandidatesForRouting(USER, candidates, { requirements: { wantsVegetarian: true } });
  assert.deepEqual(picked.map((c) => c.id), ['veg-further', 'unknown-close']);
});

test('filterAndRankByDuration: "best" orders by quality within the time budget', () => {
  const routed: RoutedCandidate[] = [
    { ...place('quick', 100, { rating: 3.8, userRatingCount: 300 }), straightLineMeters: 100, durationMinutes: 3, mode: 'WALK' },
    { ...place('great', 600, { rating: 4.8, userRatingCount: 500 }), straightLineMeters: 600, durationMinutes: 9, mode: 'WALK' },
    { ...place('too-far', 900, { rating: 5.0, userRatingCount: 900 }), straightLineMeters: 900, durationMinutes: 25, mode: 'WALK' },
  ];
  const ranked = filterAndRankByDuration(routed, 15, 6, { rankBy: 'best' });
  assert.deepEqual(ranked.map((c) => c.id), ['great', 'quick']);
});

test('filterAndRankByDuration: confirmed matches come ahead of unconfirmed ones, even if further', () => {
  const routed: RoutedCandidate[] = [
    { ...place('unknown', 100), straightLineMeters: 100, durationMinutes: 3, mode: 'WALK' },
    { ...place('confirmed', 600, { outdoorSeating: true }), straightLineMeters: 600, durationMinutes: 9, mode: 'WALK' },
  ];
  const ranked = filterAndRankByDuration(routed, null, 6, { requirements: { wantsOutdoorSeating: true } });
  assert.deepEqual(ranked.map((c) => c.id), ['confirmed', 'unknown']);
});

test('priceLevelFromPlaces: maps the Places enum to 0-4, and leaves unknowns unknown', () => {
  assert.equal(priceLevelFromPlaces('PRICE_LEVEL_INEXPENSIVE'), 1);
  assert.equal(priceLevelFromPlaces('PRICE_LEVEL_VERY_EXPENSIVE'), 4);
  assert.equal(priceLevelFromPlaces('PRICE_LEVEL_UNSPECIFIED'), undefined);
  assert.equal(priceLevelFromPlaces(undefined), undefined);
});

// --- Routing Departure Time ---
test('departureForRouting: "open now" (the current moment) is routed as leaving now', () => {
  const now = new Date(2026, 9, 12, 11, 48, 30);
  assert.equal(departureForRouting(new Date(now), now), null);
});

test('departureForRouting: a time that has just passed or is seconds away is routed as now', () => {
  const now = new Date(2026, 9, 12, 11, 48, 30);
  assert.equal(departureForRouting(new Date(2026, 9, 12, 11, 48, 0), now), null);
  assert.equal(departureForRouting(new Date(2026, 9, 12, 11, 49, 0), now), null);
});

test('departureForRouting: a genuinely future time is kept', () => {
  const now = new Date(2026, 9, 12, 11, 48, 30);
  const later = new Date(2026, 9, 13, 17, 0, 0);
  assert.equal(departureForRouting(later, now), later);
});

test('departureForRouting: no stated time stays no time', () => {
  assert.equal(departureForRouting(null), null);
});

// --- Candidate Sources ---
test('mergeCandidates: a place found both ways is kept once, the first copy', () => {
  const byWords = [place('barrel', 206, { rating: 4.0 }), place('burgerfuel', 332)];
  const byType = [place('mcdonalds', 237), place('burgerfuel', 332, { rating: 4.5 })];
  const merged = mergeCandidates(byWords, byType);
  assert.deepEqual(merged.map((c) => c.id), ['barrel', 'burgerfuel', 'mcdonalds']);
  assert.equal(merged[1].rating, undefined);
});

test('mergeCandidates: an empty list on either side leaves the other as it was', () => {
  const list = [place('a', 100), place('b', 200)];
  assert.deepEqual(mergeCandidates(list, []), list);
  assert.deepEqual(mergeCandidates([], list), list);
  assert.deepEqual(mergeCandidates(), []);
});

test('placeTypesFor: coffee and cafe mean both; any other type is just itself', () => {
  assert.deepEqual(placeTypesFor('coffee_shop'), ['coffee_shop', 'cafe']);
  assert.deepEqual(placeTypesFor('cafe'), ['cafe', 'coffee_shop']);
  assert.deepEqual(placeTypesFor('hamburger_restaurant'), ['hamburger_restaurant']);
});

test('filterAndRankByDuration: equally close places are ordered by how well known they are', () => {
  const routed: RoutedCandidate[] = [
    { ...place('unreviewed', 209), straightLineMeters: 209, durationMinutes: 4, mode: 'WALK' },
    { ...place('few', 206, { userRatingCount: 132 }), straightLineMeters: 206, durationMinutes: 4, mode: 'WALK' },
    { ...place('chain', 237, { userRatingCount: 3625 }), straightLineMeters: 237, durationMinutes: 4, mode: 'WALK' },
    { ...place('nearer', 100), straightLineMeters: 100, durationMinutes: 2, mode: 'WALK' },
  ];
  assert.deepEqual(filterAndRankByDuration(routed, null).map((c) => c.id), ['nearer', 'chain', 'few', 'unreviewed']);
  // With room for only two, the well-known place gets the second row, not the unreviewed one.
  assert.deepEqual(filterAndRankByDuration(routed, null, 2).map((c) => c.id), ['nearer', 'chain']);
});

test('filterAndRankByDuration: being better known never beats being closer', () => {
  const routed: RoutedCandidate[] = [
    { ...place('far-famous', 900, { userRatingCount: 9000 }), straightLineMeters: 900, durationMinutes: 11, mode: 'WALK' },
    { ...place('near-obscure', 300), straightLineMeters: 300, durationMinutes: 4, mode: 'WALK' },
  ];
  assert.deepEqual(filterAndRankByDuration(routed, null).map((c) => c.id), ['near-obscure', 'far-famous']);
});
