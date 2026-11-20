import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { suite, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { CONTROLLER_EXCHANGE_DEADLINE_MILLISECONDS } from '@overture-stack/usher-types';
import type pg from 'pg';

import {
	AUDIT_EVENT_TYPES,
	auditRows,
	type CloudEvent,
	dataOf,
	emittedType,
	eventsIn,
	jsonObjectOf,
	ofType,
} from '../../testing/harness/auditEvents.js';
import { startDedicatedPostgresql } from '../../testing/harness/containers.js';
import { captureLog, HARNESS_STORE_TIMEOUT_MILLISECONDS, type LogCapture } from '../../testing/harness/controller.js';
import { freshAssertion, type WireResponse } from '../../testing/harness/exchange.js';
import { anonymousExchange } from '../../testing/fixtures/applications.js';
import { withHarness } from '../../testing/harness/harness.js';
import { SCHEDULING_SLACK_MS } from '../../testing/harness/vendoredBridge.js';
import { cleanupFor, eventually } from '../../testing/harness/waiting.js';

const { tokenExchange } = AUDIT_EVENT_TYPES;

/**
 * The harness's store timeout, {@link HARNESS_STORE_TIMEOUT_MILLISECONDS}: longer than the exchange's
 * deadline, so the deadline, not the store timeout, bounds every unit of an exchange here.
 */
const HARNESS_STORE_TIMEOUT_MS = HARNESS_STORE_TIMEOUT_MILLISECONDS;

/**
 * When the paused store is resumed, from the request's start, as offsets from the deadline. With the
 * store timeout longer than the deadline, each is expected to end so:
 *
 * - 300 ms before: issued, the store taking the whole transaction with time to spare;
 * - 100 ms before and 20 ms before: storeUnavailable, the transaction reaching its COMMIT with less
 *   than the commit window left, or not reaching it by the deadline; issued or outcomeUnknown only
 *   should the request reach the Controller late enough to leave the window open;
 * - 100 ms after: storeUnavailable, the store still paused at the deadline, the one ending possible.
 */
const RESUMED_FROM_DEADLINE_MS: readonly number[] = [-300, -100, -20, 100];

/** The line naming the events of a transaction whose commit the store did not confirm. */
const COMMIT_UNCONFIRMED = 'audit.commitUnconfirmed';

const APPLICATION = 'Exchange deadline';

/** How one exchange ended, as its answer, the log and the store tell it. */
type Ending =
	| { code: unknown; kind: 'unexpected'; status: number }
	| { eventIds: readonly unknown[]; kind: 'outcomeUnknown' }
	| { kind: 'issued'; recorded: number }
	| { kind: 'storeUnavailable'; recorded: number };

/** What one exchange left behind: its answer, its token.exchange lines and rows, and its commit lines. */
interface Observed {
	answer: WireResponse;
	exchangeLines: readonly CloudEvent[];

	/** How many token.exchange rows the store gained. */
	recorded: number;

	/** The token.exchange ids each commit-unconfirmed line names. */
	unconfirmedEventIds: readonly unknown[];
}

const codeOf = (body: string): unknown => {
	const parsed: unknown = JSON.parse(body);
	return typeof parsed === 'object' && parsed !== null && 'code' in parsed ? parsed.code : undefined;
};

const tokenExchangeRows = async (client: pg.ClientBase): Promise<number> =>
	(await auditRows(client)).filter(({ type }) => type === emittedType(tokenExchange)).length;

// The ids of the token.exchange events each commit-unconfirmed line written from a mark on names.
const unconfirmedEventIds = (log: LogCapture, since: number): readonly unknown[] =>
	log
		.lines()
		.slice(since)
		.map(jsonObjectOf)
		.filter(({ message }) => message === COMMIT_UNCONFIRMED)
		.flatMap(({ events }) =>
			Array.isArray(events)
				? events.map((event: unknown) =>
						typeof event === 'object' &&
						event !== null &&
						'type' in event &&
						event.type === emittedType(tokenExchange) &&
						'id' in event
							? event.id
							: undefined,
					)
				: [undefined],
		);

// Whether the store answers a statement again, asked until it does or the store timeout passes.
const storeAnswers = (client: pg.ClientBase): Promise<boolean> =>
	eventually(
		async () =>
			client.query('SELECT 1').then(
				() => true,
				() => false,
			),
		HARNESS_STORE_TIMEOUT_MS,
		50,
	);

// How one exchange ended: one of the three endings the deadline allows, or what it was otherwise.
const endingOf = ({ answer, exchangeLines, recorded, unconfirmedEventIds: eventIds }: Observed): Ending => {
	const code = answer.status === 200 ? undefined : codeOf(answer.body);
	if (
		answer.status === 200 &&
		exchangeLines.length === 1 &&
		dataOf(exchangeLines[0] ?? {})['result'] === 'succeeded'
	) {
		return { kind: 'issued', recorded };
	}
	if (answer.status === 503 && exchangeLines.length === 0) {
		if (code === 'storeUnavailable') {
			return { kind: 'storeUnavailable', recorded };
		}
		if (code === 'outcomeUnknown') {
			return { eventIds, kind: 'outcomeUnknown' };
		}
	}
	return { code, kind: 'unexpected', status: answer.status };
};

suite("the exchange's deadline on a paused store", () => {
	test('answers every anonymous exchange by its deadline however near it the store resumes: issued with one succeeded token.exchange recorded, storeUnavailable with none, or outcomeUnknown with the line naming its event', async (context) => {
		const scope = cleanupFor(context);
		const postgresql = await startDedicatedPostgresql();
		scope.defer(() => postgresql.remove());
		const log = captureLog();

		await withHarness(
			{
				applications: [APPLICATION],
				// Longer than the pause: the exchange deadline, not the store timeout, answers each request on the paused store.
				configuration: { logStream: log.stream, storeTimeoutMilliseconds: 15_000 },
				postgresql,
			},
			async (harness) => {
				const { migration } = harness.clients;
				const application = harness.application(APPLICATION);
				assert.equal(harness.configuration.storeTimeoutMilliseconds, HARNESS_STORE_TIMEOUT_MS);

				// The first exchange confirms the key, so no run below also waits on that.
				assert.equal((await anonymousExchange(harness.url, application)).status, 200);

				const runs = await RESUMED_FROM_DEADLINE_MS.reduce<
					Promise<readonly { elapsedMs: number; ending: Ending }[]>
				>(async (previous, resumedFromDeadlineMs) => {
					const earlier = await previous;
					assert.ok(await storeAnswers(migration), 'the store never answered again');
					// An exchange with the store answering leaves the pool a connection, as the first run had,
					// so every run waits on the paused store rather than on a connection being opened.
					assert.equal((await anonymousExchange(harness.url, application)).status, 200);
					const rowsBefore = await tokenExchangeRows(migration);
					const since = log.lines().length;
					// Signed before the clock starts, so the request reaches the Controller at once.
					const assertion = await freshAssertion(application);

					await postgresql.pause();
					const from = performance.now();
					const resumed = delay(CONTROLLER_EXCHANGE_DEADLINE_MILLISECONDS + resumedFromDeadlineMs).then(() =>
						postgresql.unpause(),
					);
					const answer = await anonymousExchange(harness.url, application, {
						assertion,
					});
					const elapsedMs = performance.now() - from;
					await resumed;
					// Rows are counted once the store answers again. A transaction the exchange abandoned sent
					// no COMMIT, so none of its rows can appear later.
					await storeAnswers(migration);
					const ending = endingOf({
						answer,
						exchangeLines: ofType(eventsIn(log, since), tokenExchange),
						recorded: (await tokenExchangeRows(migration)) - rowsBefore,
						unconfirmedEventIds: unconfirmedEventIds(log, since),
					});
					return [...earlier, { elapsedMs, ending }];
				}, Promise.resolve([]));

				runs.forEach(({ elapsedMs, ending }, index) => {
					const resumedFromDeadlineMs = RESUMED_FROM_DEADLINE_MS[index] ?? 0;
					const label = `resumed ${resumedFromDeadlineMs} ms from the deadline`;
					context.diagnostic(`${label}: ${ending.kind} in ${Math.round(elapsedMs)} ms`);
					assert.ok(
						elapsedMs < CONTROLLER_EXCHANGE_DEADLINE_MILLISECONDS + SCHEDULING_SLACK_MS,
						`${label}: answered in ${Math.round(elapsedMs)} ms`,
					);
					if (resumedFromDeadlineMs > 0) {
						assert.equal(ending.kind, 'storeUnavailable', label);
					}
					switch (ending.kind) {
						case 'issued':
							assert.equal(ending.recorded, 1, `${label}: issued`);
							break;
						case 'storeUnavailable':
							assert.equal(ending.recorded, 0, `${label}: storeUnavailable`);
							break;
						case 'outcomeUnknown':
							assert.ok(
								ending.eventIds.length === 1 && typeof ending.eventIds[0] === 'string',
								`${label}: outcomeUnknown named ${JSON.stringify(ending.eventIds)}`,
							);
							break;
						case 'unexpected':
							assert.fail(`${label}: answered ${ending.status} ${String(ending.code)}`);
					}
				});
			},
			context,
		);
	});
});
