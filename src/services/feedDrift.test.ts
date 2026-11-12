import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFeedDrifted } from './feedDrift.ts';

test('flags a feed where few live trips are recognised (the real 35% case)', () => {
  assert.equal(isFeedDrifted(70, 200), true);
});

test('does not flag a healthy feed', () => {
  assert.equal(isFeedDrifted(200, 200), false);
  assert.equal(isFeedDrifted(170, 200), false);
});

test('boundary: exactly 80% is fine, just under is drift', () => {
  assert.equal(isFeedDrifted(160, 200), false);
  assert.equal(isFeedDrifted(159, 200), true);
});

test('too small a sample says nothing', () => {
  assert.equal(isFeedDrifted(0, 5), false);
  assert.equal(isFeedDrifted(0, 0), false);
});
