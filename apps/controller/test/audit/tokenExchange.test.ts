import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import type { PermissionsPayload } from '@overture-stack/usher-types';

import {
	assertSucceeded,
	IDENTITY_REVOCATION_REASONS,
	mintLogoutToken,
	postBackChannelLogout,
} from '../../testing/harness/admin.js';
import {
	AUDIT_EVENT_TYPES,
	CHANNEL_ASSERTION_REJECTION_REASONS,
	EVENT_INSTANT_FORM,
	EXCHANGE_REFUSAL_REASONS,
	FAULT_REASONS,
	REFUSED_SUBJECT_MAXIMUM_LENGTH,
	REFUSED_SUBJECT_MEMBER,
	SEVERITY_ATTRIBUTE,
} from '../../testing/harness/auditEvents.js';
import {
	mintSignInToken,
	PEOPLE,
	readUsherToken,
	signInClaims,
	type WireResponse,
} from '../../testing/harness/exchange.js';
import {
	auditPolicy,
	auditRows,
	awaitEvents,
	awaitOneEvent,
	consumerGrant,
	dataOf,
	decided,
	eventsIn,
	exchangeBy,
	expiredAssertion,
	expiredClaims,
	markOf,
	ofType,
	recordedTexts,
	RESOURCES,
	RESULT_SEVERITIES,
	rowOf,
	SEARCH_PORTAL,
	sharedAuditHarness,
	startLoggedInstance,
	SUBMISSION_PORTAL,
	valuesFound,
	withAuditHarness,
} from '../../testing/fixtures/audit.js';
import { type Harness, HARNESS_LOGOUT_CLIENT } from '../../testing/harness/harness.js';
import { startIdentityProvider } from '../../testing/peripherals/identityProvider.js';
import { inTurn, type PolicyFixture } from '../../testing/harness/policy.js';
import { cleanupFor, nowSeconds } from '../../testing/harness/waiting.js';

const HOUR_MS = 3_600_000;

const DAY_MS = 86_400_000;

const payloadOf = async (
	harness: Harness,
	answer: WireResponse,
	application: string = SEARCH_PORTAL,
): Promise<PermissionsPayload> => {
	assert.equal(answer.status, 200, 'the exchange issued a token');
	const reading = await readUsherToken(answer.body, {
		application: harness.application(application),
		issuer: harness.configuration.issuer,
	});
	return reading.kind === 'payload'
		? reading.payload
		: assert.fail(`the bridge's reader refuses the token: ${reading.reason}`);
};

const rulesOf = (data: Readonly<Record<string, unknown>>): readonly string[] => {
	const rules = data['rules'];
	return Array.isArray(rules) ? rules.map(String).toSorted() : assert.fail('the event names no rules list');
};

// Ana holds two grants that reach a search-portal token and one in every state that does not: pending,
// declined, revoked, expired, and on a resource search-portal does not serve. Dana is revoked entirely.
const everyStatePolicy = (): PolicyFixture => {
	const now = Date.now();
	return auditPolicy({
		decisions: [
			decided('anaA1'),
			decided('anaB2'),
			decided('anaA1Declined', 'rejected'),
			{ ...decided('anaB2Revoked'), decidedAt: new Date(now - 2 * HOUR_MS) },
			{
				...decided('anaA1Expired'),
				decidedAt: new Date(now - 2 * DAY_MS + HOUR_MS),
			},
			decided('anaC3'),
		],
		grants: {
			anaA1: consumerGrant('ana', RESOURCES.a1),
			anaA1Declined: consumerGrant('ana', RESOURCES.a1, { role: 'curator' }),
			anaA1Expired: {
				...consumerGrant('ana', RESOURCES.a1, {
					expiresAt: new Date(now - DAY_MS),
					role: 'editor',
				}),
				grantedAt: new Date(now - 2 * DAY_MS),
			},
			anaB2: consumerGrant('ana', RESOURCES.b2),
			anaB2Pending: consumerGrant('ana', RESOURCES.b2, { role: 'editor' }),
			anaB2Revoked: {
				...consumerGrant('ana', RESOURCES.b2, { role: 'curator' }),
				grantedAt: new Date(now - 3 * HOUR_MS),
				revoked: { at: new Date(now - HOUR_MS) },
			},
			anaC3: consumerGrant('ana', RESOURCES.c3),
		},
		revocations: [
			{
				reason: IDENTITY_REVOCATION_REASONS.credentialCompromise,
				user: 'dana',
			},
		],
	});
};

