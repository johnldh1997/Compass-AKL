import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CROWDING_FILLED_ICONS, crowdingLevel } from './occupancy.ts';

test('maps GTFS-realtime occupancy statuses to four levels; standing room only already means no seat', () => {
  assert.equal(crowdingLevel(0), 'empty');
  assert.equal(crowdingLevel(1), 'many');
  assert.equal(crowdingLevel(2), 'few');
  for (const status of [3, 4, 5, 6]) assert.equal(crowdingLevel(status), 'full', `status ${status}`);
});

test('a vehicle that reports nothing, or something unknown, says nothing', () => {
  assert.equal(crowdingLevel(undefined), null);
  assert.equal(crowdingLevel(7), null);
  assert.equal(crowdingLevel(-1), null);
});

test('the icons fill up 0, 1, 2, 3 as the bus gets fuller', () => {
  assert.deepEqual(
    (['empty', 'many', 'few', 'full'] as const).map((level) => CROWDING_FILLED_ICONS[level]),
    [0, 1, 2, 3]
  );
});
