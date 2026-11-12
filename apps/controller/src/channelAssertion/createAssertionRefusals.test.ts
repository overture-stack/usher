import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type { Actor, AuditEvent } from '../eventLog/index.js';
import { CommitUnconfirmed, StoreTimeout } from '../storeTimeout/index.js';
import {
  createAssertionRefusals,
  pendingRecordingLimit,
} from './createAssertionRefusals.js';
import { createRefusedAssertions } from './createRefusedAssertions.js';
import { REJECTION_TALLY_INTERVAL_MILLISECONDS } from './rejectionTallyIntervalMilliseconds.js';
import type {
  RefusalTrail,
  RefusedAssertions,
  VerifiedRefusal,
} from './types.js';

const APPLICATION = '0d4c7e2a-8b1f-4a63-9e05-3f7a2c9d1b68';

const OTHER_APPLICATION = '7f3b9d1e-2c4a-4e8b-a6d0-5e1f2a3b4c5d';

// The start of an interval, so a test's failed recordings never straddle one by chance.
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);

interface Counted {
  applicationId: string;
  reason: string;
}

/** One line the recorder wrote at warning. */
interface Warning {
  fields: unknown;
  message: string;
}

/** One recording a trail was asked for: its actor, its event, and how the test settles it. */
interface Recording {
  actor: Actor;

  /** Writes the event and commits, as a store answering does. */
  commit(): void;

  event: AuditEvent | undefined;

  /** Fails the transaction, as a store refusing it or not answering does. */
  fail(failure: unknown): void;
}

/** A trail whose every transaction waits until the test commits or fails it. */
interface HeldTrail {
  recordings: Recording[];
  trail: RefusalTrail;
}

const heldTrail = (): HeldTrail => {
  const recordings: Recording[] = [];
  const trail: RefusalTrail = {
    inTransaction: (actor, work) =>
      new Promise((resolve, reject) => {
        const recording: Recording = {
          actor,
          commit: () => undefined,
          event: undefined,
          fail: reject,
        };
        recordings.push(recording);
        const done = work({
          connection: undefined,
          record: async (event) => {
            recording.event = event;
            return 'event-id';
          },
        });
        recording.commit = () => {
          resolve(done);
        };
      }),
  };
  return { recordings, trail };
};

const refusal = (
  signingInputDigest: string,
  reason: VerifiedRefusal['reason'] = 'expiredAssertion',
): VerifiedRefusal => ({
  applicationId: APPLICATION,
  reason,
  signingInputDigest,
  sourceIp: '192.0.2.10',
});

// Lets every callback already due run.
const settled = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

// The recorder on a clock the test moves by hand, its memory on the same clock unless one is given.
const standUp = (
  refusedAssertions?: RefusedAssertions,
): {
  counted: Counted[];
  refusals: ReturnType<typeof createAssertionRefusals>;
  time: { now: number };
  warnings: Warning[];
} => {
  const counted: Counted[] = [];
  const time = { now: NOW };
  const warnings: Warning[] = [];
  const clock = { now: (): number => time.now };
  return {
    counted,
    refusals: createAssertionRefusals({
      clock,
      log: {
        warning: (message, fields) => {
          warnings.push({ fields, message });
        },
      },
      refusedAssertions: refusedAssertions ?? createRefusedAssertions(clock),
      rejections: {
        count: (reason, applicationId) => {
          counted.push({ applicationId, reason });
        },
      },
    }),
    time,
    warnings,
  };
};

suite("a route's limit of rejection recordings waiting on the store", () => {
  test('is half the connections of its pool, rounded down, and at least one', () => {
    assert.deepEqual(
      [1, 2, 3, 10].map((connections) => pendingRecordingLimit(connections)),
      [1, 1, 1, 5],
    );
  });
});

