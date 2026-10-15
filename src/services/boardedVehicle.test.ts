import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KEEP_MISSING_MS,
  matchBoardedVehicle,
  trailCourseDegrees,
  trailSpeedMps,
  trimTrail,
  userPositionAt,
  type TrailFix,
} from './boardedVehicle.ts';
import { angleDifference, bearingDegrees, distanceMeters } from './geo.ts';
import type { VehiclePosition } from '../types.ts';

const METERS_PER_DEGREE_LAT = 111_194.9;
const BASE = { latitude: -36.85, longitude: 174.76 };
const NOW = 1_800_000_000_000;

// A rider going due north at `speed` m/s, one fix every `everyS` seconds, ending at NOW.
function northboundTrail(speed: number, seconds = 120, everyS = 5): TrailFix[] {
  const fixes: TrailFix[] = [];
  for (let s = seconds; s >= 0; s -= everyS) {
    fixes.push({ latitude: BASE.latitude + (speed * (seconds - s)) / METERS_PER_DEGREE_LAT, longitude: BASE.longitude, t: NOW - s * 1000 });
  }
  return fixes;
}

// Where the northbound rider was `secondsAgo` seconds before NOW.
function riderAt(trail: TrailFix[], secondsAgo: number) {
  const pos = userPositionAt(trail, NOW - secondsAgo * 1000);
  assert.ok(pos, 'rider position should be known');
  return pos;
}

function bus(over: Partial<VehiclePosition> & { vehicleId: string }): VehiclePosition {
  return { lat: BASE.latitude, lon: BASE.longitude, mode: 'bus', routeShortName: '70', bearing: 0, ...over };
}

// --- geo ---
test('bearingDegrees: the four compass points', () => {
  const o = { latitude: -36.85, longitude: 174.76 };
  assert.ok(Math.abs(bearingDegrees(o, { latitude: -36.84, longitude: 174.76 }) - 0) < 0.5);
  assert.ok(Math.abs(bearingDegrees(o, { latitude: -36.85, longitude: 174.77 }) - 90) < 0.5);
  assert.ok(Math.abs(bearingDegrees(o, { latitude: -36.86, longitude: 174.76 }) - 180) < 0.5);
  assert.ok(Math.abs(bearingDegrees(o, { latitude: -36.85, longitude: 174.75 }) - 270) < 0.5);
});

test('angleDifference: takes the short way round, signed', () => {
  assert.equal(angleDifference(350, 10), 20);
  assert.equal(angleDifference(10, 350), -20);
  assert.equal(angleDifference(0, 180), 180);
  assert.equal(angleDifference(90, 90), 0);
  assert.equal(angleDifference(0, 270), -90);
});

test('distanceMeters: about 111 km per degree of latitude', () => {
  const d = distanceMeters({ latitude: -37, longitude: 175 }, { latitude: -36, longitude: 175 });
  assert.ok(Math.abs(d - METERS_PER_DEGREE_LAT) < 50);
});

// --- trail ---
test('userPositionAt: interpolates between fixes, and knows what it does not know', () => {
  const trail: TrailFix[] = [
    { latitude: -36.85, longitude: 174.76, t: 1000 },
    { latitude: -36.84, longitude: 174.76, t: 11_000 },
  ];
  const mid = userPositionAt(trail, 6000)!;
  assert.ok(Math.abs(mid.latitude - -36.845) < 1e-9);
  assert.equal(userPositionAt(trail, 500), null, 'before the trail begins');
  assert.deepEqual(userPositionAt(trail, 20_000), trail[1], 'a few seconds after the last fix uses it');
  assert.equal(userPositionAt(trail, 11_000 + 16_000), null, 'too long after the last fix to guess');
  assert.equal(userPositionAt([], 1000), null);
});

test('trailSpeedMps and trailCourseDegrees: read the speed and heading off the trail', () => {
  const trail = northboundTrail(10);
  assert.ok(Math.abs(trailSpeedMps(trail, NOW)! - 10) < 0.2);
  assert.ok(Math.abs(angleDifference(trailCourseDegrees(trail, NOW)!, 0)) < 1);
  assert.equal(trailSpeedMps([trail[0]], NOW), null);
  assert.equal(trailCourseDegrees(northboundTrail(0.1, 60), NOW), null, 'barely moved: no course');
});

test('trimTrail: drops fixes older than the keep window', () => {
  const old: TrailFix = { ...BASE, t: NOW - 6 * 60_000 };
  const fresh: TrailFix = { ...BASE, t: NOW - 60_000 };
  assert.deepEqual(trimTrail([old, fresh], NOW), [fresh]);
  assert.deepEqual(trimTrail([old], NOW), []);
});

// --- matching ---
test('a bus whose report is 20 s old still matches when you were beside it at that moment', () => {
  const trail = northboundTrail(10);
  const where = riderAt(trail, 20);
  const mine = bus({ vehicleId: 'mine', lat: where.latitude, lon: where.longitude, timestampMs: NOW - 20_000 });
  // Compared to where you are NOW, the bus's reported position is ~200 m behind — the old, naive comparison.
  assert.ok(distanceMeters({ latitude: trail[trail.length - 1].latitude, longitude: BASE.longitude }, { latitude: mine.lat, longitude: mine.lon }) > 150);
  const match = matchBoardedVehicle({ trail, vehicles: [mine], lineName: '70', now: NOW });
  assert.equal(match?.vehicleId, 'mine');
  assert.ok(match!.distanceMeters < 5);
});

