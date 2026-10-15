import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseWalkHeading, pathBearingAhead, smoothHeading } from './walkHeading.ts';
import { afterMove, MIN_MOVE_METERS, planCameraMove, WALKING_ZOOM } from './cameraFollow.ts';
import { angleDifference, type LatLon } from './geo.ts';

const M = 111_194.9; // metres per degree of latitude
const ORIGIN: LatLon = { latitude: -36.85, longitude: 174.76 };
const LON_M = M * Math.cos((ORIGIN.latitude * Math.PI) / 180); // metres per degree of longitude here

// A point `north` metres north and `east` metres east of ORIGIN.
const at = (north: number, east: number): LatLon => ({ latitude: ORIGIN.latitude + north / M, longitude: ORIGIN.longitude + east / LON_M });

// --- pathBearingAhead ---
test('a path running due north faces north', () => {
  const path = [at(0, 0), at(100, 0), at(200, 0)];
  assert.ok(Math.abs(angleDifference(pathBearingAhead(path, at(10, 0))!, 0)) < 1);
});

test('a path running east faces east', () => {
  const path = [at(0, 0), at(0, 200)];
  assert.ok(Math.abs(angleDifference(pathBearingAhead(path, at(0, 50))!, 90)) < 1);
});

test('shortly before a corner the map has already begun to turn into it', () => {
  // North for 100 m, then east. 10 m before the corner, the 25 m look-ahead reaches 15 m past the corner.
  const path = [at(0, 0), at(100, 0), at(100, 100)];
  const bearing = pathBearingAhead(path, at(90, 0))!;
  assert.ok(bearing > 40 && bearing < 70, `expected a partial turn toward east, got ${bearing}`);
  // Well before the corner it still faces north; well after, east.
  assert.ok(Math.abs(angleDifference(pathBearingAhead(path, at(20, 0))!, 0)) < 1);
  assert.ok(Math.abs(angleDifference(pathBearingAhead(path, at(100, 40))!, 90)) < 1);
});

test('a left turn is a turn to the left: heading goes anticlockwise', () => {
  const path = [at(0, 0), at(100, 0), at(100, -100)]; // north, then west
  const before = pathBearingAhead(path, at(20, 0))!;
  const approaching = pathBearingAhead(path, at(90, 0))!;
  assert.ok(angleDifference(before, approaching) < -20, `heading should swing left (negative), got ${angleDifference(before, approaching)}`);
});

test('at the end of the path it keeps the direction of the last stretch', () => {
  const path = [at(0, 0), at(0, 100)];
  assert.ok(Math.abs(angleDifference(pathBearingAhead(path, at(0, 99))!, 90)) < 1);
  assert.ok(Math.abs(angleDifference(pathBearingAhead(path, at(0, 100))!, 90)) < 1);
});

test('too far from the path, or no path, says nothing', () => {
  const path = [at(0, 0), at(200, 0)];
  assert.equal(pathBearingAhead(path, at(100, 80)), null);
  assert.equal(pathBearingAhead([at(0, 0)], at(0, 0)), null);
  assert.equal(pathBearingAhead([], at(0, 0)), null);
});

// --- chooseWalkHeading ---
test('on the path, its direction wins over the phone\'s heading', () => {
  const path = [at(0, 0), at(200, 0)];
  const heading = chooseWalkHeading({ path, position: at(50, 0), gpsHeading: 200, speedMps: 1.4 });
  assert.ok(Math.abs(angleDifference(heading!, 0)) < 1);
});

test('off the path, a moving phone\'s heading is used', () => {
  const path = [at(0, 0), at(200, 0)];
  assert.equal(chooseWalkHeading({ path, position: at(50, 120), gpsHeading: 135, speedMps: 1.4 }), 135);
});

test('off the path and standing still, or with no heading, leaves the map alone', () => {
  const path = [at(0, 0), at(200, 0)];
  assert.equal(chooseWalkHeading({ path, position: at(50, 120), gpsHeading: 135, speedMps: 0.1 }), null);
  assert.equal(chooseWalkHeading({ path, position: at(50, 120), gpsHeading: null, speedMps: 1.4 }), null);
  assert.equal(chooseWalkHeading({ path, position: at(50, 120), gpsHeading: -1, speedMps: 1.4 }), null);
});

// --- smoothHeading ---
test('smoothHeading: the first heading is taken as is; later ones ease toward the target', () => {
  assert.equal(smoothHeading(null, 90), 90);
  const step = smoothHeading(0, 90);
  assert.ok(step > 55 && step < 90, `most of the way, but not all of it, got ${step}`);
  // Two updates in, a 90° turn is essentially done — the map must not lag a block behind the walker.
  assert.ok(smoothHeading(step, 90) > 85);
});

test('smoothHeading: takes the short way round the compass', () => {
  const eased = smoothHeading(350, 20);
  assert.ok(eased >= 350 || eased <= 20, `should pass through north, got ${eased}`);
  assert.ok(Math.abs(angleDifference(eased, 20)) < Math.abs(angleDifference(350, 20)));
});

test('smoothHeading: wobbles inside the dead band are ignored', () => {
  assert.equal(smoothHeading(100, 102), 100);
});

// --- planCameraMove ---
test('the first fix always moves the camera to you', () => {
  const plan = planCameraMove({ last: null, position: at(0, 0), heading: null, zoomIn: false });
  assert.deepEqual(plan, { center: at(0, 0) });
});

test('standing still, nothing moves; walking a few metres does', () => {
  const last = afterMove(at(0, 0), null);
  assert.equal(planCameraMove({ last, position: at(1, 1), heading: null, zoomIn: false }), null);
  assert.ok(planCameraMove({ last, position: at(MIN_MOVE_METERS + 2, 0), heading: null, zoomIn: false }));
});

test('facing a direction rotates the map and zooms in only the first time', () => {
  const first = planCameraMove({ last: afterMove(at(0, 0), null), position: at(10, 0), heading: 45, zoomIn: true })!;
  assert.equal(first.heading, 45);
  assert.equal(first.pitch, 0);
  assert.equal(first.zoom, WALKING_ZOOM);
  const next = planCameraMove({ last: afterMove(at(10, 0), 45), position: at(20, 0), heading: 50, zoomIn: false })!;
  assert.equal(next.zoom, undefined, 'the user\'s own zoom is left alone after the first move');
  assert.equal(next.heading, 50);
});

test('a small heading wobble alone does not move the camera, a real turn does', () => {
  const last = afterMove(at(0, 0), 90);
  assert.equal(planCameraMove({ last, position: at(0, 0), heading: 93, zoomIn: false }), null);
  assert.equal(planCameraMove({ last, position: at(0, 0), heading: 110, zoomIn: false })?.heading, 110);
});

test('when the walk ends the map turns back to north-up once, and not again', () => {
  const rotated = afterMove(at(0, 0), 120);
  const reset = planCameraMove({ last: rotated, position: at(0, 0), heading: null, zoomIn: false })!;
  assert.equal(reset.heading, 0);
  assert.equal(planCameraMove({ last: afterMove(at(0, 0), null), position: at(0, 0), heading: null, zoomIn: false }), null);
});