suite('token.exchange', () => {
	const shared = sharedAuditHarness({ fixture: everyStatePolicy() });

	test('records one succeeded token.exchange for each exchange answered with a token', async () => {
		const { harness, log } = await shared();
		const since = markOf(log);

		const answers = [
			await exchangeBy(harness, PEOPLE.ana),
			await exchangeBy(harness, PEOPLE.ana, { application: SUBMISSION_PORTAL }),
		];
		const events = ofType(
			await awaitEvents(log, (held) => ofType(held, 'token.exchange').length >= 2, { since }),
			'token.exchange',
		);

		assert.deepEqual(
			answers.map(({ status }) => status),
			[200, 200],
		);
		assert.equal(events.length, 2);
		events.forEach((event) => {
			assert.equal(dataOf(event)['result'], 'succeeded');
			assert.equal(dataOf(event)['actorId'], PEOPLE.ana.subject);
		});
	});

	test("records the issued token's lifetime as tokenTtl, a lifetime a grant's expiry shortened included", async () => {
		await withAuditHarness(
			{
				fixture: auditPolicy({
					decisions: [decided('cyShortLived')],
					grants: {
						cyShortLived: consumerGrant('cy', RESOURCES.a1, {
							expiresAt: new Date(Date.now() + 90_000),
						}),
					},
				}),
			},
			async ({ harness, log }) => {
				const recorded = await inTurn([PEOPLE.bo, PEOPLE.cy], async (person) => {
					const since = markOf(log);
					const answer = await exchangeBy(harness, person);
					const event = await awaitOneEvent(log, 'token.exchange', { since });
					return {
						data: dataOf(event),
						payload: await payloadOf(harness, answer),
					};
				});

				const [uncapped, capped] = recorded;
				assert.ok(uncapped);
				assert.ok(capped);
				recorded.forEach(({ data, payload }) => {
					assert.equal(data['tokenTtl'], payload.exp - payload.iat);
				});
				assert.ok(capped.payload.exp - capped.payload.iat <= 90);
				assert.ok(capped.payload.exp - capped.payload.iat < uncapped.payload.exp - uncapped.payload.iat);
			},
		);
	});

	test('counts the recorded grants that reached the token as grantCount', async () => {
		const { harness, log } = await shared();
		const since = markOf(log);

		const answer = await exchangeBy(harness, PEOPLE.ana);
		const data = dataOf(await awaitOneEvent(log, 'token.exchange', { since }));
		const payload = await payloadOf(harness, answer);

		assert.ok(Object.hasOwn(payload.permissions, RESOURCES.a1));
		assert.equal(data['grantCount'], 2);
	});

	test('records a grantCount of 0 for a principal holding no recorded grant', async () => {
		const { harness, log } = await shared();
		const since = markOf(log);

		const answer = await exchangeBy(harness, PEOPLE.bo);
		const data = dataOf(await awaitOneEvent(log, 'token.exchange', { since }));

		assert.equal(answer.status, 200);
		assert.equal(Object.hasOwn(data, 'grantCount'), true);
		assert.equal(data['grantCount'], 0);
	});

	test('names the rules that conferred grants on the exchange', async () => {
		const { harness, log } = await shared();
		const anonymousMark = markOf(log);
		const anonymous = await exchangeBy(harness, null);
		const anonymousData = dataOf(await awaitOneEvent(log, 'token.exchange', { since: anonymousMark }));
		const signedInMark = markOf(log);

		const signedIn = await exchangeBy(harness, PEOPLE.bo);
		const signedInData = dataOf(await awaitOneEvent(log, 'token.exchange', { since: signedInMark }));

		assert.equal(anonymous.status, 200);
		assert.equal(signedIn.status, 200);
		assert.deepEqual(rulesOf(anonymousData), ['everyone']);
		assert.deepEqual(rulesOf(signedInData), ['everyone', 'signedIn']);
	});

	test('records an empty rules list when no rule conferred anything', async () => {
		await withAuditHarness({ configuration: { baseline: [], signedInRule: [] } }, async ({ harness, log }) => {
			const since = markOf(log);

			const answer = await exchangeBy(harness, null);
			const data = dataOf(await awaitOneEvent(log, 'token.exchange', { since }));

			assert.equal(answer.status, 200);
			assert.equal(Object.hasOwn(data, 'rules'), true);
			assert.deepEqual(data['rules'], []);
		});
	});

	// A token whose signature verified names its subject as refusedSubject; one that did not names none,
	// the member left out rather than empty or null. The actor stays anonymous throughout.
	test("records each refused exchange as denied, naming its cause by its own fixed reason and a verified token's subject as refusedSubject alone, the actor anonymous", async () => {
		const { harness, log } = await shared();
		const otherRealm = await harness.identityProvider.addRealm('usher-other');
		const sessionId = randomUUID();
		const signedOut = await harness.tokens.signIn(PEOPLE.eli, {
			application: SEARCH_PORTAL,
			mint: { claims: { sid: sessionId } },
		});
		const beforeSignOut = await exchangeBy(harness, PEOPLE.eli, {
			credential: signedOut,
		});
		assertSucceeded(
			await postBackChannelLogout(
				harness.url,
				await mintLogoutToken(harness.identityProvider, {
					audience: HARNESS_LOGOUT_CLIENT,
					sessionId,
					subject: PEOPLE.eli.subject,
				}),
			),
			'the relayed sign-out',
		);
		const now = nowSeconds();
		const causes: readonly {
			credential: string;
			reason: string;
			refusedSubject?: string;
		}[] = [
			{
				credential: await harness.tokens.signIn(PEOPLE.ana, {
					application: SEARCH_PORTAL,
					mint: expiredClaims(),
				}),
				reason: EXCHANGE_REFUSAL_REASONS.expiredToken,
				refusedSubject: PEOPLE.ana.subject,
			},
			{
				credential: await harness.tokens.signIn(PEOPLE.ana, {
					application: SEARCH_PORTAL,
					mint: { claims: { exp: undefined } },
				}),
				reason: EXCHANGE_REFUSAL_REASONS.missingExpiry,
				refusedSubject: PEOPLE.ana.subject,
			},
			{
				credential: await harness.tokens.signIn(PEOPLE.ana, {
					application: SEARCH_PORTAL,
					mint: { claims: { iat: now, nbf: now + 600 } },
				}),
				reason: EXCHANGE_REFUSAL_REASONS.notYetValid,
				refusedSubject: PEOPLE.ana.subject,
			},
			{
				credential: await otherRealm.mint({
					claims: signInClaims(PEOPLE.ana, harness.application(SEARCH_PORTAL).id),
				}),
				reason: EXCHANGE_REFUSAL_REASONS.otherIssuer,
			},
			{
				credential: beforeSignOut.body.trim(),
				reason: EXCHANGE_REFUSAL_REASONS.unreadableToken,
			},
			{
				credential: await mintSignInToken(
					harness.identityProvider,
					PEOPLE.ana,
					harness.application(SEARCH_PORTAL).id,
					{ claims: { aud: [randomUUID()] } },
				),
				reason: EXCHANGE_REFUSAL_REASONS.otherAudience,
				refusedSubject: PEOPLE.ana.subject,
			},
			{
				credential: await harness.tokens.signIn(PEOPLE.dana, {
					application: SEARCH_PORTAL,
				}),
				reason: EXCHANGE_REFUSAL_REASONS.revokedPrincipal,
				refusedSubject: PEOPLE.dana.subject,
			},
			{
				credential: signedOut,
				reason: EXCHANGE_REFUSAL_REASONS.signedOutSession,
				refusedSubject: PEOPLE.eli.subject,
			},
		];
		const controlMark = markOf(log);
		const control = await exchangeBy(harness, PEOPLE.ana);
		await awaitOneEvent(log, 'token.exchange', { since: controlMark });

		const refusals = await inTurn(causes, async (cause) => {
			const since = markOf(log);
			const answer = await exchangeBy(harness, null, {
				credential: cause.credential,
			});
			const event = await awaitOneEvent(log, 'token.exchange', { since });
			return { ...cause, answer, data: dataOf(event) };
		});

		assert.equal(beforeSignOut.status, 200);
		assert.equal(control.status, 200);
		refusals.forEach(({ answer, data, reason, refusedSubject }) => {
			assert.equal(answer.status, 403, reason);
			assert.equal(data['result'], 'denied', reason);
			assert.equal(data['reason'], reason);
			assert.equal(data['actorType'], 'anonymous', reason);
			assert.equal(data['actorId'], null, reason);
			assert.equal(Object.hasOwn(data, REFUSED_SUBJECT_MEMBER), refusedSubject !== undefined, reason);
			assert.equal(data[REFUSED_SUBJECT_MEMBER], refusedSubject, reason);
		});
	});

	test("names a verified token's subject of 255 characters whole as refusedSubject, and leaves the member out for one of 256, never truncated", async () => {
		const { harness, log } = await shared();
		const audience = harness.application(SEARCH_PORTAL).id;
		const atTheLimit = 'a'.repeat(REFUSED_SUBJECT_MAXIMUM_LENGTH);
		const pastTheLimit = 'b'.repeat(REFUSED_SUBJECT_MAXIMUM_LENGTH + 1);
		const since = markOf(log);

		const refusals = await inTurn([atTheLimit, pastTheLimit], async (subject) => {
			const mark = markOf(log);
			const answer = await exchangeBy(harness, null, {
				credential: await mintSignInToken(
					harness.identityProvider,
					{ email: 'long.subject@example.org', subject },
					audience,
					expiredClaims(),
				),
			});
			const event = await awaitOneEvent(log, 'token.exchange', {
				since: mark,
			});
			return { answer, data: dataOf(event) };
		});
		const texts = recordedTexts(log.lines().slice(since), await auditRows(harness.clients.migration));

		assert.deepEqual(
			refusals.map(({ answer, data }) => ({
				actorId: data['actorId'],
				carried: Object.hasOwn(data, REFUSED_SUBJECT_MEMBER),
				reason: data['reason'],
				refusedSubject: data[REFUSED_SUBJECT_MEMBER],
				status: answer.status,
			})),
			[
				{
					actorId: null,
					carried: true,
					reason: EXCHANGE_REFUSAL_REASONS.expiredToken,
					refusedSubject: atTheLimit,
					status: 403,
				},
				{
					actorId: null,
					carried: false,
					reason: EXCHANGE_REFUSAL_REASONS.expiredToken,
					refusedSubject: undefined,
					status: 403,
				},
			],
		);
		assert.deepEqual(valuesFound([pastTheLimit.slice(0, REFUSED_SUBJECT_MAXIMUM_LENGTH)], texts), []);
	});

	test('refuses an opaque credential as an identity with no API key verifier configured, recording that reason and no refused subject', async () => {
		const { harness, log } = await shared();
		const opaque = `opaque-${'b41e'.repeat(8)}`;
		const controlMark = markOf(log);
		const control = await exchangeBy(harness, PEOPLE.bo);
		const controlEvent = await awaitOneEvent(log, 'token.exchange', {
			since: controlMark,
		});
		const since = markOf(log);

		const refused = await exchangeBy(harness, null, { credential: opaque });
		const data = dataOf(await awaitOneEvent(log, 'token.exchange', { since }));
		const texts = recordedTexts(log.lines(), await auditRows(harness.clients.migration));

		assert.equal(control.status, 200);
		assert.equal(dataOf(controlEvent)['result'], 'succeeded');
		assert.equal(refused.status, 403);
		assert.equal(data['result'], 'denied');
		assert.equal(data['reason'], EXCHANGE_REFUSAL_REASONS.apiKeyVerifierNotConfigured);
		assert.equal(Object.hasOwn(data, REFUSED_SUBJECT_MEMBER), false);
		assert.deepEqual(valuesFound([opaque], texts), []);
	});

	test('records an exchange it could not complete, with the identity provider unreachable and no keys held, as failed', async (context) => {
		const provider = await startIdentityProvider();
		cleanupFor(context).defer(() => provider.stop());
		await provider.refuseConnections();

		await withAuditHarness(
			{ applicationsThroughStore: true, identityProvider: provider },
			async ({ harness, log }) => {
				const since = markOf(log);

				const answer = await exchangeBy(harness, PEOPLE.ana);
				const data = dataOf(await awaitOneEvent(log, 'token.exchange', { since }));

				assert.equal(answer.status, 503);
				assert.equal(data['result'], 'failed');
				assert.equal(data['reason'], FAULT_REASONS.identityProviderUnavailable);
			},
		);
	});

	test('records a reissue from the cached payload as it records a computed exchange', async () => {
		const { harness, log } = await shared();
		const credential = await harness.tokens.signIn(PEOPLE.cy, {
			application: SEARCH_PORTAL,
		});

		const recorded = await inTurn(['computed', 'reissued'], async () => {
			const since = markOf(log);
			const answer = await exchangeBy(harness, PEOPLE.cy, { credential });
			const event = await awaitOneEvent(log, 'token.exchange', { since });
			return { answer, data: dataOf(event) };
		});

		const [computed, reissued] = recorded;
		assert.ok(computed);
		assert.ok(reissued);
		assert.equal(computed.answer.status, 200);
		assert.equal(reissued.answer.status, 200);
		recorded.forEach(({ data }) => {
			['generatedAt', 'grantCount', 'rules'].forEach((member) => {
				assert.equal(Object.hasOwn(data, member), true, member);
			});
		});
		assert.deepEqual(Object.keys(reissued.data).toSorted(), Object.keys(computed.data).toSorted());
		assert.equal(reissued.data['grantCount'], computed.data['grantCount']);
		assert.deepEqual(reissued.data['rules'], computed.data['rules']);
		assert.equal(
			Date.parse(String(reissued.data['generatedAt'])),
			Date.parse(String(computed.data['generatedAt'])),
		);
	});

	test('records each exchange at the severity its result gives', async (context) => {
		const scope = cleanupFor(context);
		const { harness, log } = await shared();
		const unreachable = await startIdentityProvider({ realm: 'usher-down' });
		scope.defer(() => unreachable.stop());
		await unreachable.refuseConnections();
		const failing = await startLoggedInstance(scope, harness, {
			identityProviderIssuer: unreachable.issuer,
		});

		const credentials = [
			await harness.tokens.signIn(PEOPLE.bo, { application: SEARCH_PORTAL }),
			await harness.tokens.signIn(PEOPLE.bo, {
				application: SEARCH_PORTAL,
				mint: expiredClaims(),
			}),
		];

		const recorded = await inTurn(credentials, async (credential) => {
			const since = markOf(log);
			await exchangeBy(harness, PEOPLE.bo, { credential });
			return awaitOneEvent(log, 'token.exchange', { since });
		});
		const failed = await exchangeBy(harness, PEOPLE.bo, {
			credential: await mintSignInToken(unreachable, PEOPLE.bo, harness.application(SEARCH_PORTAL).id),
			url: failing.instance.url,
		});
		const failure = await awaitOneEvent(failing.log, 'token.exchange');
		const events = [...recorded, failure];

		assert.equal(failed.status, 503);
		assert.equal(dataOf(failure)['reason'], FAULT_REASONS.identityProviderUnavailable);
		assert.deepEqual(
			events.map((event) => dataOf(event)['result']),
			['succeeded', 'denied', 'failed'],
		);
		events.forEach((event) => {
			assert.equal(event[SEVERITY_ATTRIBUTE], RESULT_SEVERITIES[String(dataOf(event)['result'])]);
		});
	});

	test('records an exchange refused for its channel assertion as channelAssertion.rejection, its actor the system', async () => {
		const { harness, log } = await shared();
		const assertion = await expiredAssertion(harness.application(SEARCH_PORTAL));
		const controlMark = markOf(log);
		const control = await exchangeBy(harness, PEOPLE.bo);
		await awaitOneEvent(log, 'token.exchange', { since: controlMark });
		const since = markOf(log);

		const refused = await exchangeBy(harness, PEOPLE.bo, {
			assertion,
		});
		const event = await awaitOneEvent(log, AUDIT_EVENT_TYPES.channelAssertionRejection, {
			since,
		});
		const data = dataOf(event);
		const row = rowOf(await auditRows(harness.clients.migration), event);

		assert.equal(control.status, 200);
		assert.equal(refused.status, 401);
		assert.deepEqual(ofType(eventsIn(log, since), 'token.exchange'), []);
		assert.equal(data['result'], 'denied');
		assert.equal(data['actorType'], 'system');
		assert.equal(data['actorId'], null);
		assert.equal(data['sourceIp'], '127.0.0.1');
		assert.equal(data['reason'], CHANNEL_ASSERTION_REJECTION_REASONS.expiredAssertion);
		assert.equal(data['applicationId'], harness.application(SEARCH_PORTAL).id);
		assert.deepEqual(
			valuesFound([PEOPLE.bo.subject, PEOPLE.bo.email], recordedTexts(log.lines().slice(since), [row])),
			[],
		);
	});

	test('names the audience and the computation time on a succeeded exchange', async () => {
		const { harness, log } = await shared();
		const since = markOf(log);

		const answer = await exchangeBy(harness, PEOPLE.ana, {
			application: SUBMISSION_PORTAL,
		});
		const data = dataOf(await awaitOneEvent(log, 'token.exchange', { since }));
		const payload = await payloadOf(harness, answer, SUBMISSION_PORTAL);

		assert.equal(data['audience'], harness.application(SUBMISSION_PORTAL).id);
		assert.match(String(data['generatedAt']), EVENT_INSTANT_FORM);
		assert.equal(Date.parse(String(data['generatedAt'])), payload.generatedAt * 1000);
	});
});

suite(
	"records an exchange whose sign-in token is signed by an unknown key as denied, naming its own fixed reason: the developer writes these cases by hand from ticket #214's test plan, suite 'token.exchange'",
	{ todo: true },
	() => {},
);

suite(
	"records an exchange whose sign-in token can't be read as denied, naming unreadableToken: the developer writes these cases by hand from ticket #214's test plan, suite 'token.exchange'",
	{ todo: true },
	() => {},
);

// A token forged to name a real person's subject, its signature unverified under the trusted issuer,
// must record no subject: the refused `token.exchange` and any management refusal leave
// `refusedSubject` out, so a forged token cannot put anyone's subject in the trail. Forging one is the
// developer's to do by hand.
suite(
	"records no refused subject for a token forged to name a real person's subject, at the exchange and at a Management API operation: the developer writes these cases by hand from the refused-subject ruling",
	{ todo: true },
	() => {},
);
