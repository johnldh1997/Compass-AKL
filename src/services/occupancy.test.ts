import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crowdingLevel } from './occupancy.ts';

test('maps GTFS-realtime occupancy statuses to four levels', () => {
  assert.equal(crowdingLevel(0), 'many');
  assert.equal(crowdingLevel(1), 'many');
  assert.equal(crowdingLevel(2), 'few');
  assert.equal(crowdingLevel(3), 'standing');
  assert.equal(crowdingLevel(4), 'full');
  assert.equal(crowdingLevel(5), 'full');
  assert.equal(crowdingLevel(6), 'full');
});

test('a vehicle that reports nothing, or something unknown, says nothing', () => {
  assert.equal(crowdingLevel(undefined), null);
  assert.equal(crowdingLevel(7), null);
  assert.equal(crowdingLevel(-1), null);
});
