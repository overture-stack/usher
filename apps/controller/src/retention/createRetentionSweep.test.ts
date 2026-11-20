import assert from 'node:assert/strict';
import { suite, type TestContext, test } from 'node:test';

import pg from 'pg';

import { CLOCK_TOLERANCE_MILLISECONDS } from '../configuration/index.js';
import type { Actor, AuditEvent, AuditTransaction, TransactionOptions } from '../eventLog/index.js';
import { CommitUnconfirmed, StoreTimeout } from '../storeTimeout/index.js';
import {
	createRetentionSweep,
	RETENTION_SWEEP_FAILED,
	RETENTION_SWEEP_INTERVAL_MILLISECONDS,
	RETENTION_SWEEP_LOCK,
	RETENTION_SWEEP_ROWS_PER_TABLE,
} from './createRetentionSweep.js';
import type { RetentionSweep, RetentionSweepSettings } from './types.js';

// An instant far from the real clock's, so a cutoff read from the real clock cannot pass for it.
const CONFIGURED_NOW = Date.UTC(2031, 0, 2, 3, 4, 5, 678);

interface Statement {
	text: string;
	values: readonly unknown[] | undefined;
}

interface Line {
	fields: Readonly<Record<string, string>> | undefined;
	message: string;
}

/** One transaction the sweep asked the trail for: who acted, how it was bounded, and what it ran. */
interface Transaction {
	actor: Actor;
	options: TransactionOptions | undefined;
	recorded: AuditEvent[];
	statements: Statement[];
}

/** How the fake store answers one transaction: committing, failing, or held until the test lets it end. */
type Answer = { failure: unknown; kind: 'fails' } | { kind: 'commits'; locked: boolean } | { kind: 'held' };

interface FakeTrail {
	/** How each later transaction is answered, one each in turn; past them, each commits with its lock. */
	answerNext(...answers: readonly Answer[]): void;

	/** Commits the transaction held, its lock taken. */
	release(): void;

	trail: RetentionSweepSettings['trail'];
	transactions: Transaction[];
}

// Lets every callback already due run, timers aside.
const settled = (): Promise<void> =>
	new Promise((resolve) => {
		setImmediate(resolve);
	});

// A trail whose every transaction runs its work on a connection answering the sweep's lock as the
// test rules, then commits, fails, or waits for the test, keeping each statement and event.
const fakeTrail = (): FakeTrail => {
	const transactions: Transaction[] = [];
	const state: {
		answers: readonly Answer[];
		release: () => void;
	} = { answers: [], release: () => undefined };
	return {
		answerNext: (...answers) => {
			state.answers = answers;
		},
		release: () => state.release(),
		trail: {
			inTransaction: async <Result>(
				actor: Actor,
				work: (transaction: AuditTransaction<pg.ClientBase>) => Promise<Result>,
				options?: TransactionOptions,
			): Promise<Result> => {
				const [answer = { kind: 'commits', locked: true }, ...later] = state.answers;
				state.answers = later;
				const transaction: Transaction = {
					actor,
					options,
					recorded: [],
					statements: [],
				};
				transactions.push(transaction);
				if (answer.kind === 'fails') {
					throw answer.failure;
				}
				if (answer.kind === 'held') {
					await new Promise<void>((resolve) => {
						state.release = resolve;
					});
				}
				const locked = answer.kind === 'held' || answer.locked;
				const query = async (text: string, values?: readonly unknown[]) => {
					transaction.statements.push({ text, values });
					return {
						rows: text.includes('pg_try_advisory_xact_lock') ? [{ locked }] : [],
					};
				};
				return work({
					// A client that never connects, its query answered here: the client's overloads are more
					// than a fake can spell out.
					connection: Object.assign(new pg.Client(), { query }),
					record: async (event) => {
						transaction.recorded.push(event);
						return 'event-id';
					},
				});
			},
		},
		transactions,
	};
};

const collectingLog = (): {
	lines: Line[];
	log: RetentionSweepSettings['log'];
} => {
	const lines: Line[] = [];
	return {
		lines,
		log: {
			error: (message, fields) => {
				lines.push({ fields, message });
			},
		},
	};
};

const sweepFor = (
	context: TestContext,
	trail: FakeTrail,
	log: RetentionSweepSettings['log'] = collectingLog().log,
): RetentionSweep => {
	const sweep = createRetentionSweep({
		clock: { now: () => CONFIGURED_NOW },
		log,
		schema: 'usher',
		trail: trail.trail,
	});
	context.after(() => sweep.stop());
	return sweep;
};

// Moves the mocked timers past one interval and lets the run it starts reach the store.
const passInterval = async (context: TestContext): Promise<void> => {
	context.mock.timers.tick(RETENTION_SWEEP_INTERVAL_MILLISECONDS);
	await settled();
};

