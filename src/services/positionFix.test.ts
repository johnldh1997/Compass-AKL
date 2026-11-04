import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findFix, withTimeout, type FixSources } from './positionFix.ts';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const neverAnswers = <T>() => new Promise<T>(() => {});

function sources(over: Partial<FixSources<string>>): { sources: FixSources<string>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    sources: {
      recent: async () => (calls.push('recent'), null),
      fresh: async () => (calls.push('fresh'), 'fresh-fix'),
      old: async () => (calls.push('old'), null),
      ...over,
    },
  };
}

test('a recent fix is used straight away, without asking for a fresh one', async () => {
  const { sources: s, calls } = sources({ recent: async () => 'recent-fix' });
  assert.equal(await findFix(s, 50), 'recent-fix');
  assert.deepEqual(calls, []);
});

test('with no recent fix, a fresh one is used', async () => {
  const { sources: s, calls } = sources({});
  assert.equal(await findFix(s, 50), 'fresh-fix');
  assert.deepEqual(calls, ['recent', 'fresh']);
});

test('a fresh fix that never arrives gives way to the newest older fix after the time limit', async () => {
  const { sources: s } = sources({ fresh: () => neverAnswers<string>(), old: async () => 'old-fix' });
  const started = Date.now();
  assert.equal(await findFix(s, 40), 'old-fix');
  const waited = Date.now() - started;
  assert.ok(waited >= 35 && waited < 200, `waited about the limit, not ${waited} ms`);
});

test('nothing at all is null, after the time limit — never a hang', async () => {
  const { sources: s } = sources({ fresh: () => neverAnswers<string>() });
  assert.equal(await findFix(s, 30), null);
});

test('a failing fresh request falls back to the older fix; failing helpers do not throw', async () => {
  const failing = sources({
    recent: async () => {
      throw new Error('no provider');
    },
    fresh: async () => {
      throw new Error('settings unsatisfied');
    },
    old: async () => 'old-fix',
  });
  assert.equal(await findFix(failing.sources, 50), 'old-fix');

  const allFail = sources({
    recent: async () => {
      throw new Error('a');
    },
    fresh: async () => {
      throw new Error('b');
    },
    old: async () => {
      throw new Error('c');
    },
  });
  assert.equal(await findFix(allFail.sources, 50), null);
});

test('a fresh fix arriving after the limit is ignored rather than acted on twice', async () => {
  const { sources: s } = sources({
    fresh: async () => {
      await sleep(80);
      return 'late-fix';
    },
    old: async () => 'old-fix',
  });
  assert.equal(await findFix(s, 30), 'old-fix');
  await sleep(120); // the late answer lands harmlessly
});

test('withTimeout: passes a value through, times out to null, and still rejects', async () => {
  assert.equal(await withTimeout(Promise.resolve('x'), 50), 'x');
  assert.equal(await withTimeout(neverAnswers<string>(), 20), null);
  await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 50), /boom/);
});
