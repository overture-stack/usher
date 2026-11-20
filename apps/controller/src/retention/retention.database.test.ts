import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import pg from 'pg';

import { fixedClock } from '../../testing/peripherals/clocks.js';
import { captureLog, type LogCapture } from '../../testing/harness/controller.js';
import { type Harness, startReadOnlyInstance, suiteHarness, withHarness } from '../../testing/harness/harness.js';
import {
	GRANT_OPERATIONS,
	holdRetentionSweep,
	POLICY_TABLES,
	qualified,
	RETENTION_SWEEP,
} from '../../testing/harness/policy.js';
import { cleanupFor, eventually } from '../../testing/harness/waiting.js';

const { exchangedSids, sidSignOuts, subjectSignOuts, usedChannelAssertions } = POLICY_TABLES;

const HOUR_MILLISECONDS = 3_600_000;

// Long enough for a run to begin after the one before has ended and to finish, twice over.
const RUNS_WITHIN_MILLISECONDS = 3 * RETENTION_SWEEP.intervalMilliseconds;

const quoted = (column: string): string => pg.escapeIdentifier(column);

// The messages of the operational lines a log stream took.
const messagesIn = (log: LogCapture): readonly unknown[] =>
	log.lines().map((line): unknown => {
		const parsed: unknown = JSON.parse(line);
		return typeof parsed === 'object' && parsed !== null && 'message' in parsed ? parsed.message : undefined;
	});

/**
 * Rows of one test's own in one table, told apart from every other test's by the prefix of their
 * key.
 */
interface OwnRows {
	/** How many of them the store holds now. */
	held(): Promise<number>;

	/** Records rows under the harness's issuer, each expiring at the instant given. */
	record(count: number, expiresAt: Date): Promise<void>;
}

// How many rows of a table the store holds whose key starts with the prefix.
const heldWithPrefix = async (
	client: pg.ClientBase,
	table: { name: string },
	key: string,
	prefix: string,
): Promise<number> => {
	const { rows } = await client.query<{ held: number }>(
		`SELECT count(*)::int AS held FROM ${qualified(table)} WHERE starts_with(${quoted(key)}, $1)`,
		[prefix],
	);
	return rows[0]?.held ?? 0;
};

const sessionsOf = (harness: Harness, client: pg.ClientBase): OwnRows => {
	const prefix = `${randomUUID()}:`;
	const { columns } = exchangedSids;
	return {
		held: () => heldWithPrefix(client, exchangedSids, columns.sid, prefix),
		record: async (count, expiresAt) => {
			await client.query(
				`INSERT INTO ${qualified(exchangedSids)} (${quoted(columns.idpIssuer)}, ${quoted(columns.sid)}, ${quoted(columns.idpSubjectId)}, ${quoted(columns.expiresAt)})
         SELECT $1, $2 || gen_random_uuid(), 'retention-subject', $3 FROM generate_series(1, $4)`,
				[harness.configuration.identityProviderIssuer, prefix, expiresAt, count],
			);
		},
	};
};

// Each sign-out table, with the column beside the issuer in its key, which tells one test's rows
// apart from another's.
const SIGN_OUT_TABLES = [
	{ key: sidSignOuts.columns.sid, table: sidSignOuts },
	{ key: subjectSignOuts.columns.idpSubjectId, table: subjectSignOuts },
] as const;

type SignOutTable = (typeof SIGN_OUT_TABLES)[number];

const signOutsOf = (harness: Harness, client: pg.ClientBase, { key, table }: SignOutTable): OwnRows => {
	const prefix = `${randomUUID()}:`;
	const { columns } = table;
	return {
		held: () => heldWithPrefix(client, table, key, prefix),
		record: async (count, expiresAt) => {
			await client.query(
				`INSERT INTO ${qualified(table)} (${quoted(columns.idpIssuer)}, ${quoted(key)}, ${quoted(columns.signedOutAt)}, ${quoted(columns.expiresAt)})
         SELECT $1, $2 || gen_random_uuid(), $3, $4 FROM generate_series(1, $5)`,
				[
					harness.configuration.identityProviderIssuer,
					prefix,
					new Date(expiresAt.getTime() - HOUR_MILLISECONDS),
					expiresAt,
					count,
				],
			);
		},
	};
};

