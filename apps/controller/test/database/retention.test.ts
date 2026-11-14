import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import pg from 'pg';

import { fixedClock } from '../../test-support/clocks.js';
import { captureLog, type LogCapture } from '../../test-support/controller.js';
import {
  type Harness,
  startReadOnlyInstance,
  suiteHarness,
  withHarness,
} from '../../test-support/harness.js';
import {
  holdRetentionSweep,
  POLICY_TABLES,
  qualified,
  RETENTION_SWEEP,
} from '../../test-support/policy.js';
import { cleanupFor, eventually } from '../../test-support/waiting.js';

const { exchangedSids } = POLICY_TABLES;

const HOUR_MILLISECONDS = 3_600_000;

// Long enough for a run to begin after the one before has ended and to finish, twice over.
const RUNS_WITHIN_MILLISECONDS = 3 * RETENTION_SWEEP.intervalMilliseconds;

const quoted = (column: string): string => pg.escapeIdentifier(column);

// The messages of the operational lines a log stream took.
const messagesIn = (log: LogCapture): readonly unknown[] =>
  log.lines().map((line): unknown => {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null && 'message' in parsed
      ? parsed.message
      : undefined;
  });

/** Sessions of one test's own, told apart from every other test's by the prefix of their `sid`. */
interface Sessions {
  /** How many of them the store holds now. */
  held(): Promise<number>;

  /** Records sessions under the harness's issuer, each expiring at the instant given. */
  record(count: number, expiresAt: Date): Promise<void>;
}

const sessionsOf = (harness: Harness, client: pg.ClientBase): Sessions => {
  const prefix = `${randomUUID()}:`;
  const { columns } = exchangedSids;
  return {
    held: async () => {
      const { rows } = await client.query<{ held: number }>(
        `SELECT count(*)::int AS held FROM ${qualified(exchangedSids)} WHERE starts_with(${quoted(columns.sid)}, $1)`,
        [prefix],
      );
      return rows[0]?.held ?? 0;
    },
    record: async (count, expiresAt) => {
      await client.query(
        `INSERT INTO ${qualified(exchangedSids)} (${quoted(columns.idpIssuer)}, ${quoted(columns.sid)}, ${quoted(columns.idpSubjectId)}, ${quoted(columns.expiresAt)})
         SELECT $1, $2 || gen_random_uuid(), 'retention-subject', $3 FROM generate_series(1, $4)`,
        [
          harness.configuration.identityProviderIssuer,
          prefix,
          expiresAt,
          count,
        ],
      );
    },
  };
};

suite('the retention sweep against the store', () => {
  const shared = suiteHarness({ applications: [] });

  test('deletes the exchanged sessions whose sign-in tokens have expired, and keeps those still live', async () => {
    const harness = await shared();
    const expired = sessionsOf(harness, harness.clients.migration);
    const live = sessionsOf(harness, harness.clients.migration);
    await expired.record(3, new Date(Date.now() - HOUR_MILLISECONDS));
    await live.record(2, new Date(Date.now() + HOUR_MILLISECONDS));

    const gone = await eventually(
      async () => (await expired.held()) === 0,
      RUNS_WITHIN_MILLISECONDS,
      20,
    );

    assert.equal(gone, true, 'the expired sessions outlived the sweep');
    assert.equal(await live.held(), 2);
  });

  test('deletes at most 1,000 expired sessions in one run, and the rest in the next', async (context) => {
    const harness = await shared();
    const holder = await harness.database.connect('migration');
    cleanupFor(context).defer(() => holder.end());
    const sessions = sessionsOf(harness, harness.clients.migration);
    const backlog = RETENTION_SWEEP.rowsPerRun + 500;
    const hold = await holdRetentionSweep(holder);
    await sessions.record(backlog, new Date(Date.now() - HOUR_MILLISECONDS));

    await hold.release();
    const firstRunEnded = await eventually(
      async () => (await sessions.held()) < backlog,
      RUNS_WITHIN_MILLISECONDS,
      20,
    );
    const afterFirstRun = await sessions.held();
    const drained = await eventually(
      async () => (await sessions.held()) === 0,
      RUNS_WITHIN_MILLISECONDS,
      20,
    );

    assert.equal(firstRunEnded, true, 'no run deleted an expired session');
    assert.equal(afterFirstRun, backlog - RETENTION_SWEEP.rowsPerRun);
    assert.equal(drained, true, 'the next run left expired sessions behind');
  });

  test('deletes nothing while another session holds its lock', async (context) => {
    const harness = await shared();
    const holder = await harness.database.connect('migration');
    cleanupFor(context).defer(() => holder.end());
    const sessions = sessionsOf(harness, harness.clients.migration);
    const hold = await holdRetentionSweep(holder);
    await sessions.record(5, new Date(Date.now() - HOUR_MILLISECONDS));

    await delay(RUNS_WITHIN_MILLISECONDS);
    const whileHeld = await sessions.held();
    await hold.release();
    const goneOnceReleased = await eventually(
      async () => (await sessions.held()) === 0,
      RUNS_WITHIN_MILLISECONDS,
      20,
    );

    assert.equal(whileHeld, 5);
    assert.equal(
      goneOnceReleased,
      true,
      'the sweep deleted nothing once the lock was released',
    );
  });
});

suite("the retention sweep on the controller's configured clock", () => {
  test("counts a session as expired by the configured clock, not the store's", async (context) => {
    await withHarness(
      {
        applications: [],
        configuration: {
          clock: fixedClock(Date.now() + 2 * HOUR_MILLISECONDS),
        },
      },
      async (harness) => {
        const passedOnTheClock = sessionsOf(harness, harness.clients.migration);
        const liveOnTheClock = sessionsOf(harness, harness.clients.migration);
        await passedOnTheClock.record(
          2,
          new Date(Date.now() + HOUR_MILLISECONDS),
        );
        await liveOnTheClock.record(
          2,
          new Date(Date.now() + 3 * HOUR_MILLISECONDS),
        );

        const gone = await eventually(
          async () => (await passedOnTheClock.held()) === 0,
          RUNS_WITHIN_MILLISECONDS,
          20,
        );

        assert.equal(gone, true, "the sweep read expiry on the store's clock");
        assert.equal(await liveOnTheClock.held(), 2);
      },
      context,
    );
  });
});

suite('the retention sweep on an instance whose role may only read', () => {
  test('runs none, so writes no line for runs that could only fail', async (context) => {
    await withHarness(
      { applications: [] },
      async (harness) => {
        const log = captureLog();
        await harness.stopController();
        const reading = await startReadOnlyInstance(
          cleanupFor(context),
          harness,
          {
            logStream: log.stream,
          },
        );

        await delay(RUNS_WITHIN_MILLISECONDS);
        await reading.stop();

        assert.equal(
          messagesIn(log).includes(RETENTION_SWEEP.failedLine),
          false,
        );
      },
      context,
    );
  });
});
