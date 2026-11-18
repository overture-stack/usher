import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type { Actor, AuditEvent } from '../eventLog/index.js';
import { createTally } from './createTally.js';
import type { Tally, TallySettings } from './types.js';

const INTERVAL = 60_000;

// The start of an interval, so a test's own counts never straddle one by chance.
const START = 29_000_000 * INTERVAL;

const SEARCH = '4b1f6c2e-8d3a-4e5f-9a7b-0c1d2e3f4a5b';

const PORTAL = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';

const SYSTEM: Actor = { type: 'system' };

interface Rejection {
  applicationId?: string;
  reason: string;
}

// Counted by reason alone.
const BY_REASON: Pick<TallySettings<string>, 'eventOf' | 'partsOf'> = {
  eventOf: (reason, count) => ({
    data: { count, reason },
    severity: 'warning',
    type: 'managementToken.refusalTally',
  }),
  partsOf: (reason) => [reason],
};

// Counted by reason and by the application named, or none, as the channel's rejection tally counts.
const BY_REASON_AND_APPLICATION: Pick<
  TallySettings<Rejection>,
  'eventOf' | 'partsOf'
> = {
  eventOf: ({ applicationId, reason }, count) => ({
    data: {
      ...(applicationId === undefined ? {} : { applicationId }),
      count,
      reason,
    },
    severity: 'warning',
    type: 'channelAssertion.rejectionTally',
  }),
  partsOf: ({ applicationId, reason }) => [reason, applicationId ?? ''],
};

interface Recorded {
  actor: Actor;
  event: AuditEvent;
}

const tallied = <Counted>(
  naming: Pick<TallySettings<Counted>, 'eventOf' | 'partsOf'>,
  {
    intervalMilliseconds = INTERVAL,
    recordEvent,
  }: {
    intervalMilliseconds?: number;
    recordEvent?: (actor: Actor, event: AuditEvent) => Promise<undefined>;
  } = {},
): {
  data: () => readonly unknown[];
  recorded: Recorded[];
  tally: Tally<Counted>;
  time: { now: number };
} => {
  const time = { now: START };
  const recorded: Recorded[] = [];
  const tally = createTally<Counted>({
    ...naming,
    clock: { now: () => time.now },
    intervalMilliseconds,
    trail: {
      recordEvent:
        recordEvent ??
        (async (actor, event) => {
          recorded.push({ actor, event });
          return undefined;
        }),
    },
  });
  return {
    data: () => recorded.map(({ event }) => event.data),
    recorded,
    tally,
    time,
  };
};

suite('a tally', () => {
  test('records each thing counted in an interval once the clock has passed it, as the system, in the order of its parts, a missing part first', async (context) => {
    context.mock.timers.enable({ apis: ['setInterval'] });
    const { data, recorded, tally, time } = tallied(BY_REASON_AND_APPLICATION);
    tally.start();

    tally.count({ applicationId: SEARCH, reason: 'noLiveKey' });
    tally.count({ reason: 'missingAssertion' });
    tally.count({ applicationId: SEARCH, reason: 'invalidSignature' });
    tally.count({ applicationId: PORTAL, reason: 'invalidSignature' });
    tally.count({ reason: 'invalidSignature' });
    tally.count({ applicationId: SEARCH, reason: 'noLiveKey' });
    tally.count({ applicationId: PORTAL, reason: 'unreadableAssertion' });
    tally.count({ reason: 'unreadableAssertion' });
    context.mock.timers.tick(5000);
    const withinInterval = data();
    time.now += INTERVAL;
    context.mock.timers.tick(1000);
    await tally.stop();

    assert.deepEqual(withinInterval, []);
    assert.deepEqual(data(), [
      { count: 1, reason: 'invalidSignature' },
      { applicationId: SEARCH, count: 1, reason: 'invalidSignature' },
      { applicationId: PORTAL, count: 1, reason: 'invalidSignature' },
      { count: 1, reason: 'missingAssertion' },
      { applicationId: SEARCH, count: 2, reason: 'noLiveKey' },
      { count: 1, reason: 'unreadableAssertion' },
      { applicationId: PORTAL, count: 1, reason: 'unreadableAssertion' },
    ]);
    assert.deepEqual(
      recorded.map(({ actor, event }) => [actor, event.type]),
      recorded.map(() => [SYSTEM, 'channelAssertion.rejectionTally']),
    );
  });

  test('records what it counts by one part in the order of its name', async (context) => {
    context.mock.timers.enable({ apis: ['setInterval'] });
    const { data, tally, time } = tallied(BY_REASON);
    tally.start();

    tally.count('otherIssuer');
    tally.count('malformedCredential');
    tally.count('invalidSignature');
    tally.count('otherIssuer');
    context.mock.timers.tick(5000);
    const withinInterval = data();
    time.now += INTERVAL;
    context.mock.timers.tick(1000);
    await tally.stop();

    assert.deepEqual(withinInterval, []);
    assert.deepEqual(data(), [
      { count: 1, reason: 'invalidSignature' },
      { count: 1, reason: 'malformedCredential' },
      { count: 2, reason: 'otherIssuer' },
    ]);
  });

  test('records nothing for an interval in which nothing was counted', async (context) => {
    context.mock.timers.enable({ apis: ['setInterval'] });
    const { recorded, tally, time } = tallied(BY_REASON);
    tally.start();

    time.now += 3 * INTERVAL;
    context.mock.timers.tick(1000);
    await tally.stop();

    assert.deepEqual(recorded, []);
  });

  test('keeps the counts of each interval apart, a count after the clock moved past one going to the next', async () => {
    const { data, tally, time } = tallied(BY_REASON);

    tally.count('otherIssuer');
    tally.count('otherIssuer');
    tally.count('otherIssuer');
    time.now += INTERVAL + 1000;
    tally.count('otherIssuer');
    time.now += INTERVAL + 1000;
    tally.count('otherIssuer');
    tally.count('otherIssuer');
    await tally.stop();

    assert.deepEqual(data(), [
      { count: 3, reason: 'otherIssuer' },
      { count: 1, reason: 'otherIssuer' },
      { count: 2, reason: 'otherIssuer' },
    ]);
  });

  test('runs intervals of the length it is given', async () => {
    const { data, tally, time } = tallied(BY_REASON, {
      intervalMilliseconds: 10_000,
    });

    tally.count('otherIssuer');
    time.now += 10_000;
    tally.count('otherIssuer');
    await tally.stop();

    assert.deepEqual(data(), [
      { count: 1, reason: 'otherIssuer' },
      { count: 1, reason: 'otherIssuer' },
    ]);
  });

  test('records the counts it holds when it stops, and settles once each is recorded', async () => {
    const written: unknown[] = [];
    const { tally } = tallied(BY_REASON_AND_APPLICATION, {
      recordEvent: async (_actor, event) => {
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
        written.push(event.data);
        return undefined;
      },
    });

    tally.count({ applicationId: SEARCH, reason: 'noLiveKey' });
    await tally.stop();

    assert.deepEqual(written, [
      { applicationId: SEARCH, count: 1, reason: 'noLiveKey' },
    ]);
  });

  test('settles its stop when a recording fails', async () => {
    const { tally } = tallied(BY_REASON, {
      recordEvent: () => Promise.reject(new Error('the store is down')),
    });

    tally.count('otherIssuer');

    await tally.stop();
  });
});
