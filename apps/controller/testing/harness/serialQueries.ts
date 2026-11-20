import pg from 'pg';

/**
 * The refusal a query gets when it is issued on a connection whose earlier query has not settled: one
 * connection was sent a second query before the first answered. pg 8 queues such a query behind the
 * earlier one, and pg 9 removes that, so the Controller must never issue one.
 */
export const OVERLAPPING_QUERY_REFUSAL = 'client.query() issued while the client is already executing a query';

/** Marks the wrapped method, so a call finds the wrapper in place whichever module instance makes it. */
const WRAPPED = Symbol.for('usher.controller.refuseOverlappingQueries');

/** The queries in flight on each client the wrapper has seen, kept by the wrapper itself. */
const inFlight = new WeakMap<object, number>();

type QueryMethod = (this: object, ...args: readonly unknown[]) => unknown;

/** A query object passed as the query itself, such as a cursor or a stream, rather than as text. */
interface Submittable {
	handleError?: unknown;
	handleReadyForQuery?: unknown;
	submit: unknown;
}

const isSubmittable = (value: unknown): value is Submittable =>
	typeof value === 'object' && value !== null && typeof (value as { submit?: unknown }).submit === 'function';

const adjust = (client: object, delta: number): void => {
	inFlight.set(client, Math.max(0, (inFlight.get(client) ?? 0) + delta));
};

const isCallback = (value: unknown): value is (...args: unknown[]) => unknown => typeof value === 'function';

/**
 * Answers a query refused for overlapping the client's earlier one, in the form its caller asked for: a
 * rejected promise, a callback called with the error, or, for a query object, the error reported to it.
 */
const refused = (client: object, query: unknown, callback: ((...args: unknown[]) => unknown) | undefined): unknown => {
	const error = new Error(OVERLAPPING_QUERY_REFUSAL);
	if (isSubmittable(query)) {
		if (callback !== undefined) {
			process.nextTick(() => callback(error));
		} else if (isCallback(query.handleError)) {
			const handleError = query.handleError;
			process.nextTick(() => handleError.call(query, error, client));
		}
		return query;
	}
	if (callback === undefined) {
		return Promise.reject(error);
	}
	process.nextTick(() => callback.call(client, error));
	return undefined;
};

/**
 * Settles a query object's own completion hooks, which pg calls when the query answers, so the client is
 * freed when a query object settles however it settles.
 */
const hookSettlement = (query: Submittable, release: () => void): void => {
	(['handleError', 'handleReadyForQuery'] as const).forEach((hook) => {
		const original = query[hook];
		if (isCallback(original)) {
			Object.defineProperty(query, hook, {
				configurable: true,
				value: function settle(this: unknown, ...args: unknown[]): unknown {
					release();
					return original.apply(this, args);
				},
				writable: true,
			});
		}
	});
};

/**
 * Wraps one query method so that a query issued while an earlier one on the same client is in flight is
 * refused. The count is taken before the original runs and freed when the query settles, whether it
 * resolves, rejects or calls back with an error. The original's `this` and return value are kept.
 */
const refusingQuery = (original: QueryMethod): QueryMethod =>
	function refusingQueryMethod(this: object, query: unknown, ...rest: readonly unknown[]): unknown {
		const callback = [rest[0], rest[1]].find(isCallback);
		if ((inFlight.get(this) ?? 0) > 0) {
			return refused(this, query, callback);
		}
		adjust(this, 1);
		let settled = false;
		const release = (): void => {
			if (!settled) {
				settled = true;
				adjust(this, -1);
			}
		};
		try {
			if (isSubmittable(query)) {
				hookSettlement(query, release);
				return original.call(this, query, ...rest);
			}
			if (callback === undefined) {
				const result = original.call(this, query, ...rest) as Promise<unknown>;
				result.then(release, release);
				return result;
			}
			const settling = (...args: unknown[]): unknown => {
				release();
				return callback.apply(this, args);
			};
			const withSettling = isCallback(rest[0]) ? [settling, ...rest.slice(1)] : [rest[0], settling];
			return original.call(this, query, ...withSettling);
		} catch (error: unknown) {
			release();
			throw error;
		}
	};

/**
 * Installs the refusal of overlapping queries on `pg.Client`, which the Controller's pools and the harness's
 * clients all are. Calling it again changes nothing, whichever module makes the call. Importing this module
 * installs nothing.
 */
export const refuseOverlappingQueries = (): void => {
	const current = pg.Client.prototype.query as unknown as QueryMethod & Record<typeof WRAPPED, unknown>;
	if (current[WRAPPED] === true) {
		return;
	}
	const wrapper = Object.assign(refusingQuery(current), { [WRAPPED]: true });
	pg.Client.prototype.query = wrapper as unknown as typeof pg.Client.prototype.query;
};