suite("the instance's recording of refused assertions", () => {
  test('records the first refusal of each assertion as the system, denied, naming its application and address, and counts its repeats by reason and application', async () => {
    const { counted, refusals } = standUp();
    const { recordings, trail } = heldTrail();
    const route = refusals.forRoute({ pendingLimit: 5, trail });

    route.refused(refusal('digest-1'));
    route.refused(refusal('digest-1'));
    route.refused(refusal('digest-2', 'otherAudience'));
    recordings.forEach(({ commit }) => {
      commit();
    });
    await refusals.stop();

    assert.deepEqual(
      recordings.map(({ actor, event }) => ({ actor, event })),
      [
        {
          actor: { type: 'system' },
          event: {
            data: {
              applicationId: APPLICATION,
              reason: 'expiredAssertion',
              result: 'denied',
              sourceIp: '192.0.2.10',
            },
            severity: 'warning',
            type: 'channelAssertion.rejection',
          },
        },
        {
          actor: { type: 'system' },
          event: {
            data: {
              applicationId: APPLICATION,
              reason: 'otherAudience',
              result: 'denied',
              sourceIp: '192.0.2.10',
            },
            severity: 'warning',
            type: 'channelAssertion.rejection',
          },
        },
      ],
    );
    assert.deepEqual(counted, [
      { applicationId: APPLICATION, reason: 'expiredAssertion' },
    ]);
  });

  test('shares one memory between routes, so an assertion one route recorded is counted on the other', async () => {
    const { counted, refusals } = standUp();
    const exchange = heldTrail();
    const stream = heldTrail();

    refusals
      .forRoute({ pendingLimit: 5, trail: exchange.trail })
      .refused(refusal('digest-1'));
    refusals
      .forRoute({ pendingLimit: 5, trail: stream.trail })
      .refused(refusal('digest-1', 'reusedAssertion'));
    exchange.recordings.forEach(({ commit }) => {
      commit();
    });
    await refusals.stop();

    assert.equal(exchange.recordings.length, 1);
    assert.deepEqual(stream.recordings, []);
    assert.deepEqual(counted, [
      { applicationId: APPLICATION, reason: 'reusedAssertion' },
    ]);
  });

  test("counts each refusal past its route's limit of recordings waiting, remembering none of them, so each is recorded once the route has room", async () => {
    const { counted, refusals } = standUp();
    const { recordings, trail } = heldTrail();
    const route = refusals.forRoute({ pendingLimit: 2, trail });

    ['digest-1', 'digest-2', 'digest-3', 'digest-4'].forEach((digest) => {
      route.refused(refusal(digest));
    });
    const waitingAtTheLimit = recordings.length;
    recordings.forEach(({ commit }) => {
      commit();
    });
    await settled();
    route.refused(refusal('digest-3'));
    recordings.forEach(({ commit }) => {
      commit();
    });
    await refusals.stop();

    assert.equal(waitingAtTheLimit, 2);
    assert.deepEqual(
      counted.map(({ reason }) => reason),
      ['expiredAssertion', 'expiredAssertion'],
    );
    assert.equal(recordings.length, 3);
  });

  test("holds each route to its own limit, so one route at its limit leaves another's recordings be", async () => {
    const { counted, refusals } = standUp();
    const exchange = heldTrail();
    const stream = heldTrail();
    const exchangeRoute = refusals.forRoute({
      pendingLimit: 1,
      trail: exchange.trail,
    });
    const streamRoute = refusals.forRoute({
      pendingLimit: 1,
      trail: stream.trail,
    });

    exchangeRoute.refused(refusal('digest-1'));
    exchangeRoute.refused(refusal('digest-2'));
    streamRoute.refused(refusal('digest-3', 'reusedAssertion'));
    [...exchange.recordings, ...stream.recordings].forEach(({ commit }) => {
      commit();
    });
    await refusals.stop();

    assert.equal(exchange.recordings.length, 1);
    assert.equal(stream.recordings.length, 1);
    assert.deepEqual(counted, [
      { applicationId: APPLICATION, reason: 'expiredAssertion' },
    ]);
  });

  test('counts each refusal while the memory is full, remembering and recording none', async () => {
    const full: RefusedAssertions = {
      forget: () => undefined,
      has: () => false,
      isFull: () => true,
      remember: () => assert.fail('a full memory is asked to remember'),
    };
    const { counted, refusals } = standUp(full);
    const { recordings, trail } = heldTrail();

    refusals.forRoute({ pendingLimit: 5, trail }).refused(refusal('digest-1'));
    await refusals.stop();

    assert.deepEqual(recordings, []);
    assert.deepEqual(counted, [
      { applicationId: APPLICATION, reason: 'expiredAssertion' },
    ]);
  });

  test('counts a refusal whose recording does not commit, the store refusing it, not answering in time or not confirming its COMMIT, and records the next refusal of that assertion', async () => {
    const failures: readonly unknown[] = [
      Object.assign(new Error('the store refused the statement'), {
        code: '57P01',
      }),
      new StoreTimeout(),
      new CommitUnconfirmed(),
    ];

    const outcomes = await Promise.all(
      failures.map(async (failure) => {
        const { counted, refusals } = standUp();
        const { recordings, trail } = heldTrail();
        const route = refusals.forRoute({ pendingLimit: 5, trail });

        route.refused(refusal('digest-1'));
        recordings[0]?.fail(failure);
        await settled();
        route.refused(refusal('digest-1'));
        recordings[1]?.commit();
        await refusals.stop();

        return { counted, recordings: recordings.length };
      }),
    );

    outcomes.forEach(({ counted, recordings }) => {
      assert.deepEqual(counted, [
        { applicationId: APPLICATION, reason: 'expiredAssertion' },
      ]);
      assert.equal(recordings, 2);
    });
  });

  test('stops once every recording begun on any route has ended', async () => {
    const { refusals } = standUp();
    const exchange = heldTrail();
    const stream = heldTrail();
    refusals
      .forRoute({ pendingLimit: 5, trail: exchange.trail })
      .refused(refusal('digest-1'));
    refusals
      .forRoute({ pendingLimit: 5, trail: stream.trail })
      .refused(refusal('digest-2'));
    const state = { stopped: false };

    const stopping = refusals.stop().then(() => {
      state.stopped = true;
    });
    exchange.recordings[0]?.commit();
    await settled();
    const stoppedWithOneLeft = state.stopped;
    stream.recordings[0]?.fail(new StoreTimeout());
    await stopping;

    assert.equal(stoppedWithOneLeft, false);
    assert.equal(state.stopped, true);
  });
});

