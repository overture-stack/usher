import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
  createRefusalTally,
  REFUSAL_TALLY_INTERVAL_MILLISECONDS,
} from './refusalTally.js';
import type { TallyReason } from './types.js';

const INTERVAL = REFUSAL_TALLY_INTERVAL_MILLISECONDS;

// The start of an interval, so a test's own counts never straddle one by chance.
const START = 29_000_000 * INTERVAL;

interface Recorded {
  count: number;
  reason: TallyReason;
}

const tallied = () => {
  const time = { now: START };
  const recorded: Recorded[] = [];
  const tally = createRefusalTally({
    clock: { now: () => time.now },
    record: async (reason, count) => {
      recorded.push({ count, reason });
    },
  });
  return { recorded, tally, time };
};

suite('the refusal tally', () => {
  test('records each reason counted in an interval once the clock has passed it, in the order of their names', async (context) => {
    context.mock.timers.enable({ apis: ['setInterval'] });
    const { recorded, tally, time } = tallied();
    tally.start();

    tally.count('otherIssuer');
    tally.count('malformedCredential');
    tally.count('invalidSignature');
    tally.count('otherIssuer');
    context.mock.timers.tick(5000);
    const withinInterval = [...recorded];
    time.now += INTERVAL;
    context.mock.timers.tick(1000);
    await tally.stop();

    assert.deepEqual(withinInterval, []);
    assert.deepEqual(recorded, [
      { count: 1, reason: 'invalidSignature' },
      { count: 1, reason: 'malformedCredential' },
      { count: 2, reason: 'otherIssuer' },
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

    tally.count('otherIssuer');
    tally.count('otherIssuer');
    tally.count('otherIssuer');
    time.now += INTERVAL + 1000;
    tally.count('otherIssuer');
    time.now += INTERVAL + 1000;
    tally.count('otherIssuer');
    tally.count('otherIssuer');
    await tally.stop();

    assert.deepEqual(recorded, [
      { count: 3, reason: 'otherIssuer' },
      { count: 1, reason: 'otherIssuer' },
      { count: 2, reason: 'otherIssuer' },
    ]);
  });

  test('records the counts it holds when it stops, and settles once each is recorded', async () => {
    const time = { now: START };
    const recorded: Recorded[] = [];
    const tally = createRefusalTally({
      clock: { now: () => time.now },
      record: async (reason, count) => {
        await new Promise((resolve) => setImmediate(resolve));
        recorded.push({ count, reason });
      },
    });

    tally.count('unreadableToken');
    await tally.stop();

    assert.deepEqual(recorded, [{ count: 1, reason: 'unreadableToken' }]);
  });

  test('settles its stop when a recording fails', async () => {
    const tally = createRefusalTally({
      clock: { now: () => START },
      record: () => Promise.reject(new Error('the store is down')),
    });

    tally.count('otherIssuer');

    await tally.stop();
  });
});