// Grant operations counted for subjects of one test's own, each counted an hour before its expiry.
const grantOperationsOf = (harness: Harness, client: pg.ClientBase): OwnRows => {
	const prefix = `${randomUUID()}:`;
	const { columns } = GRANT_OPERATIONS;
	return {
		held: () => heldWithPrefix(client, GRANT_OPERATIONS, columns.idpSubjectId, prefix),
		record: async (count, expiresAt) => {
			await client.query(
				`INSERT INTO ${qualified(GRANT_OPERATIONS)}
           (${quoted(columns.idpIssuer)}, ${quoted(columns.idpSubjectId)},
            ${quoted(columns.occurredAt)}, ${quoted(columns.expiresAt)})
         SELECT $1, $2 || gen_random_uuid(), $3, $4 FROM generate_series(1, $5)`,
				[
					harness.configuration.identityProviderIssuer,
					prefix,
					new Date(expiresAt.getTime() - HOUR_MILLISECONDS),
					expiresAt,
					count,
				],
			);
		},
	};
};

// One test's own rows in every table the sweep deletes from, in the order it deletes from them.
const sweptRowsOf = (harness: Harness, client: pg.ClientBase): readonly OwnRows[] => [
	sessionsOf(harness, client),
	...SIGN_OUT_TABLES.map((table) => signOutsOf(harness, client, table)),
	grantOperationsOf(harness, client),
];

// One connection runs one query at a time, so the counts are read in turn, each after the one before.
const heldIn = (tables: readonly OwnRows[]): Promise<readonly number[]> =>
	tables.reduce<Promise<readonly number[]>>(
		(previous, rows) => previous.then(async (done) => [...done, await rows.held()]),
		Promise.resolve([]),
	);