test('of two buses on your line, the one that was beside you wins', () => {
  const trail = northboundTrail(10);
  const where = riderAt(trail, 10);
  const ahead = bus({ vehicleId: 'ahead', lat: where.latitude + 40 / METERS_PER_DEGREE_LAT, lon: where.longitude, timestampMs: NOW - 10_000 });
  const mine = bus({ vehicleId: 'mine', lat: where.latitude + 8 / METERS_PER_DEGREE_LAT, lon: where.longitude, timestampMs: NOW - 10_000 });
  assert.equal(matchBoardedVehicle({ trail, vehicles: [ahead, mine], lineName: '70', now: NOW })?.vehicleId, 'mine');
});

test('a bus of your line a street away is not yours', () => {
  const trail = northboundTrail(10);
  const where = riderAt(trail, 10);
  const other = bus({ vehicleId: 'other', lat: where.latitude, lon: where.longitude + 0.0015, timestampMs: NOW - 10_000 }); // ~135 m east
  assert.equal(matchBoardedVehicle({ trail, vehicles: [other], lineName: '70', now: NOW }), null);
});

test('a bus going the other way past you is not yours, however close', () => {
  const trail = northboundTrail(10);
  const where = riderAt(trail, 5);
  const oncoming = bus({ vehicleId: 'oncoming', lat: where.latitude, lon: where.longitude + 0.0001, bearing: 180, timestampMs: NOW - 5000 });
  assert.equal(matchBoardedVehicle({ trail, vehicles: [oncoming], lineName: '70', now: NOW }), null);
});

test('only buses of the line you are on are candidates', () => {
  const trail = northboundTrail(10);
  const where = riderAt(trail, 5);
  const wrongLine = bus({ vehicleId: 'x', routeShortName: '25L', lat: where.latitude, lon: where.longitude, timestampMs: NOW - 5000 });
  assert.equal(matchBoardedVehicle({ trail, vehicles: [wrongLine], lineName: '70', now: NOW }), null);
});

test('standing at a stop beside a bus, or walking past one, is not boarding it', () => {
  for (const speed of [0, 1.4]) {
    const trail = northboundTrail(speed, 60);
    const where = riderAt(trail, 3);
    const beside = bus({ vehicleId: 'beside', lat: where.latitude, lon: where.longitude, timestampMs: NOW - 3000 });
    assert.equal(matchBoardedVehicle({ trail, vehicles: [beside], lineName: '70', now: NOW }), null, `speed ${speed}`);
  }
});

test('once matched, the bus stays yours through a stop (you are stationary) and a wobble', () => {
  const stopped = northboundTrail(0, 60);
  const where = riderAt(stopped, 2);
  const mine = bus({ vehicleId: 'mine', lat: where.latitude + 90 / METERS_PER_DEGREE_LAT, lon: where.longitude, timestampMs: NOW - 2000 });
  const match = matchBoardedVehicle({ trail: stopped, vehicles: [mine], lineName: '70', now: NOW, previous: { vehicleId: 'mine', lineName: '70', lastSeenAt: NOW } });
  assert.equal(match?.vehicleId, 'mine');
});

test('a remembered bus stops being yours once it is clearly elsewhere', () => {
  const trail = northboundTrail(10);
  const where = riderAt(trail, 5);
  const gone = bus({ vehicleId: 'old', lat: where.latitude + 400 / METERS_PER_DEGREE_LAT, lon: where.longitude, timestampMs: NOW - 5000 });
  const match = matchBoardedVehicle({ trail, vehicles: [gone], lineName: '70', now: NOW, previous: { vehicleId: 'old', lineName: '70', lastSeenAt: NOW } });
  assert.equal(match, null);
});

test('a remembered bus that drops out of the feed briefly is kept, then given up on', () => {
  const trail = northboundTrail(10);
  const previous = { vehicleId: 'mine', lineName: '70', lastSeenAt: NOW - 30_000 };
  assert.equal(matchBoardedVehicle({ trail, vehicles: [], lineName: '70', now: NOW, previous })?.vehicleId, 'mine');
  const stale = { ...previous, lastSeenAt: NOW - KEEP_MISSING_MS - 1000 };
  assert.equal(matchBoardedVehicle({ trail, vehicles: [], lineName: '70', now: NOW, previous: stale }), null);
});

test('a remembered match for a different line is ignored when you change buses', () => {
  const trail = northboundTrail(10);
  const previous = { vehicleId: 'old-bus', lineName: '25L', lastSeenAt: NOW };
  assert.equal(matchBoardedVehicle({ trail, vehicles: [], lineName: '70', now: NOW, previous }), null);
});

test('a bus with no report time is compared as if it had just reported', () => {
  const trail = northboundTrail(10);
  const here = trail[trail.length - 1];
  const mine = bus({ vehicleId: 'mine', lat: here.latitude, lon: here.longitude });
  assert.equal(matchBoardedVehicle({ trail, vehicles: [mine], lineName: '70', now: NOW })?.vehicleId, 'mine');
});

test('no trail yet (just started), or a report older than the trail, matches nothing new', () => {
  const mine = bus({ vehicleId: 'mine', timestampMs: NOW - 20_000 });
  assert.equal(matchBoardedVehicle({ trail: [], vehicles: [mine], lineName: '70', now: NOW }), null);
  const shortTrail = northboundTrail(10, 10);
  const veryOld = bus({ vehicleId: 'old', timestampMs: NOW - 120_000 });
  assert.equal(matchBoardedVehicle({ trail: shortTrail, vehicles: [veryOld], lineName: '70', now: NOW }), null);
});
