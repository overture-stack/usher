import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	AUDIT_EVENT_TYPES,
	auditRows,
	awaitEventsOfType,
	CHANNEL_ASSERTION_REJECTION_REASONS,
	dataOf,
} from '../../../testing/harness/auditEvents.js';
import { captureLog } from '../../../testing/harness/controller.js';
import { exchange, type ExchangeRequest, freshAssertion, PEOPLE } from '../../../testing/harness/exchange.js';
import {
	ARRANGER,
	assertionFor,
	carriesToken,
	issuanceFixture,
	usersWithSubject,
} from '../../../testing/fixtures/issuance.js';
import { suiteHarness, withHarness } from '../../../testing/harness/harness.js';
import { inTurn } from '../../../testing/harness/policy.js';
import { nowSeconds } from '../../../testing/harness/waiting.js';

interface AssertionCase {
	name: string;
	request: Pick<ExchangeRequest, 'assertion' | 'headers'>;
}

/** A refused assertion, and the code its `channelAssertion.rejection` records for its cause. */
interface CodedCase extends AssertionCase {
	/** Whether the assertion is read and its `iss` names the application, so the event carries its id. */
	namesApplication: boolean;

	reason: string;
}

suite('the channel assertion', () => {
	const log = captureLog();
	const shared = suiteHarness({
		configuration: { logStream: log.stream },
		fixture: issuanceFixture(),
	});
	// The recorded refusals' case reads every channelAssertion.rejection logged after it begins, so it
	// has a harness and a log of its own: a refusal another case's exchange records beside its answer,
	// after that case has ended, can then never reach it.
	const recordingLog = captureLog();
	const recording = suiteHarness({
		configuration: { logStream: recordingLog.stream },
		fixture: issuanceFixture(),
	});

	test('issues a token only to an exchange whose channel assertion carries the fields it requires', async () => {
		const harness = await shared();
		const arranger = harness.application(ARRANGER);
		const credential = await harness.tokens.signIn(PEOPLE.ana);
		const now = nowSeconds();
		const cases: readonly AssertionCase[] = [
			{ name: 'no authorization header', request: { assertion: null } },
			{
				name: 'Bearer and nothing',
				request: { assertion: null, headers: { authorization: 'Bearer' } },
			},
			{
				name: 'typ JWT',
				request: { assertion: await assertionFor(arranger, { type: 'JWT' }) },
			},
			{
				name: 'aud other than usher:controller',
				request: {
					assertion: await assertionFor(arranger, { audience: 'usher:other' }),
				},
			},
			{
				name: 'exp passed',
				request: {
					assertion: await assertionFor(arranger, {
						expiresAt: now - 45,
						issuedAt: now - 105,
					}),
				},
			},
			{
				name: 'a lifetime longer than 60 s',
				request: {
					assertion: await assertionFor(arranger, {
						expiresAt: now + 61,
						issuedAt: now,
					}),
				},
			},
		];

		const authenticated = await exchange(harness.url, {
			application: arranger,
			credential,
		});
		const answers = await Promise.all(
			cases.map(({ request }) =>
				exchange(harness.url, {
					application: arranger,
					credential,
					...request,
				}),
			),
		);

		assert.equal(authenticated.status, 200);
		cases.forEach(({ name }, index) => {
			const answer = answers[index];
			assert.equal(answer?.status, 401, name);
			assert.equal(carriesToken(answer?.body ?? ''), false, name);
		});
	});

	test('records each assertion refused once verified on channelAssertion.rejection by the code of its cause, naming its application: another audience, an expiry passed and a lifetime over 60 s', async () => {
		const harness = await recording();
		const arranger = harness.application(ARRANGER);
		const credential = await harness.tokens.signIn(PEOPLE.ana);
		const now = nowSeconds();
		const cases: readonly CodedCase[] = [
			{
				name: 'aud other than usher:controller',
				namesApplication: true,
				reason: CHANNEL_ASSERTION_REJECTION_REASONS.otherAudience,
				request: {
					assertion: await assertionFor(arranger, { audience: 'usher:other' }),
				},
			},
			{
				name: 'exp passed',
				namesApplication: true,
				reason: CHANNEL_ASSERTION_REJECTION_REASONS.expiredAssertion,
				request: {
					assertion: await assertionFor(arranger, {
						expiresAt: now - 45,
						issuedAt: now - 105,
					}),
				},
			},
			{
				name: 'a lifetime longer than 60 s',
				namesApplication: true,
				reason: CHANNEL_ASSERTION_REJECTION_REASONS.excessiveLifetime,
				request: {
					assertion: await assertionFor(arranger, {
						expiresAt: now + 61,
						issuedAt: now,
					}),
				},
			},
		];

		const recorded = await inTurn(cases, async ({ name, request }) => {
			const since = recordingLog.lines().length;
			const answer = await exchange(harness.url, {
				application: arranger,
				credential,
				...request,
			});
			const events = await awaitEventsOfType(recordingLog, AUDIT_EVENT_TYPES.channelAssertionRejection, {
				since,
			});
			return {
				events: events.map((event) => ({
					applicationId: dataOf(event)['applicationId'],
					carriesApplicationId: Object.hasOwn(dataOf(event), 'applicationId'),
					reason: dataOf(event)['reason'],
				})),
				name,
				status: answer.status,
			};
		});

		assert.deepEqual(
			recorded,
			cases.map(({ name, namesApplication, reason }) => ({
				events: [
					{
						applicationId: namesApplication ? arranger.id : undefined,
						carriesApplicationId: namesApplication,
						reason,
					},
				],
				name,
				status: 401,
			})),
		);
	});

	test('counts each assertion it cannot verify on channelAssertion.rejectionTally by the code of its cause, recording no channelAssertion.rejection for it: none sent, Bearer and nothing, and another type', async (context) =>
		withHarness(
			{ fixture: issuanceFixture() },
			async (harness) => {
				const arranger = harness.application(ARRANGER);
				const credential = await harness.tokens.signIn(PEOPLE.ana);
				const requests: readonly AssertionCase['request'][] = [
					{ assertion: null },
					{ assertion: null, headers: { authorization: 'Bearer' } },
					// A `typ` other than the channel assertion's is read as unreadable, so it names nothing.
					{ assertion: await assertionFor(arranger, { type: 'JWT' }) },
				];

				const answers = await inTurn(requests, (request) =>
					exchange(harness.url, {
						application: arranger,
						credential,
						...request,
					}),
				);
				await harness.stopController();
				const rows = await auditRows(harness.clients.migration);
				const dataOfType = (type: string): readonly unknown[] =>
					rows.filter((row) => row.type === `bio.overture.${type}`).map(({ data }) => data);
				const system = {
					actorId: null,
					actorType: 'system',
					instance: harness.configuration.instanceName,
				};

				answers.forEach((answer) => {
					assert.equal(answer.status, 401);
					assert.equal(carriesToken(answer.body), false);
				});
				assert.deepEqual(dataOfType(AUDIT_EVENT_TYPES.channelAssertionRejectionTally), [
					{
						...system,
						count: 2,
						reason: CHANNEL_ASSERTION_REJECTION_REASONS.missingAssertion,
					},
					{
						...system,
						count: 1,
						reason: CHANNEL_ASSERTION_REJECTION_REASONS.unreadableAssertion,
					},
				]);
				assert.deepEqual(dataOfType(AUDIT_EVENT_TYPES.channelAssertionRejection), []);
			},
			context,
		));

	test('answers a refused assertion with 401 whatever the credential', async () => {
		const harness = await shared();
		const arranger = harness.application(ARRANGER);
		const now = nowSeconds();
		const expired = await assertionFor(arranger, {
			expiresAt: now - 45,
			issuedAt: now - 105,
		});
		const expiredCredential = await harness.tokens.signIn(PEOPLE.ana, {
			mint: { claims: { exp: now - 3600, iat: now - 3900 } },
		});
		const underRefused = await Promise.all(
			[await harness.tokens.signIn(PEOPLE.ana), expiredCredential, null].map((credential) =>
				exchange(harness.url, {
					application: arranger,
					assertion: expired,
					credential,
				}),
			),
		);
		const underValid = await exchange(harness.url, {
			application: arranger,
			credential: expiredCredential,
		});

		assert.deepEqual(
			underRefused.map(({ status }) => status),
			[401, 401, 401],
		);
		assert.equal(underValid.status, 403);
	});

	test('does no work for an unauthenticated caller', async () => {
		await withHarness({ applicationsThroughStore: true, fixture: issuanceFixture() }, async (harness) => {
			const arranger = harness.application(ARRANGER);
			const now = nowSeconds();
			const credential = await harness.tokens.signIn(PEOPLE.fen);
			const refusedAssertion = await assertionFor(arranger, {
				expiresAt: now - 45,
				issuedAt: now - 105,
			});
			const requestsBefore = harness.identityProvider.requests.length;

			const refused = await exchange(harness.url, {
				application: arranger,
				assertion: refusedAssertion,
				credential,
			});

			assert.equal(refused.status, 401);
			assert.equal(harness.identityProvider.requests.length, requestsBefore);
			assert.equal(await usersWithSubject(harness, PEOPLE.fen.subject), 0);

			const served = await exchange(harness.url, {
				application: arranger,
				credential,
			});

			assert.equal(served.status, 200);
			assert.ok(harness.identityProvider.requests.length > requestsBefore);
			assert.equal(await usersWithSubject(harness, PEOPLE.fen.subject), 1);
		});
	});

	test('serves every exchange that one channel assertion authenticates within its lifetime', async () => {
		const harness = await shared();
		const arranger = harness.application(ARRANGER);
		const assertion = await freshAssertion(arranger);

		const signedIn = await exchange(harness.url, {
			application: arranger,
			assertion,
			credential: await harness.tokens.signIn(PEOPLE.bo),
		});
		const anonymous = await exchange(harness.url, {
			application: arranger,
			assertion,
			credential: null,
		});

		assert.equal(signedIn.status, 200);
		assert.equal(anonymous.status, 200);
	});
});

// The developer writes these cases by hand from ticket #209's test plan, the "the channel assertion"
// suite: a channel assertion that is unsigned, signed by another application's key, signed by the
// raw application key rather than its channel-assertion subkey, signed by an algorithm other than
// HS256, carrying a key in its own header, or naming an application the controller has no key for.
// Each must leave the exchange answered 401 with no token.
suite(
	'refuses a channel assertion not signed by its own application with the standard algorithm',
	{ todo: true },
	() => {},
);
