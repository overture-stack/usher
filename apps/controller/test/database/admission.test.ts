import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { suite, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { CONTROLLER_EXCHANGE_DEADLINE_MILLISECONDS } from '@overture-stack/usher-types';
import pg from 'pg';

import {
	administratorCaller,
	assertSucceeded,
	postBackChannelLogout,
	revokeApplicationKey,
} from '../../test-support/admin.js';
import { AUDIT_EVENT_TYPES, type AuditRow, auditRows, emittedType } from '../../test-support/auditEvents.js';
import { NOTICE_VERSIONS_HEADER } from '../../test-support/bridgeWire.js';
import { blockedBackends, untilBlocked, whileHolding } from '../../test-support/database.js';
import {
	exchange,
	freshAssertion,
	mintSignInToken,
	PEOPLE,
	type Person,
	type WireResponse,
} from '../../test-support/exchange.js';
import {
	anonymousExchange,
	APPLICATION_SUITE,
	applicationRowCounts,
	heldBy,
	issued,
	registered,
} from '../../test-support/fixtures/applications.js';
import { logoutTokenFor } from '../../test-support/fixtures/channel.js';
import type { ControllerApplication } from '../../test-support/controller.js';
import { type Harness, withHarness } from '../../test-support/harness.js';
import { FAULT_SCHEMA, POLICY_TABLES, qualified } from '../../test-support/policy.js';
import { SCHEDULING_SLACK_MS } from '../../test-support/vendoredBridge.js';
import { type Cleanup, cleanupFor, nowSeconds } from '../../test-support/waiting.js';

/**
 * The exchange pool these tests give the Controller: two connections, so a few exchanges fill it. A
 * constant of its own here, as the test reaches the Controller through the seam.
 */
const EXCHANGE_CONNECTIONS = 2;

/** The control pool's connections at the Controller's default. */
const CONTROL_CONNECTIONS = 5;

/**
 * The most rejection recordings the stream route holds waiting on the store, by the Controller's
 * rule: half the control pool's connections, rounded down, and at least one.
 */
const STREAM_PENDING_LIMIT = Math.max(1, Math.floor(CONTROL_CONNECTIONS / 2));

/** How long an exchange admitted and waiting for a connection is watched, still unanswered. */
const WAITING_MS = 300;

/**
 * How long the borrower holds the whole pool before the other application's exchange is sent: long
 * enough that the borrower's exchanges reach their own deadline with the other's well within its.
 */
const BORROWER_LEAD_MS = 1000;

/** A notice version no Controller serves, so a stream presented it is refused before it opens. */
const UNSERVED_NOTICE_VERSION = '99';

// A test-reserved pair of advisory lock keys, apart from every key the support code takes.
const HOLD_LOCK = Object.freeze({ classid: 217, objid: 7 });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const dataOfRow = ({ data }: AuditRow): Readonly<Record<string, unknown>> => (isRecord(data) ? data : {});

const codeOf = ({ body }: WireResponse): unknown => {
	const problem: unknown = JSON.parse(body);
	return isRecord(problem) ? problem['code'] : undefined;
};

// An answer's problem code, or its status for a token issued.
const codeOrStatusOf = (answer: WireResponse): unknown => (answer.status === 200 ? 200 : codeOf(answer));

// The rows of one type the trail holds beyond those it held before.
const rowsAdded = async (
	client: pg.ClientBase,
	before: readonly AuditRow[],
	type: string,
): Promise<readonly AuditRow[]> => {
	const held = new Set(before.map(({ id }) => id));
	return (await auditRows(client)).filter((row) => row.type === emittedType(type) && !held.has(row.id));
};

// Whether an answer came within the milliseconds given.
const answeredWithin = (answering: Promise<unknown>, milliseconds: number): Promise<boolean> =>
	Promise.race([answering.then(() => true), delay(milliseconds).then(() => false)]);

/** A hold on the audit rows a condition matches, installed for one test. */
interface AuditHold {
	/** Lets every held insert go on. */
	release(): Promise<void>;
}

/**
 * Holds every insert into `audit_log` whose row the condition matches, under the migration role: a
 * test-only trigger has the inserting transaction wait on an advisory lock the client given holds,
 * so the transaction keeps its connection until the hold is released. The trigger and its function,
 * in {@link FAULT_SCHEMA}, go once the cleanup runs, the hold released first.
 *
 * @param scope the cleanup removing it.
 * @param client a connection under the migration role, which holds the lock.
 * @param condition a boolean SQL expression over the row being inserted, `NEW`, its values written
 *   as escaped literals.
 */
const holdAuditRows = async (scope: Cleanup, client: pg.ClientBase, condition: string): Promise<AuditHold> => {
	const name = `hold_${randomBytes(6).toString('hex')}`;
	const holding = `${pg.escapeIdentifier(FAULT_SCHEMA)}.${pg.escapeIdentifier(name)}`;
	const auditLog = qualified(POLICY_TABLES.auditLog);
	await client.query(`CREATE SCHEMA IF NOT EXISTS ${pg.escapeIdentifier(FAULT_SCHEMA)}`);
	await client.query(
		`CREATE FUNCTION ${holding}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $hold$ BEGIN IF ${condition} THEN PERFORM pg_advisory_xact_lock(${HOLD_LOCK.classid}, ${HOLD_LOCK.objid}); END IF; RETURN NEW; END $hold$`,
	);
	await client.query(
		`CREATE TRIGGER ${pg.escapeIdentifier(name)} BEFORE INSERT ON ${auditLog} FOR EACH ROW EXECUTE FUNCTION ${holding}()`,
	);
	await client.query('SELECT pg_advisory_lock($1, $2)', [HOLD_LOCK.classid, HOLD_LOCK.objid]);
	const state = { held: true, removed: false };
	const release = async (): Promise<void> => {
		if (state.held) {
			state.held = false;
			await client.query('SELECT pg_advisory_unlock($1, $2)', [HOLD_LOCK.classid, HOLD_LOCK.objid]);
		}
	};
	scope.defer(async () => {
		await release();
		if (!state.removed) {
			state.removed = true;
			await client.query(`DROP TRIGGER ${pg.escapeIdentifier(name)} ON ${auditLog}`);
			await client.query(`DROP FUNCTION ${holding}()`);
		}
	});
	return { release };
};

// The condition matching an issued exchange's `token.exchange` for one audience.
const issuedFor = (audience: string): string =>
	`NEW.${pg.escapeIdentifier(POLICY_TABLES.auditLog.columns.data)} ->> 'audience' = ${pg.escapeLiteral(audience)}`;

// The condition matching every row of one event type.
const ofType = (type: string): string =>
	`NEW.${pg.escapeIdentifier(POLICY_TABLES.auditLog.columns.type)} = ${pg.escapeLiteral(emittedType(type))}`;

// Presents a channel assertion to the notice stream listing only an unserved notice version, so the
// stream never opens: the first presentation records the assertion as used and is answered 406, and
// any later one is refused 401 as reusedAssertion.
const presentToStream = async (url: URL, assertion: string): Promise<number> => {
	const response = await fetch(new URL('notices/stream', url), {
		headers: {
			accept: 'text/event-stream',
			authorization: `Bearer ${assertion}`,
			[NOTICE_VERSIONS_HEADER]: UNSERVED_NOTICE_VERSION,
		},
		method: 'GET',
		redirect: 'manual',
	});
	await response.body?.cancel();
	return response.status;
};

// Registers two applications through the API and confirms each one's key with an anonymous exchange,
// so no exchange after it writes a confirmation.
const twoApplications = async (
	harness: Pick<Harness, 'tokens' | 'url'>,
): Promise<{
	portal: ControllerApplication;
	search: ControllerApplication;
	warmed: readonly WireResponse[];
}> => {
	const administrator = await administratorCaller(harness);
	const search = heldBy(
		await registered(administrator, {
			displayName: 'Flooded through its bridge',
		}),
	);
	const portal = heldBy(
		await registered(administrator, {
			displayName: 'Served beside the flood',
		}),
	);
	const warmed = await Promise.all([anonymousExchange(harness.url, search), anonymousExchange(harness.url, portal)]);
	return { portal, search, warmed };
};

suite("each application's admission share, against the store", () => {
	test("answers an application's exchanges over its share 503 at once while the exchange pool is contended, nothing written for them, while one of its anonymous exchanges past the share and another application's exchange within its share are served", async (context) => {
		await withHarness(
			{
				...APPLICATION_SUITE,
				configuration: { databaseExchangeConnections: EXCHANGE_CONNECTIONS },
			},
			async (harness) => {
				const { migration } = harness.clients;
				const { portal, search, warmed } = await twoApplications(harness);
				const { applications } = await applicationRowCounts(migration);
				const share = Math.max(1, Math.floor(EXCHANGE_CONNECTIONS / applications));
				const before = await auditRows(migration);
				const now = nowSeconds();
				// An expired token of each person's own, so each refusal opens a window of its own and its
				// record takes a place in the share, where a later refusal under one window's key would be
				// answered at once, taking none.
				const refused = async (person: Person): Promise<WireResponse> =>
					exchange(harness.url, {
						application: search,
						credential: await mintSignInToken(harness.identityProvider, person, search.id, {
							claims: { exp: now - 60, iat: now - 360 },
						}),
					});
				const fillingPeople = [PEOPLE.ana, PEOPLE.bo];

				// Every exchange admitted waits on the held trail while holding its place, and every exchange
				// refused is answered while the trail is still held.
				const during = await whileHolding(harness.database, POLICY_TABLES.auditLog, async () => {
					// The search application's share, then every other connection lent past it.
					const filling = fillingPeople.map(refused);
					const filled = await untilBlocked(migration, Promise.all(filling), {
						count: EXCHANGE_CONNECTIONS,
					});
					const overShare = await refused(PEOPLE.cy);
					// Two anonymous exchanges at once: one takes the lane and waits for a connection, and the
					// other is refused at once, so the first answer is the refusal.
					const anonymous = [anonymousExchange(harness.url, search), anonymousExchange(harness.url, search)];
					const firstAnonymous = await Promise.race(anonymous);
					const beside = anonymousExchange(harness.url, portal);
					const besideWaiting = !(await answeredWithin(beside, WAITING_MS));
					return {
						anonymous,
						beside,
						besideWaiting,
						filled,
						filling,
						firstAnonymous,
						overShare,
					};
				});
				const [filledAnswers, anonymousAnswers, besideAnswer] = await Promise.all([
					Promise.all(during.filling),
					Promise.all(during.anonymous),
					during.beside,
				]);
				const exchangesRecorded = await rowsAdded(migration, before, AUDIT_EVENT_TYPES.tokenExchange);
				await harness.stopController();
				const tallies = await rowsAdded(migration, before, AUDIT_EVENT_TYPES.admissionShareExceededTally);

				assert.deepEqual(
					warmed.map(({ status }) => status),
					[200, 200],
				);
				assert.deepEqual(
					[applications, share, fillingPeople.length],
					[2, 1, EXCHANGE_CONNECTIONS],
					'two applications registered, a share of one each, a refusal for each connection',
				);
				assert.equal(during.filled, true, 'the pool held, each place taken');
				assert.deepEqual(
					[during.overShare, during.firstAnonymous].map((answer) => ({
						code: codeOf(answer),
						retryAfter: answer.headers.get('retry-after'),
						status: answer.status,
					})),
					[
						{ code: 'admissionShareExceeded', retryAfter: '1', status: 503 },
						{ code: 'admissionShareExceeded', retryAfter: '1', status: 503 },
					],
				);
				assert.deepEqual(anonymousAnswers.map(codeOrStatusOf).toSorted(), [200, 'admissionShareExceeded']);
				assert.equal(during.besideWaiting, true, 'the other application admitted, waiting for a connection');
				assert.equal(besideAnswer.status, 200);
				assert.deepEqual(
					filledAnswers.map(codeOf),
					filledAnswers.map(() => 'credentialRefused'),
				);
				assert.deepEqual(
					exchangesRecorded
						.map(dataOfRow)
						.map(({ audience, reason, result }) => ({
							audience,
							reason,
							result,
						}))
						.toSorted((first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second))),
					[
						...filledAnswers.map(() => ({
							audience: undefined,
							reason: 'expiredToken',
							result: 'denied',
						})),
						...[search.id, portal.id].map((audience) => ({
							audience,
							reason: undefined,
							result: 'succeeded',
						})),
					].toSorted((first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second))),
				);
				assert.deepEqual(
					tallies.map(dataOfRow).map(({ applicationId, count }) => ({
						applicationId,
						count,
					})),
					[{ applicationId: search.id, count: 2 }],
				);
			},
			context,
		);
	});

	test("with one application borrowing the whole exchange pool, another application's exchange within its share is answered within the deadline", async (context) => {
		await withHarness(
			{
				...APPLICATION_SUITE,
				configuration: { databaseExchangeConnections: EXCHANGE_CONNECTIONS },
			},
			async (harness) => {
				const { migration } = harness.clients;
				const { portal, search } = await twoApplications(harness);
				// The search application's exchanges are held at the store until the end of the test, so their
				// connections are freed only by their own deadline; the portal's are written as soon as they
				// reach the store.
				const hold = await holdAuditRows(cleanupFor(context), migration, issuedFor(search.id));

				// Its share, then the other connection lent past it.
				const borrowing = Array.from({ length: EXCHANGE_CONNECTIONS }, () =>
					anonymousExchange(harness.url, search),
				);
				const borrowed = await untilBlocked(migration, Promise.all(borrowing), {
					count: EXCHANGE_CONNECTIONS,
				});
				await delay(BORROWER_LEAD_MS);
				const sentAt = performance.now();
				const beside = anonymousExchange(harness.url, portal);
				const besideWaiting = !(await answeredWithin(beside, WAITING_MS));
				const besideAnswer = await beside;
				const elapsedMs = performance.now() - sentAt;
				await hold.release();
				const borrowerAnswers = await Promise.all(borrowing);

				assert.equal(borrowed, true, 'the whole pool borrowed');
				assert.equal(besideWaiting, true, 'admitted within its share, waiting for a connection');
				assert.ok(
					elapsedMs < CONTROLLER_EXCHANGE_DEADLINE_MILLISECONDS + SCHEDULING_SLACK_MS,
					`answered in ${Math.round(elapsedMs)} ms`,
				);
				assert.equal(codeOrStatusOf(besideAnswer), 200);
				assert.deepEqual(
					borrowerAnswers.map(codeOrStatusOf),
					borrowerAnswers.map(() => 'storeUnavailable'),
				);
			},
			context,
		);
	});
});