suite('the retention sweep against the store', () => {
	const shared = suiteHarness({ applications: [] });

	test('deletes the exchanged sessions whose sign-in tokens have expired, and keeps those still live', async () => {
		const harness = await shared();
		const expired = sessionsOf(harness, harness.clients.migration);
		const live = sessionsOf(harness, harness.clients.migration);
		await expired.record(3, new Date(Date.now() - HOUR_MILLISECONDS));
		await live.record(2, new Date(Date.now() + HOUR_MILLISECONDS));

		const gone = await eventually(async () => (await expired.held()) === 0, RUNS_WITHIN_MILLISECONDS, 20);

		assert.equal(gone, true, 'the expired sessions outlived the sweep');
		assert.equal(await live.held(), 2);
	});

	test('deletes at most 1,000 expired rows from each table in one run, and the rest in the next', async (context) => {
		const harness = await shared();
		const holder = await harness.database.connect('migration');
		cleanupFor(context).defer(() => holder.end());
		const tables = sweptRowsOf(harness, harness.clients.migration);
		const backlog = RETENTION_SWEEP.rowsPerRun + 500;
		const hold = await holdRetentionSweep(holder);
		await tables.reduce<Promise<unknown>>(
			(previous, rows) => previous.then(() => rows.record(backlog, new Date(Date.now() - HOUR_MILLISECONDS))),
			Promise.resolve(),
		);

		await hold.release();
		const firstRunEnded = await eventually(
			async () => (await heldIn(tables)).some((held) => held < backlog),
			RUNS_WITHIN_MILLISECONDS,
			20,
		);
		const afterFirstRun = await heldIn(tables);
		const drained = await eventually(
			async () => (await heldIn(tables)).every((held) => held === 0),
			RUNS_WITHIN_MILLISECONDS,
			20,
		);

		assert.equal(firstRunEnded, true, 'no run deleted an expired row');
		assert.deepEqual(
			afterFirstRun,
			tables.map(() => backlog - RETENTION_SWEEP.rowsPerRun),
		);
		assert.equal(drained, true, 'the next run left expired rows behind');
	});

	test('deletes nothing while another session holds its lock', async (context) => {
		const harness = await shared();
		const holder = await harness.database.connect('migration');
		cleanupFor(context).defer(() => holder.end());
		const tables = sweptRowsOf(harness, harness.clients.migration);
		const hold = await holdRetentionSweep(holder);
		await tables.reduce<Promise<unknown>>(
			(previous, rows) => previous.then(() => rows.record(5, new Date(Date.now() - HOUR_MILLISECONDS))),
			Promise.resolve(),
		);

		await delay(RUNS_WITHIN_MILLISECONDS);
		const whileHeld = await heldIn(tables);
		await hold.release();
		const goneOnceReleased = await eventually(
			async () => (await heldIn(tables)).every((held) => held === 0),
			RUNS_WITHIN_MILLISECONDS,
			20,
		);

		assert.deepEqual(
			whileHeld,
			tables.map(() => 5),
		);
		assert.equal(goneOnceReleased, true, 'the sweep deleted nothing once the lock was released');
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
				await passedOnTheClock.record(2, new Date(Date.now() + HOUR_MILLISECONDS));
				await liveOnTheClock.record(2, new Date(Date.now() + 3 * HOUR_MILLISECONDS));

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

	test("keeps a sign-out of either table until its expiry is more than the clock tolerance before the configured clock's now", async (context) => {
		const now = Date.now() + 2 * HOUR_MILLISECONDS;
		const cutoff = now - RETENTION_SWEEP.clockToleranceMilliseconds;
		await withHarness(
			{ applications: [], configuration: { clock: fixedClock(now) } },
			async (harness) => {
				const client = harness.clients.migration;
				const tables = SIGN_OUT_TABLES.map((table) => ({
					atTolerance: signOutsOf(harness, client, table),
					pastTolerance: signOutsOf(harness, client, table),
					withinTolerance: signOutsOf(harness, client, table),
				}));
				await tables
					.flatMap(({ atTolerance, pastTolerance, withinTolerance }) => [
						() => atTolerance.record(1, new Date(cutoff)),
						() => pastTolerance.record(1, new Date(cutoff - 1)),
						() => withinTolerance.record(1, new Date(cutoff + 1)),
					])
					.reduce<Promise<unknown>>((previous, record) => previous.then(record), Promise.resolve());

				const gone = await eventually(
					async () =>
						(await heldIn(tables.map(({ pastTolerance }) => pastTolerance))).every((held) => held === 0),
					RUNS_WITHIN_MILLISECONDS,
					20,
				);

				assert.equal(gone, true, 'a sign-out more than the clock tolerance past its expiry outlived the sweep');
				assert.deepEqual(
					await heldIn(tables.flatMap(({ atTolerance, withinTolerance }) => [atTolerance, withinTolerance])),
					[1, 1, 1, 1],
				);
			},
			context,
		);
	});

	test("keeps a used channel assertion until its accepted_until is more than the clock tolerance before the configured clock's now", async (context) => {
		// The clock starts now, so the harness's application registration is answered with a current token.
		const now = Date.now();
		const cutoff = now - RETENTION_SWEEP.clockToleranceMilliseconds;
		await withHarness(
			{ applications: ['Assertion retention'], configuration: { clock: fixedClock(now) } },
			async (harness) => {
				const client = harness.clients.migration;
				const applicationId = harness.application('Assertion retention').id;
				// Each test's own rows, told apart from every other test's by the prefix of their jti.
				const prefix = `${randomUUID()}:`;
				const recordAt = async (jti: string, acceptedUntil: number): Promise<void> => {
					await client.query(
						`INSERT INTO ${qualified(usedChannelAssertions)} (application_id, assertion_id, accepted_until)
         VALUES ($1, $2, $3)`,
						[applicationId, `${prefix}${jti}`, new Date(acceptedUntil)],
					);
				};
				const heldOf = (jti: string): Promise<number> =>
					heldWithPrefix(
						client,
						usedChannelAssertions,
						usedChannelAssertions.columns.assertionId,
						`${prefix}${jti}`,
					);
				await recordAt('past-tolerance', cutoff - 1);
				await recordAt('at-tolerance', cutoff);
				await recordAt('within-tolerance', cutoff + 1);

				const gone = await eventually(
					async () => (await heldOf('past-tolerance')) === 0,
					RUNS_WITHIN_MILLISECONDS,
					20,
				);

				assert.equal(
					gone,
					true,
					'a used assertion more than the clock tolerance past its accepted_until outlived the sweep',
				);
				assert.deepEqual([await heldOf('at-tolerance'), await heldOf('within-tolerance')], [1, 1]);
			},
			context,
		);
	});
});

suite("the retention sweep of the grant rate's count", () => {
	test("keeps a grant operation until its expiry is more than the clock tolerance before the configured clock's now", async (context) => {
		const now = Date.now() + 2 * HOUR_MILLISECONDS;
		const cutoff = now - RETENTION_SWEEP.clockToleranceMilliseconds;
		await withHarness(
			{ applications: [], configuration: { clock: fixedClock(now) } },
			async (harness) => {
				const client = harness.clients.migration;
				const atTolerance = grantOperationsOf(harness, client);
				const pastTolerance = grantOperationsOf(harness, client);
				const withinTolerance = grantOperationsOf(harness, client);
				await atTolerance.record(1, new Date(cutoff));
				await pastTolerance.record(2, new Date(cutoff - 1));
				await withinTolerance.record(1, new Date(cutoff + 1));

				const gone = await eventually(
					async () => (await pastTolerance.held()) === 0,
					RUNS_WITHIN_MILLISECONDS,
					20,
				);

				assert.equal(
					gone,
					true,
					'a grant operation more than the clock tolerance past its expiry outlived the sweep',
				);
				assert.deepEqual(await heldIn([atTolerance, withinTolerance]), [1, 1]);
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
				const reading = await startReadOnlyInstance(cleanupFor(context), harness, {
					logStream: log.stream,
				});

				await delay(RUNS_WITHIN_MILLISECONDS);
				await reading.stop();

				assert.equal(messagesIn(log).includes(RETENTION_SWEEP.failedLine), false);
			},
			context,
		);
	});
});
