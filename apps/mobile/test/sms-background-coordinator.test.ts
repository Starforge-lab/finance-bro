import assert from 'node:assert/strict';
import test from 'node:test';
import { createSmsBackgroundTaskExecutor, dispatchAfterPendingReport } from './sms-background-coordinator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

test('shares one normal fixture run and reports a concurrent task-manager error as failed', async () => {
  const active = deferred<'passed'>();
  const calls: boolean[] = [];
  const execute = createSmsBackgroundTaskExecutor(async (taskFailed) => {
    calls.push(taskFailed);
    return taskFailed ? 'failed' as const : active.promise;
  });

  const first = execute.execute(null);
  const duplicate = execute.execute(null);
  assert.strictEqual(duplicate, first);
  const errored = execute.execute({ code: 'fixture-error' });
  assert.deepEqual(calls, [false]);
  active.resolve('passed');
  assert.equal(await first, 'passed');
  assert.equal(await errored, 'failed');
  assert.deepEqual(calls, [false, true]);
});

test('does not dispatch a background task unless the pending report was written first', async () => {
  const events: string[] = [];
  const result = await dispatchAfterPendingReport(
    async () => { events.push('pending'); },
    async () => { events.push('dispatch'); return true; },
  );
  assert.equal(result, true);
  assert.deepEqual(events, ['pending', 'dispatch']);

  await assert.rejects(() => dispatchAfterPendingReport(
    async () => { throw new Error('report-write-failed'); },
    async () => { events.push('must-not-dispatch'); return true; },
  ));
  assert.deepEqual(events, ['pending', 'dispatch']);
});

test('waits for an older fixture to settle before marking and dispatching a test run', async () => {
  const active = deferred<'passed'>();
  const events: string[] = [];
  let runCount = 0;
  const execute = createSmsBackgroundTaskExecutor(async () => {
    runCount += 1;
    events.push(`fixture-${runCount}`);
    return runCount === 1 ? active.promise : 'passed';
  });

  const olderRun = execute.execute(null);
  const testRun = execute.afterIdle(() => dispatchAfterPendingReport(
    async () => { events.push('pending'); },
    async () => {
      events.push('dispatch');
      return await execute.execute(null);
    },
  ));

  assert.deepEqual(events, ['fixture-1']);
  active.resolve('passed');
  assert.equal(await olderRun, 'passed');
  assert.equal(await testRun, 'passed');
  assert.deepEqual(events, ['fixture-1', 'pending', 'dispatch', 'fixture-2']);
});
