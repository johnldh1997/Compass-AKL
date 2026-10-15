import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runUpdateCheck, type UpdateSteps } from './updateCheck.ts';

const BUDGET = 60;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Records what the steps were asked to do, so a test can see what did and didn't happen.
function fakeSteps(opts: { checkMs?: number; available?: boolean; downloadMs?: number; restartMs?: number; failCheck?: boolean; failRestart?: boolean }) {
  const calls: string[] = [];
  const steps: UpdateSteps = {
    check: async () => {
      calls.push('check');
      await sleep(opts.checkMs ?? 0);
      if (opts.failCheck) throw new Error('offline');
      return opts.available ?? false;
    },
    download: async () => {
      calls.push('download');
      await sleep(opts.downloadMs ?? 0);
      calls.push('downloaded');
    },
    restart: async () => {
      calls.push('restart');
      await sleep(opts.restartMs ?? 0);
      if (opts.failRestart) throw new Error('could not restart');
    },
    onStage: (stage) => calls.push(`stage:${stage}`),
  };
  return { steps, calls };
}

// Whether the promise has resolved within `ms`.
async function resolvesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  let done = false;
  promise.then(() => (done = true));
  await sleep(ms);
  return done;
}

test('up to date: opens straight away, without waiting out the budget', async () => {
  const { steps, calls } = fakeSteps({ available: false });
  const started = Date.now();
  await runUpdateCheck(steps, BUDGET);
  assert.ok(Date.now() - started < BUDGET, 'must not wait for the budget');
  assert.deepEqual(calls, ['check']);
});

test('an update available on a good connection is downloaded and the app restarts into it — the old instance never opens', async () => {
  const { steps, calls } = fakeSteps({ available: true });
  const opened = await resolvesWithin(runUpdateCheck(steps, BUDGET), BUDGET * 2);
  assert.equal(opened, false, 'a restarting app must not open');
  assert.deepEqual(calls, ['check', 'stage:downloading', 'download', 'downloaded', 'stage:restarting', 'restart']);
});

test('a slow check opens the app at the budget, and a late "update available" does not restart it afterwards', async () => {
  const { steps, calls } = fakeSteps({ checkMs: BUDGET * 3, available: true });
  const started = Date.now();
  await runUpdateCheck(steps, BUDGET);
  const waited = Date.now() - started;
  assert.ok(waited >= BUDGET - 5 && waited < BUDGET * 2, `opened after about the budget, not ${waited} ms`);
  await sleep(BUDGET * 4);
  assert.deepEqual(calls, ['check'], 'nothing was downloaded or restarted after giving up');
});

test('a slow download opens the app at the budget and never restarts it when it finishes later', async () => {
  const { steps, calls } = fakeSteps({ available: true, downloadMs: BUDGET * 3 });
  await runUpdateCheck(steps, BUDGET);
  await sleep(BUDGET * 4);
  assert.deepEqual(calls, ['check', 'stage:downloading', 'download', 'downloaded'], 'downloaded in the background, no restart');
});

test('a restart already under way is not interrupted by the budget running out', async () => {
  const { steps } = fakeSteps({ available: true, restartMs: BUDGET * 3 });
  const opened = await resolvesWithin(runUpdateCheck(steps, BUDGET), BUDGET * 2);
  assert.equal(opened, false, 'the budget must not open an app that is restarting');
});

test('a failed check opens the app', async () => {
  const { steps } = fakeSteps({ failCheck: true });
  assert.equal(await resolvesWithin(runUpdateCheck(steps, BUDGET), BUDGET / 2), true);
});

test('a restart that fails opens the app instead of leaving it on the loading screen', async () => {
  const { steps } = fakeSteps({ available: true, failRestart: true });
  assert.equal(await resolvesWithin(runUpdateCheck(steps, BUDGET), BUDGET / 2), true);
});
