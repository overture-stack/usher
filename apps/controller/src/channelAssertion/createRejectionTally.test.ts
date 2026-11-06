import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
  createRejectionTally,
  REJECTION_TALLY_INTERVAL_MILLISECONDS,
} from './createRejectionTally.js';
import type { UnverifiedRejectionReason } from './types.js';

const INTERVAL = REJECTION_TALLY_INTERVAL_MILLISECONDS;

// The start of an interval, so a test's own counts never straddle one by chance.
const START = 29_000_000 * INTERVAL;

const SEARCH = '4b1f6c2e-8d3a-4e5f-9a7b-0c1d2e3f4a5b';

const PORTAL = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';

interface Recorded {
  applicationId: string | undefined;
  count: number;
  reason: UnverifiedRejectionReason;
}

const tallied = (): {
  recorded: Recorded[];
  tally: ReturnType<typeof createRejectionTally>;
  time: { now: number };
} => {
  const time = { now: START };
  const recorded: Recorded[] = [];
  const tally = createRejectionTally({
    clock: { now: () => time.now },
    record: async (reason, applicationId, count) => {
      recorded.push({ applicationId, count, reason });
    },
  });
  return { recorded, tally, time };
};

suite('the tally of channel assertions refused unverified', () => {
  test('records each reason and application counted in an interval once the clock has passed it, in the order of the reasons and then the applications, the count naming none first', async (context) => {
    context.mock.timers.enable({ apis: ['setInterval'] });
    const { recorded, tally, time } = tallied();
    tally.start();

    tally.count('noLiveKey', SEARCH);
    tally.count('missingAssertion');
    tally.count('invalidSignature', SEARCH);
    tally.count('invalidSignature', PORTAL);
    tally.count('invalidSignature');
    tally.count('noLiveKey', SEARCH);
    tally.count('unreadableAssertion', PORTAL);
    tally.count('unreadableAssertion');
    context.mock.timers.tick(5000);
    const withinInterval = [...recorded];
    time.now += INTERVAL;
    context.mock.timers.tick(1000);
    await tally.stop();

    assert.deepEqual(withinInterval, []);
    assert.deepEqual(recorded, [
      { applicationId: undefined, count: 1, reason: 'invalidSignature' },
      { applicationId: SEARCH, count: 1, reason: 'invalidSignature' },
      { applicationId: PORTAL, count: 1, reason: 'invalidSignature' },
      { applicationId: undefined, count: 1, reason: 'missingAssertion' },
      { applicationId: SEARCH, count: 2, reason: 'noLiveKey' },
      { applicationId: undefined, count: 1, reason: 'unreadableAssertion' },
      { applicationId: PORTAL, count: 1, reason: 'unreadableAssertion' },
    ]);
  });

  test('records nothing for an interval in which nothing was counted', async (context) => {
    context.mock.timers.enable({ apis: ['setInterval'] });
    const { recorded, tally, time } = tallied();
    tally.start();

    time.now += 3 * INTERVAL;
    context.mock.timers.tick(1000);
    await tally.stop();

    assert.deepEqual(recorded, []);
  });

  test('keeps the counts of each interval apart, a count after the clock moved past one going to the next', async () => {
    const { recorded, tally, time } = tallied();

    tally.count('unknownApplication');
    tally.count('unknownApplication');
    time.now += INTERVAL + 1000;
    tally.count('unknownApplication');
    await tally.stop();

    assert.deepEqual(recorded, [
      { applicationId: undefined, count: 2, reason: 'unknownApplication' },
      { applicationId: undefined, count: 1, reason: 'unknownApplication' },
    ]);
  });

  test('records the counts it holds when it stops, and settles once each is recorded', async () => {
    const recorded: Recorded[] = [];
    const tally = createRejectionTally({
      clock: { now: () => START },
      record: async (reason, applicationId, count) => {
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
        recorded.push({ applicationId, count, reason });
      },
    });

    tally.count('noLiveKey', SEARCH);
    await tally.stop();

    assert.deepEqual(recorded, [
      { applicationId: SEARCH, count: 1, reason: 'noLiveKey' },
    ]);
  });

  test('settles its stop when a recording fails', async () => {
    const tally = createRejectionTally({
      clock: { now: () => START },
      record: () => Promise.reject(new Error('the store is down')),
    });

    tally.count('missingAssertion');

    await tally.stop();
  });
});
