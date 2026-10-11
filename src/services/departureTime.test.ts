import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampToNow } from './departureTime.ts';

const now = new Date('2026-10-12T13:05:00');

test('clampToNow: a departure time that has already passed becomes now', () => {
  const missedBus = new Date('2026-10-12T12:41:00');
  assert.equal(clampToNow(missedBus, now).getTime(), now.getTime());
});

test('clampToNow: a time yesterday also becomes now', () => {
  const yesterday = new Date('2026-10-11T18:00:00');
  assert.equal(clampToNow(yesterday, now).getTime(), now.getTime());
});

test('clampToNow: a future departure time is left alone', () => {
  const later = new Date('2026-10-12T15:00:00');
  assert.equal(clampToNow(later, now).getTime(), later.getTime());
});

test('clampToNow: exactly now is left alone', () => {
  assert.equal(clampToNow(new Date(now), now).getTime(), now.getTime());
});

test('clampToNow: does not mutate the Date it was given', () => {
  const missedBus = new Date('2026-10-12T12:41:00');
  const before = missedBus.getTime();
  clampToNow(missedBus, now);
  assert.equal(missedBus.getTime(), before);
});
