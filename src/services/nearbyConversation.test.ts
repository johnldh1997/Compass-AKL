import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findSavedPlace,
  journeyStopFromRoute,
  mapsUrlFor,
  pickActionTarget,
  recentTurnsFrom,
  savedPlaceLabel,
  savedPlaceLabels,
  toShownResults,
} from './nearbyConversation.ts';
import type { FavoritePlace, JourneyRoute, TransitStep } from '../types.ts';
import type { RoutedCandidate } from './nearbyRanking.ts';

function routed(overrides: Partial<RoutedCandidate> = {}): RoutedCandidate {
  return { id: 'p', name: 'Place', lat: -36.84, lon: 174.76, straightLineMeters: 500, durationMinutes: 6, mode: 'WALK', ...overrides };
}

function place(label: string, nickname?: string): FavoritePlace {
  return {
    id: `place:${label}`,
    endpoint: { kind: 'coordinates', lat: -36.85, lon: 174.76, label },
    addedAt: 1,
    ...(nickname !== undefined ? { nickname } : {}),
  };
}

// --- Results On Screen ---
test('toShownResults: carries only what is known, and maps hours to open / closes soon / closed', () => {
  const [open, soon, closed, unknown] = toShownResults([
    routed({ name: 'A', rating: 4.6, userRatingCount: 300, priceLevel: 2, servesVegetarianFood: true, outdoorSeating: true, isOpenOnArrival: true }),
    routed({ name: 'B', isOpenOnArrival: true, closesInMinutes: 20 }),
    routed({ name: 'C', isOpenOnArrival: false }),
    routed({ name: 'D', mode: 'TRANSIT', routeShortName: '75' }),
  ]);
  assert.deepEqual(open, {
    name: 'A',
    minutes: 6,
    mode: 'WALK',
    rating: 4.6,
    ratingCount: 300,
    priceLevel: 2,
    vegetarian: true,
    outdoorSeating: true,
    hours: 'open',
  });
  assert.equal(soon.hours, 'closes soon');
  assert.equal(closed.hours, 'closed');
  assert.deepEqual(unknown, { name: 'D', minutes: 6, mode: 'TRANSIT', route: '75' });
});

test('toShownResults: a place with no menu data does not claim it lacks vegetarian food', () => {
  const [result] = toShownResults([routed({ servesVegetarianFood: false })]);
  assert.equal('vegetarian' in result, false);
});

// --- Actions ---
test('pickActionTarget: a valid 1-based position becomes a 0-based index', () => {
  assert.equal(pickActionTarget(1, 6), 0);
  assert.equal(pickActionTarget(6, 6), 5);
});

test('pickActionTarget: "could not tell" (0), out of range, missing or fractional are all no target', () => {
  assert.equal(pickActionTarget(0, 6), null);
  assert.equal(pickActionTarget(7, 6), null);
  assert.equal(pickActionTarget(-1, 6), null);
  assert.equal(pickActionTarget(undefined, 6), null);
  assert.equal(pickActionTarget(2.5, 6), null);
  assert.equal(pickActionTarget(1, 0), null);
});

test('mapsUrlFor: uses Places\' own link, else a coordinate search link', () => {
  assert.equal(mapsUrlFor({ name: 'X', lat: 1, lon: 2, mapsUri: 'https://maps.google.com/?cid=1' }), 'https://maps.google.com/?cid=1');
  assert.equal(mapsUrlFor({ name: 'X', lat: -36.84, lon: 174.76 }), 'https://www.google.com/maps/search/?api=1&query=-36.84,174.76');
});

// --- Saved Places ---
test('savedPlaceLabel: a nickname wins over the place\'s own label; blank means none', () => {
  assert.equal(savedPlaceLabel(place('Spark Arena', 'Work')), 'Work');
  assert.equal(savedPlaceLabel(place('Spark Arena')), 'Spark Arena');
  assert.equal(savedPlaceLabel(place('Spark Arena', '   ')), 'Spark Arena');
});

test('savedPlaceLabels: each name once, in saved order — and only names the user gave', () => {
  const labels = savedPlaceLabels([
    place('Spark Arena', 'Work'),
    place('Les Mills', 'Gym'),
    place('Work Cafe', 'Work'),
    place('71 Victoria Street West'),
    place('Blank', '   '),
  ]);
  assert.deepEqual(labels, ['Work', 'Gym']);
});

test('findSavedPlace: matches the label ignoring case and surrounding space', () => {
  const places = [place('Spark Arena', 'Work'), place('Les Mills', 'Gym')];
  assert.equal(findSavedPlace('  work ', places)?.endpoint.label, 'Spark Arena');
  assert.equal(findSavedPlace('GYM', places)?.endpoint.label, 'Les Mills');
});

test('findSavedPlace: no match, or an empty label, is no place', () => {
  const places = [place('Spark Arena', 'Work')];
  assert.equal(findSavedPlace('school', places), null);
  assert.equal(findSavedPlace('', places), null);
});

test('findSavedPlace: a place that was never named is not found by its own label', () => {
  assert.equal(findSavedPlace('Spark Arena', [place('Spark Arena')]), null);
});

// --- Where A Trip Ends ---
function transit(arrivalName: string | undefined, arrivalTimestamp: string | undefined): TransitStep {
  return {
    kind: 'transit',
    instruction: 'Bus',
    ...(arrivalName ? { arrivalStop: { name: arrivalName, lat: -36.9, lon: 174.8 } } : {}),
    ...(arrivalTimestamp ? { arrivalTimestamp } : {}),
  };
}
const walk: TransitStep = { kind: 'walk', instruction: 'Walk', durationSeconds: 300 };

test('journeyStopFromRoute: the last transit leg\'s alighting stop and arrival time', () => {
  const route: JourneyRoute = {
    durationText: '40 min',
    steps: [walk, transit('Newmarket', '2026-10-13T17:10:00.000Z'), transit('Britomart', '2026-10-13T17:40:00.000Z'), walk],
  };
  assert.deepEqual(journeyStopFromRoute(route), { name: 'Britomart', lat: -36.9, lon: 174.8, arrivalIso: '2026-10-13T17:40:00.000Z' });
});

test('journeyStopFromRoute: skips a later leg that has no stop or time, and a walking-only route has none', () => {
  const partial: JourneyRoute = { durationText: '30 min', steps: [transit('Newmarket', '2026-10-13T17:10:00.000Z'), transit(undefined, undefined)] };
  assert.equal(journeyStopFromRoute(partial)?.name, 'Newmarket');
  assert.equal(journeyStopFromRoute({ durationText: '10 min', steps: [walk] }), null);
});

// --- Recent Turns ---
test('recentTurnsFrom: keeps what was said, leaves out result lists and errors, and keeps the latest few', () => {
  const turns = recentTurnsFrom(
    [
      { role: 'user', text: 'ramen near me' },
      { role: 'assistant', kind: 'results' },
      { role: 'assistant', kind: 'summary', text: 'Plenty close by.' },
      { role: 'assistant', kind: 'error', text: 'Could not search' },
      { role: 'user', text: 'which is best?' },
      { role: 'assistant', kind: 'question', text: 'Which one?' },
    ],
    3
  );
  assert.deepEqual(turns, [
    { role: 'assistant', text: 'Plenty close by.' },
    { role: 'user', text: 'which is best?' },
    { role: 'assistant', text: 'Which one?' },
  ]);
});
