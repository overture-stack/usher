import pg from 'pg';

import { CLOCK_TOLERANCE_MILLISECONDS } from '../configuration/index.js';
import type { Actor } from '../eventLog/index.js';
import { failureCodeOf } from '../failures/index.js';
import type { RetentionSweep, RetentionSweepSettings } from './types.js';

/** How long after a run has ended the next one begins, in milliseconds of real time: 1 s. */
export const RETENTION_SWEEP_INTERVAL_MILLISECONDS = 1000;

/**
 * The line written at error as runs start failing, naming the failure's `cause` alone; none is
 * written again until a run has succeeded.
 */
export const RETENTION_SWEEP_FAILED = 'retention.sweepFailed';

/**
 * The key of the transaction-scoped advisory lock each run takes first, so one sweep runs at a time
 * across the instances sharing a store.
 */
export const RETENTION_SWEEP_LOCK = 8_617_207_004;

/** The most rows one run deletes from each table it sweeps, and the most notices its trim deletes. */
export const RETENTION_SWEEP_ROWS_PER_TABLE = 1000;

// The cause naming a failure that carries no code of its own.
const STORE_FAILED = 'storeFailed';

const SYSTEM: Actor = Object.freeze({ type: 'system' });

/**
 * A table whose rows are deleted once expired: the column holding each row's expiry, and how long
 * past that expiry, in milliseconds on the configured clock, a row is kept.
 */
interface SweptTable {
	expiryColumn: string;
	marginMilliseconds: number;
	name: string;
}

const SWEPT_TABLES: readonly SweptTable[] = [
	{ expiryColumn: 'expires_at', marginMilliseconds: 0, name: 'exchanged_sids' },
	{
		expiryColumn: 'expires_at',
		marginMilliseconds: CLOCK_TOLERANCE_MILLISECONDS,
		name: 'sid_sign_outs',
	},
	{
		expiryColumn: 'expires_at',
		marginMilliseconds: CLOCK_TOLERANCE_MILLISECONDS,
		name: 'subject_sign_outs',
	},
	{
		expiryColumn: 'expires_at',
		marginMilliseconds: CLOCK_TOLERANCE_MILLISECONDS,
		name: 'grant_operations',
	},
	{
		expiryColumn: 'accepted_until',
		marginMilliseconds: CLOCK_TOLERANCE_MILLISECONDS,
		name: 'used_channel_assertions',
	},
];

/**
 * Creates the retention sweep. Each run is one transaction, as the system and recording no
 * event, which first tries the advisory lock {@link RETENTION_SWEEP_LOCK} and ends at once,
 * deleting nothing, while another session holds it. Holding it, the run reads the configured
 * clock once and deletes at most {@link RETENTION_SWEEP_ROWS_PER_TABLE} rows from each table,
 * in this order: those of `exchanged_sids` whose `expires_at` is before that reading, then
 * those of `sid_sign_outs`, of `subject_sign_outs` and then of `grant_operations` whose
 * `expires_at` is more than {@link CLOCK_TOLERANCE_MILLISECONDS} before it, then those of `used_channel_assertions`
 * whose `accepted_until` is more than {@link CLOCK_TOLERANCE_MILLISECONDS} before it. It then calls `trim_notices` with that same
 * bound, which must delete at most that many notices older than the retention floor. The first
 * run begins {@link RETENTION_SWEEP_INTERVAL_MILLISECONDS} after the start, and each later one
 * that long after the one before it has ended, so no two overlap. A run that fails is written
 * as {@link RETENTION_SWEEP_FAILED} naming its `cause`: the failure's code, a SQLSTATE, a system
 * error's or the Controller's own such as `storeTimeout`, or `storeFailed` for a failure carrying
 * none. It is written as runs start failing and not again until a run has succeeded, and a run that
 * succeeds writes nothing.
 *
 * @param settings the trail each run's transaction runs on, the schema, the clock and the log.
 */
export const createRetentionSweep = ({ clock, log, schema, trail }: RetentionSweepSettings): RetentionSweep => {
	const qualified = (name: string): string => `${pg.escapeIdentifier(schema)}.${pg.escapeIdentifier(name)}`;
	const deletions = SWEPT_TABLES.map(({ expiryColumn, marginMilliseconds, name }) => {
		const table = qualified(name);
		return {
			marginMilliseconds,
			text: `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${pg.escapeIdentifier(expiryColumn)} < $1 LIMIT $2)`,
		};
	});
	const trim = `SELECT ${qualified('trim_notices')}($1::integer)`;

	const state: {
		failing: boolean;
		running: Promise<void> | undefined;
		stopped: boolean;
		timer: ReturnType<typeof setTimeout> | undefined;
	} = { failing: false, running: undefined, stopped: false, timer: undefined };

	const sweep = async (connection: pg.ClientBase): Promise<void> => {
		const { rows } = await connection.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS locked', [
			RETENTION_SWEEP_LOCK,
		]);
		if (rows[0]?.locked === true) {
			const now = clock.now();
			await deletions.reduce<Promise<void>>(async (earlier, { marginMilliseconds, text }) => {
				await earlier;
				await connection.query(text, [new Date(now - marginMilliseconds), RETENTION_SWEEP_ROWS_PER_TABLE]);
			}, Promise.resolve());
			await connection.query(trim, [RETENTION_SWEEP_ROWS_PER_TABLE]);
		}
	};

	const runOnce = async (): Promise<void> => {
		try {
			await trail.inTransaction(SYSTEM, ({ connection }) => sweep(connection));
			state.failing = false;
		} catch (failure) {
			if (!state.failing) {
				log.error(RETENTION_SWEEP_FAILED, {
					cause: failureCodeOf(failure) ?? STORE_FAILED,
				});
			}
			state.failing = true;
		}
	};

	const schedule = (): void => {
		if (!state.stopped) {
			state.timer = setTimeout(() => {
				state.timer = undefined;
				state.running = runOnce().finally(() => {
					state.running = undefined;
					schedule();
				});
			}, RETENTION_SWEEP_INTERVAL_MILLISECONDS);
			state.timer.unref();
		}
	};

	return {
		start: () => {
			if (state.timer === undefined && state.running === undefined) {
				schedule();
			}
		},
		stop: async () => {
			state.stopped = true;
			clearTimeout(state.timer);
			state.timer = undefined;
			await state.running;
		},
	};
};