suite("the controller's store pools, against the store", () => {
	test('with the exchange pool fully held, a Management API revocation and a back-channel logout both complete', async (context) => {
		await withHarness(
			{
				applications: ['Held exchanges'],
				configuration: { databaseExchangeConnections: EXCHANGE_CONNECTIONS },
			},
			async (harness) => {
				const { migration } = harness.clients;
				const application = harness.application('Held exchanges');
				const administrator = await administratorCaller(harness);
				const second = await issued(administrator, application.id);
				const warmed = await anonymousExchange(harness.url, application);
				const hold = await holdAuditRows(cleanupFor(context), migration, issuedFor(application.id));

				const holding = Array.from({ length: EXCHANGE_CONNECTIONS }, () =>
					anonymousExchange(harness.url, application),
				);
				const fullyHeld = await untilBlocked(migration, Promise.all(holding), {
					count: EXCHANGE_CONNECTIONS,
				});
				const [revocation, logout] = await Promise.all([
					revokeApplicationKey(administrator, application.id, second.id),
					logoutTokenFor(harness, PEOPLE.ana).then((logoutToken) =>
						postBackChannelLogout(harness.url, logoutToken),
					),
				]);
				const stillHeld = (await blockedBackends(migration)).length;
				await hold.release();
				const held = await Promise.all(holding);

				assert.equal(warmed.status, 200);
				assert.equal(fullyHeld, true, 'every exchange connection held');
				assertSucceeded(revocation, 'revoking the second key');
				assert.equal(logout.status, 200);
				assert.ok(stillHeld >= EXCHANGE_CONNECTIONS, `${stillHeld} exchanges still held once both completed`);
				assert.deepEqual(
					held.map(({ status }) => status),
					held.map(() => 200),
				);
			},
			context,
		);
	});

	test("with the stream route's recording cap full and the store slowed, a Management API revocation completes", async (context) => {
		await withHarness(
			{ applications: ['Refused on the stream'] },
			async (harness) => {
				const { migration } = harness.clients;
				const application = harness.application('Refused on the stream');
				const administrator = await administratorCaller(harness);
				const second = await issued(administrator, application.id);
				const before = await auditRows(migration);
				// More refusals than the control pool holds connections, so recordings past the cap would take
				// every one of them.
				const presented = CONTROL_CONNECTIONS + STREAM_PENDING_LIMIT;
				const assertions = await Promise.all(
					Array.from({ length: presented }, () => freshAssertion(application)),
				);
				// Each recording of a refused assertion waits at the store until released.
				const hold = await holdAuditRows(
					cleanupFor(context),
					migration,
					ofType(AUDIT_EVENT_TYPES.channelAssertionRejection),
				);

				const firstPresentations = await Promise.all(
					assertions.map((assertion) => presentToStream(harness.url, assertion)),
				);
				const reuses = await Promise.all(
					assertions.map((assertion) => presentToStream(harness.url, assertion)),
				);
				// The recordings run beside the answers, so the wait is bounded by time alone.
				const capFull = await untilBlocked(migration, delay(5000), {
					count: STREAM_PENDING_LIMIT,
				});
				const revocation = await revokeApplicationKey(administrator, application.id, second.id);
				const stillHeld = (await blockedBackends(migration)).length;
				await hold.release();
				// The stop waits for every recording still waiting on the store, then records the tally.
				await harness.stopController();
				const recorded = (await rowsAdded(migration, before, AUDIT_EVENT_TYPES.channelAssertionRejection)).map(
					dataOfRow,
				);
				const tallied = (await rowsAdded(migration, before, AUDIT_EVENT_TYPES.channelAssertionRejectionTally))
					.map(dataOfRow)
					.filter(({ reason }) => reason === 'reusedAssertion')
					.reduce((sum, { count }) => sum + (typeof count === 'number' ? count : 0), 0);

				assert.deepEqual(
					firstPresentations,
					assertions.map(() => 406),
				);
				assert.deepEqual(
					reuses,
					assertions.map(() => 401),
				);
				assert.equal(capFull, true, 'the stream route at its cap');
				assertSucceeded(revocation, 'revoking the second key');
				assert.equal(
					stillHeld,
					STREAM_PENDING_LIMIT,
					'the revocation completed while the recordings were still held',
				);
				assert.deepEqual(
					recorded.map(({ applicationId, reason }) => ({
						applicationId,
						reason,
					})),
					Array.from({ length: STREAM_PENDING_LIMIT }, () => ({
						applicationId: application.id,
						reason: 'reusedAssertion',
					})),
				);
				assert.equal(tallied, presented - STREAM_PENDING_LIMIT);
			},
			context,
		);
	});
});
