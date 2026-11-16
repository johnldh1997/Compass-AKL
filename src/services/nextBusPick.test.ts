import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickNextBuses } from './nextBusPick.ts';
import type { Departure } from '../types.ts';

const NOW = Date.parse('2026-11-17T10:00:00.000Z');
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

function dep(over: Partial<Departure> & { tripId: string; minutes: number }): Departure {
  const { minutes, ...rest } = over;
  return {
    routeId: 'r',
    routeShortName: '70',
    mode: 'bus',
    headsign: 'Britomart',
    scheduledTime: at(minutes),
    estimatedTime: at(minutes),
    delayMinutes: 0,
    cancelled: false,
    ...rest,
  };
}

test('only the line you want, soonest first, at most three', () => {
  const all = [
    dep({ tripId: 'a', minutes: 20 }),
    dep({ tripId: 'b', minutes: 3 }),
    dep({ tripId: 'x', minutes: 1, routeShortName: '25L' }),
    dep({ tripId: 'c', minutes: 11 }),
    dep({ tripId: 'd', minutes: 30 }),
  ];
  assert.deepEqual(pickNextBuses(all, '70', NOW).map((d) => d.tripId), ['b', 'c', 'a']);
});

test('a cancelled trip is skipped', () => {
  const all = [dep({ tripId: 'a', minutes: 2, cancelled: true }), dep({ tripId: 'b', minutes: 9 })];
  assert.deepEqual(pickNextBuses(all, '70', NOW).map((d) => d.tripId), ['b']);
});

test('one that left a few seconds ago is kept; one that left minutes ago is gone', () => {
  const all = [dep({ tripId: 'just', minutes: -0.5 }), dep({ tripId: 'gone', minutes: -4 }), dep({ tripId: 'next', minutes: 6 })];
  assert.deepEqual(pickNextBuses(all, '70', NOW).map((d) => d.tripId), ['just', 'next']);
});

test('nothing running gives an empty list', () => {
  assert.deepEqual(pickNextBuses([], '70', NOW), []);
});