suite('the line naming refusals whose recording failed', () => {
  test('writes one warning for the failed recordings of one application, reason and failure code in an interval, carrying their count, once the interval ends', async (context) => {
    context.mock.timers.enable({ apis: ['setInterval'] });
    const { refusals, time, warnings } = standUp();
    const { recordings, trail } = heldTrail();
    const route = refusals.forRoute({ pendingLimit: 5, trail });
    const refusedByTheStore = Object.assign(
      new Error('the store refused "a value it quotes"'),
      { code: '57P01' },
    );

    ['digest-1', 'digest-2', 'digest-3'].forEach((digest) => {
      route.refused(refusal(digest));
    });
    recordings.forEach(({ fail }) => {
      fail(refusedByTheStore);
    });
    await settled();
    time.now += REJECTION_TALLY_INTERVAL_MILLISECONDS - 1000;
    context.mock.timers.tick(5000);
    const withinTheInterval = [...warnings];
    time.now += 1000;
    context.mock.timers.tick(1000);
    const onceItEnded = [...warnings];
    await refusals.stop();

    assert.deepEqual(withinTheInterval, []);
    assert.deepEqual(onceItEnded, [
      {
        fields: {
          applicationId: APPLICATION,
          code: '57P01',
          count: 3,
          reason: 'expiredAssertion',
        },
        message: 'channelAssertion.rejectionUnrecorded',
      },
    ]);
    assert.deepEqual(warnings, onceItEnded);
  });

  test('writes a line of its own for each application, reason and failure code, one naming no code for a failure carrying none, and none for a recording whose commit went unconfirmed, which it still counts', async (context) => {
    context.mock.timers.enable({ apis: ['setInterval'] });
    const { counted, refusals, time, warnings } = standUp();
    const { recordings, trail } = heldTrail();
    const route = refusals.forRoute({ pendingLimit: 10, trail });
    const failed: readonly { failure: unknown; refused: VerifiedRefusal }[] = [
      { failure: new StoreTimeout(), refused: refusal('digest-1') },
      { failure: new CommitUnconfirmed(), refused: refusal('digest-2') },
      {
        failure: new StoreTimeout(),
        refused: refusal('digest-3', 'otherAudience'),
      },
      {
        failure: new StoreTimeout(),
        refused: { ...refusal('digest-4'), applicationId: OTHER_APPLICATION },
      },
      { failure: new StoreTimeout(), refused: refusal('digest-5') },
      {
        failure: new Error('the connection ended'),
        refused: refusal('digest-6'),
      },
    ];

    failed.forEach(({ refused }) => {
      route.refused(refused);
    });
    recordings.forEach(({ fail }, index) => {
      fail(failed[index]?.failure);
    });
    await settled();
    time.now += REJECTION_TALLY_INTERVAL_MILLISECONDS;
    context.mock.timers.tick(1000);
    const onceItEnded = [...warnings];
    await refusals.stop();

    assert.deepEqual(
      onceItEnded.map(({ fields }) => fields),
      [
        {
          applicationId: APPLICATION,
          code: 'storeTimeout',
          count: 2,
          reason: 'expiredAssertion',
        },
        {
          applicationId: APPLICATION,
          code: 'storeTimeout',
          count: 1,
          reason: 'otherAudience',
        },
        {
          applicationId: OTHER_APPLICATION,
          code: 'storeTimeout',
          count: 1,
          reason: 'expiredAssertion',
        },
        { applicationId: APPLICATION, count: 1, reason: 'expiredAssertion' },
      ],
    );
    assert.deepEqual(warnings, onceItEnded);
    assert.equal(counted.length, failed.length);
  });

  test('writes nothing for an interval in which no recording failed', async (context) => {
    context.mock.timers.enable({ apis: ['setInterval'] });
    const { refusals, time, warnings } = standUp();
    const { recordings, trail } = heldTrail();
    const route = refusals.forRoute({ pendingLimit: 5, trail });

    route.refused(refusal('digest-1'));
    recordings[0]?.fail(new StoreTimeout());
    await settled();
    time.now += REJECTION_TALLY_INTERVAL_MILLISECONDS;
    context.mock.timers.tick(1000);
    route.refused(refusal('digest-2'));
    recordings[1]?.commit();
    await settled();
    time.now += REJECTION_TALLY_INTERVAL_MILLISECONDS;
    context.mock.timers.tick(1000);
    time.now += REJECTION_TALLY_INTERVAL_MILLISECONDS;
    context.mock.timers.tick(1000);
    await refusals.stop();

    assert.deepEqual(
      warnings.map(({ fields }) => fields),
      [
        {
          applicationId: APPLICATION,
          code: 'storeTimeout',
          count: 1,
          reason: 'expiredAssertion',
        },
      ],
    );
  });

  test('writes the count it holds when it stops, whatever the interval, once every recording has ended', async () => {
    const { refusals, warnings } = standUp();
    const { recordings, trail } = heldTrail();
    const route = refusals.forRoute({ pendingLimit: 5, trail });

    route.refused(refusal('digest-1'));
    route.refused(refusal('digest-2'));
    recordings[0]?.fail(new StoreTimeout());
    await settled();
    const beforeTheStop = [...warnings];
    const stopping = refusals.stop();
    recordings[1]?.fail(new StoreTimeout());
    await stopping;

    assert.deepEqual(beforeTheStop, []);
    assert.deepEqual(
      warnings.map(({ fields }) => fields),
      [
        {
          applicationId: APPLICATION,
          code: 'storeTimeout',
          count: 2,
          reason: 'expiredAssertion',
        },
      ],
    );
  });
});
