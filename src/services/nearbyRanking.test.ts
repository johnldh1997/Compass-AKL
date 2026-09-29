import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceMeters,
  pruneByStraightLineDistance,
  chooseTravelMode,
  filterAndRankByDuration,
  resolveTargetDateTime,
  isOpenAt,
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