suite('the retention sweep', () => {
	test('runs every 1,000 ms of real time, the first one interval after its start', () => {
		assert.equal(RETENTION_SWEEP_INTERVAL_MILLISECONDS, 1000);
	});

	test('begins each run one interval after the one before has ended, never running two at once', async (context) => {
		context.mock.timers.enable({ apis: ['setTimeout'] });
		const trail = fakeTrail();
		const sweep = sweepFor(context, trail);
		trail.answerNext({ kind: 'held' });

		sweep.start();
		context.mock.timers.tick(RETENTION_SWEEP_INTERVAL_MILLISECONDS - 1);
		await settled();
		const beforeTheInterval = trail.transactions.length;
		context.mock.timers.tick(1);
		await settled();
		const atTheInterval = trail.transactions.length;
		context.mock.timers.tick(10 * RETENTION_SWEEP_INTERVAL_MILLISECONDS);
		await settled();
		const whileHeld = trail.transactions.length;
		trail.release();
		await settled();
		context.mock.timers.tick(RETENTION_SWEEP_INTERVAL_MILLISECONDS - 1);
		await settled();
		const justBeforeTheNext = trail.transactions.length;
		context.mock.timers.tick(1);
		await settled();

		assert.deepEqual([beforeTheInterval, atTheInterval, whileHeld, justBeforeTheNext], [0, 1, 1, 1]);
		assert.equal(trail.transactions.length, 2);
	});

	test("takes its lock, deletes at most 1,000 exchanged sessions expired before the configured clock's now, then at most 1,000 sign-outs of each table, then 1,000 grant operations and 1,000 used channel assertions expired more than the clock tolerance before it, then trims at most 1,000 notices, in one transaction as the system within the store timeout", async (context) => {
		context.mock.timers.enable({ apis: ['setTimeout'] });
		const trail = fakeTrail();
		const collected = collectingLog();
		const sweep = sweepFor(context, trail, collected.log);
		const deletionOf = (table: string, cutoff: Date): Statement => ({
			text: `DELETE FROM "usher"."${table}" WHERE ctid IN (SELECT ctid FROM "usher"."${table}" WHERE "expires_at" < $1 LIMIT $2)`,
			values: [cutoff, RETENTION_SWEEP_ROWS_PER_TABLE],
		});
		const usedAssertionDeletion = (cutoff: Date): Statement => ({
			text: `DELETE FROM "usher"."used_channel_assertions" WHERE ctid IN (SELECT ctid FROM "usher"."used_channel_assertions" WHERE "accepted_until" < $1 LIMIT $2)`,
			values: [cutoff, RETENTION_SWEEP_ROWS_PER_TABLE],
		});
		const signOutCutoff = new Date(CONFIGURED_NOW - CLOCK_TOLERANCE_MILLISECONDS);

		sweep.start();
		await passInterval(context);

		assert.equal(RETENTION_SWEEP_ROWS_PER_TABLE, 1000);
		assert.equal(trail.transactions.length, 1);
		const [transaction] = trail.transactions;
		assert.deepEqual(transaction?.actor, { type: 'system' });
		assert.equal(transaction?.options, undefined);
		assert.deepEqual(transaction?.recorded, []);
		const [lock, sessions, sidSignOuts, subjectSignOuts, grantOperations, usedAssertions, trim, ...beyond] =
			transaction?.statements ?? [];
		assert.deepEqual(lock, {
			text: 'SELECT pg_try_advisory_xact_lock($1) AS locked',
			values: [RETENTION_SWEEP_LOCK],
		});
		assert.deepEqual(sessions, deletionOf('exchanged_sids', new Date(CONFIGURED_NOW)));
		assert.deepEqual(sidSignOuts, deletionOf('sid_sign_outs', signOutCutoff));
		assert.deepEqual(subjectSignOuts, deletionOf('subject_sign_outs', signOutCutoff));
		assert.deepEqual(grantOperations, deletionOf('grant_operations', signOutCutoff));
		assert.deepEqual(usedAssertions, usedAssertionDeletion(signOutCutoff));
		assert.deepEqual(trim, {
			text: 'SELECT "usher"."trim_notices"($1::integer)',
			values: [RETENTION_SWEEP_ROWS_PER_TABLE],
		});
		assert.deepEqual(beyond, []);
		assert.deepEqual(collected.lines, []);
	});

	test('ends a run at once, deleting and trimming nothing, when another session holds its lock', async (context) => {
		context.mock.timers.enable({ apis: ['setTimeout'] });
		const trail = fakeTrail();
		const collected = collectingLog();
		const sweep = sweepFor(context, trail, collected.log);
		trail.answerNext({ kind: 'commits', locked: false });

		sweep.start();
		await passInterval(context);
		await passInterval(context);

		assert.deepEqual(
			trail.transactions.map(({ statements }) => statements.map(({ text }) => text.split(' ')[0])),
			[['SELECT'], ['SELECT', 'DELETE', 'DELETE', 'DELETE', 'DELETE', 'DELETE', 'SELECT']],
		);
		assert.deepEqual(collected.lines, []);
	});

	test('writes one line naming the failure by its code as runs start failing, none while they go on failing, and another only once a run has succeeded and a later one fails', async (context) => {
		context.mock.timers.enable({ apis: ['setTimeout'] });
		const trail = fakeTrail();
		const collected = collectingLog();
		const sweep = sweepFor(context, trail, collected.log);
		const refused = Object.assign(new Error('permission denied for table'), {
			code: '42501',
		});
		trail.answerNext(
			{ failure: refused, kind: 'fails' },
			{ failure: refused, kind: 'fails' },
			{ failure: new StoreTimeout(), kind: 'fails' },
			{ kind: 'commits', locked: true },
			{ failure: new StoreTimeout(), kind: 'fails' },
			{ failure: new CommitUnconfirmed(), kind: 'fails' },
			{ kind: 'commits', locked: false },
			{ failure: new CommitUnconfirmed(), kind: 'fails' },
		);

		sweep.start();
		const linesAfterEachRun = await Array.from({ length: 8 }).reduce<Promise<readonly number[]>>(
			async (earlier) => {
				const counts = await earlier;
				await passInterval(context);
				return [...counts, collected.lines.length];
			},
			Promise.resolve([]),
		);

		assert.equal(trail.transactions.length, 8);
		assert.deepEqual(linesAfterEachRun, [1, 1, 1, 1, 2, 2, 2, 3]);
		assert.deepEqual(collected.lines, [
			{ fields: { cause: '42501' }, message: RETENTION_SWEEP_FAILED },
			{ fields: { cause: 'storeTimeout' }, message: RETENTION_SWEEP_FAILED },
			{
				fields: { cause: 'commitUnconfirmed' },
				message: RETENTION_SWEEP_FAILED,
			},
		]);
	});

	test("names a failure carrying no code, or a code that is no identifier, as storeFailed, never writing the failure's message", async (context) => {
		context.mock.timers.enable({ apis: ['setTimeout'] });
		const trail = fakeTrail();
		const collected = collectingLog();
		const sweep = sweepFor(context, trail, collected.log);
		trail.answerNext(
			{ failure: new Error("a value: 'quoted'"), kind: 'fails' },
			{ kind: 'commits', locked: true },
			{
				failure: Object.assign(new Error('refused'), {
					code: "a value: 'quoted'",
				}),
				kind: 'fails',
			},
		);

		sweep.start();
		await passInterval(context);
		await passInterval(context);
		await passInterval(context);

		assert.equal(RETENTION_SWEEP_FAILED, 'retention.sweepFailed');
		assert.deepEqual(collected.lines, [
			{ fields: { cause: 'storeFailed' }, message: RETENTION_SWEEP_FAILED },
			{ fields: { cause: 'storeFailed' }, message: RETENTION_SWEEP_FAILED },
		]);
	});

	test('settles its stop once the run in flight has ended, and begins no run after', async (context) => {
		context.mock.timers.enable({ apis: ['setTimeout'] });
		const trail = fakeTrail();
		const sweep = sweepFor(context, trail);
		trail.answerNext({ kind: 'held' });
		sweep.start();
		await passInterval(context);
		const stopState = { settled: false };

		const stopping = sweep.stop().then(() => {
			stopState.settled = true;
		});
		await settled();
		const settledWhileHeld = stopState.settled;
		trail.release();
		await stopping;
		context.mock.timers.tick(10 * RETENTION_SWEEP_INTERVAL_MILLISECONDS);
		await settled();

		assert.equal(settledWhileHeld, false);
		assert.equal(trail.transactions.length, 1);
		assert.deepEqual(
			trail.transactions[0]?.statements.map(({ text }) => text.split(' ')[0]),
			['SELECT', 'DELETE', 'DELETE', 'DELETE', 'DELETE', 'DELETE', 'SELECT'],
		);
	});

	test('begins no run once stopped, a start then included, nor a second run for a second start', async (context) => {
		context.mock.timers.enable({ apis: ['setTimeout'] });
		const twice = fakeTrail();
		const stopped = fakeTrail();
		const startedTwice = sweepFor(context, twice);
		const stoppedFirst = sweepFor(context, stopped);

		startedTwice.start();
		startedTwice.start();
		await stoppedFirst.stop();
		stoppedFirst.start();
		await passInterval(context);

		assert.equal(twice.transactions.length, 1);
		assert.equal(stopped.transactions.length, 0);
	});
});
