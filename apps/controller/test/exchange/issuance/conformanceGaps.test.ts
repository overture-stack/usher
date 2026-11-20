import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import { CONFIGURATION_DEFAULTS } from '@overture-stack/usher-bridge--express';

import { cloudEventsIn, emittedType, TOKEN_CAP_EVENT } from '../../../testing/harness/auditEvents.js';
import { adjustableClock, KEY_REFETCH_COOLDOWN_MS } from '../../../testing/peripherals/clocks.js';
import { CORPUS_ANA } from '../../../testing/fixtures/conformanceCorpus.js';
import { captureLog } from '../../../testing/harness/controller.js';
import {
	carriesToken,
	comparableWireRefusal,
	exchange,
	PEOPLE,
	type Person,
	signInClaims,
} from '../../../testing/harness/exchange.js';
import {
	ARRANGER_PROD,
	conformanceHarnessOptions,
	LYRIC_EXAMPLE,
	replayedPayload,
} from '../../../testing/fixtures/conformance.js';
import { dataOf } from '../../../testing/fixtures/audit.js';
import {
	assertionFor,
	exchangeAs,
	payloadOf,
	scaleExternalId,
	scaleFixture,
} from '../../../testing/fixtures/issuance.js';
import { withHarness } from '../../../testing/harness/harness.js';
import { startIdentityProvider } from '../../../testing/peripherals/identityProvider.js';
import { cleanupFor, eventually, nowSeconds } from '../../../testing/harness/waiting.js';

// #215's tests of the exchange as the bridge reads it, for the behaviours its coverage table
// (test/conformance/coverage.md) finds no #209 test covering (B1).

// The bridge's clock off the controller's by up to this much, within the 30 s tolerance (#215 Q9).
const CLOCK_DIFFERENCE_SECONDS = 20;

// The ruled bound (#209 Q17 with #215 Q11): in payload v1, about 1,000 held resources at 1,000 served
// fit the bridge's 1 MiB cap, and 10,000 served fit with 200 held (#209's own test). At 10,000 served,
// payload v1 cannot carry 1,000 held within the cap; a more compact payload is post-MVP.
const DESIGNED_SCALE = 1_000;

// Well past the cap: 4,000 resources served and held, about 1.4 MiB in payload v1.
const PAST_THE_CAP = 4_000;

// The exchange's event is written as the exchange is answered; this bounds the wait for its line.
const EVENT_WITHIN_MS = 5_000;

const SEEDING_TIMEOUT_MS = 300_000;

suite('the exchange, as the bridge reads it', () => {
	test('answers an exchange with the token alone as an application/jwt body marked no-store, for a sign-in token whose aud is a list or a string', async (context) => {
		await withHarness(
			conformanceHarnessOptions('A'),
			async (harness) => {
				const application = harness.application(ARRANGER_PROD);
				const credentials = [
					await harness.tokens.signIn(CORPUS_ANA),
					await harness.tokens.signIn(CORPUS_ANA, {
						mint: { claims: { aud: application.id } },
					}),
				];

				const answers = await Promise.all(
					credentials.map((credential) => exchange(harness.url, { application, credential })),
				);

				await Promise.all(
					answers.map(async (answer) => {
						assert.equal(answer.status, 200);
						assert.equal(
							answer.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase(),
							'application/jwt',
						);
						assert.match(answer.headers.get('cache-control') ?? '', /(^|,)\s*no-store\s*(,|$)/u);
						assert.ok(carriesToken(answer.body));
						assert.equal(answer.body, answer.body.trim());
						assert.equal((await payloadOf(harness, answer, ARRANGER_PROD)).sub, CORPUS_ANA.subject);
					}),
				);
			},
			context,
		);
	});

	test('names in sub exactly the subject of the sign-in token exchanged', async (context) => {
		await withHarness(
			conformanceHarnessOptions('A'),
			async (harness) => {
				const people: readonly Person[] = [CORPUS_ANA, PEOPLE.cy, PEOPLE.cy2, PEOPLE.emile];

				const named = await Promise.all(
					people.map(async (person) => (await replayedPayload(harness, { person })).sub),
				);

				assert.deepEqual(
					named,
					people.map(({ subject }) => subject),
				);
				assert.notEqual(named[1], named[2]);
			},
			context,
		);
	});

	test('answers every credential it refuses with the same 403 and the same body, with no API key verifier configured', async (context) => {
		await withHarness(
			conformanceHarnessOptions('A'),
			async (harness) => {
				const application = harness.application(ARRANGER_PROD);
				const now = nowSeconds();
				const otherRealm = await harness.identityProvider.addRealm('conformance-elsewhere');
				const refused = [
					{
						credential: await harness.tokens.signIn(CORPUS_ANA, {
							mint: { claims: { exp: now - 3600, iat: now - 3900 } },
						}),
						name: 'past its exp',
					},
					{
						credential: await otherRealm.mint({
							claims: signInClaims(CORPUS_ANA, application.id),
						}),
						name: "another issuer's own token",
					},
					{
						credential: await harness.tokens.signIn(CORPUS_ANA, {
							application: LYRIC_EXAMPLE,
						}),
						name: 'aud naming another application',
					},
					{
						credential: await harness.tokens.signIn(CORPUS_ANA, {
							mint: { claims: { aud: [randomUUID()] } },
						}),
						name: 'aud naming no application',
					},
					{ credential: '', name: 'an empty credential' },
					{ credential: 'uak_example', name: 'an opaque credential' },
				];

				const answers = await Promise.all(
					refused.map(async ({ credential, name }) => ({
						answer: await exchange(harness.url, { application, credential }),
						name,
					})),
				);
				const accepted = await exchange(harness.url, {
					application,
					credential: await harness.tokens.signIn(CORPUS_ANA),
				});

				assert.equal(accepted.status, 200);
				const [first] = answers;
				answers.forEach(({ answer, name }) => {
					assert.equal(answer.status, 403, name);
					assert.equal(carriesToken(answer.body), false, name);
					assert.deepEqual(
						comparableWireRefusal(answer),
						first === undefined ? undefined : comparableWireRefusal(first.answer),
						`${name} is answered as ${first?.name ?? ''} is`,
					);
				});
			},
			context,
		);
	});

	test('answers 403 to an empty credential and to an opaque one it holds no record of', async (context) => {
		await withHarness(
			conformanceHarnessOptions('A'),
			async (harness) => {
				const application = harness.application(ARRANGER_PROD);

				const answers = await Promise.all(
					['', 'uak_example'].map((credential) => exchange(harness.url, { application, credential })),
				);
				const accepted = await exchange(harness.url, {
					application,
					credential: await harness.tokens.signIn(CORPUS_ANA),
				});

				answers.forEach((answer) => {
					assert.equal(answer.status, 403);
					assert.equal(carriesToken(answer.body), false);
				});
				assert.equal(accepted.status, 200);
			},
			context,
		);
	});

	test('accepts an assertion from a bridge whose clock differs from its own within its tolerance', async (context) => {
		await withHarness(
			conformanceHarnessOptions('A'),
			async (harness) => {
				const application = harness.application(ARRANGER_PROD);
				const offsets = [CLOCK_DIFFERENCE_SECONDS, -CLOCK_DIFFERENCE_SECONDS];

				const answers = await Promise.all(
					offsets.map(async (offset) =>
						exchange(harness.url, {
							application,
							assertion: await assertionFor(application, {
								issuedAt: nowSeconds() + offset,
							}),
							credential: await harness.tokens.signIn(CORPUS_ANA),
						}),
					),
				);

				answers.forEach((answer, index) => {
					assert.equal(answer.status, 200, `a bridge clock ${offsets[index] ?? 0} s off`);
					assert.ok(carriesToken(answer.body));
				});
			},
			context,
		);
	});

	test('answers 503 to an exchange it cannot validate while the identity provider is unreachable', async (context) => {
		const provider = await startIdentityProvider();
		cleanupFor(context).defer(() => provider.stop());
		await provider.refuseConnections();
		const time = adjustableClock();
		await withHarness(
			{
				...conformanceHarnessOptions('A', {
					configuration: { clock: time.clock },
				}),
				applicationsThroughStore: true,
				identityProvider: provider,
			},
			async (harness) => {
				const application = harness.application(ARRANGER_PROD);
				const credential = await harness.tokens.signIn(CORPUS_ANA);

				const whileUnreachable = await exchange(harness.url, {
					application,
					credential,
				});
				await provider.acceptConnections();
				time.advance(KEY_REFETCH_COOLDOWN_MS + 1000);
				const onceReachable = await exchange(harness.url, {
					application,
					credential,
				});

				assert.equal(whileUnreachable.status, 503);
				assert.equal(carriesToken(whileUnreachable.body), false);
				assert.equal(onceReachable.status, 200);
			},
			context,
		);
	});

	test(
		"keeps a token within the bridge's response cap for a principal holding a grant on every resource her audience serves",
		{ timeout: SEEDING_TIMEOUT_MS },
		async (context) => {
			await withHarness(
				{
					fixture: scaleFixture({
						baseTier: 'grant',
						count: DESIGNED_SCALE,
						grantedToAna: DESIGNED_SCALE,
					}),
				},
				async (harness) => {
					const answer = await exchangeAs(harness, { person: PEOPLE.ana });
					const payload = await payloadOf(harness, answer);

					assert.ok(Buffer.byteLength(answer.body, 'utf8') <= CONFIGURATION_DEFAULTS.responseCapBytes);
					assert.equal(payload.servedResources.length, DESIGNED_SCALE);
					assert.equal(Object.keys(payload.permissions).length, DESIGNED_SCALE);
				},
				context,
			);
		},
	);

	test(
		"answers 503 to a principal whose token would pass the bridge's response cap, logging the limit with her held count and the token's size and no resource, and serves a principal within it",
		{ timeout: SEEDING_TIMEOUT_MS },
		async (context) => {
			const log = captureLog();
			await withHarness(
				{
					configuration: { logStream: log.stream },
					fixture: scaleFixture({
						baseTier: 'grant',
						count: PAST_THE_CAP,
						grantedToAna: PAST_THE_CAP,
					}),
				},
				async (harness) => {
					const withinTheCap = await exchangeAs(harness, { person: PEOPLE.bo });
					const before = log.lines().length;

					const pastTheCap = await exchangeAs(harness, { person: PEOPLE.ana });
					const capEvents = (): readonly Readonly<Record<string, unknown>>[] =>
						cloudEventsIn(log.lines().slice(before))
							.filter(({ type }) => type === emittedType(TOKEN_CAP_EVENT.type))
							.map(dataOf)
							.filter(({ reason }) => reason === TOKEN_CAP_EVENT.reason);
					await eventually(() => Promise.resolve(capEvents().length > 0), EVENT_WITHIN_MS, 50);
					const logged = log.lines().slice(before);
					const resourceIds = [
						...Array.from({ length: PAST_THE_CAP }, (_, index) => scaleExternalId(index)),
						...Object.values(harness.seeded.resources),
					];

					assert.equal(withinTheCap.status, 200);
					assert.ok(carriesToken(withinTheCap.body));
					assert.equal(pastTheCap.status, 503);
					assert.equal(carriesToken(pastTheCap.body), false);
					const [event] = capEvents();
					assert.ok(event !== undefined, 'no event names the cap');
					assert.equal(event[TOKEN_CAP_EVENT.heldCountMember], PAST_THE_CAP);
					const size = event[TOKEN_CAP_EVENT.sizeMember];
					assert.ok(
						typeof size === 'number' && size > CONFIGURATION_DEFAULTS.responseCapBytes,
						`the token's size is logged as ${String(size)}`,
					);
					assert.deepEqual(
						logged.filter((line) => resourceIds.some((resourceId) => line.includes(resourceId))),
						[],
					);
				},
				context,
			);
		},
	);
});

// The developer writes these cases by hand from ticket #215's test plan, its "the exchange, as the
// bridge reads it" suite: a sign-in token signed by a key the provider does not publish, among the
// refused tokens that must be answered alike; and a channel assertion signed under another
// application's key, under the raw application key, under the notice subkey, under an algorithm other
// than HS256 or none, or naming an issuer the controller holds no key for. Each must be answered with
// no token: 403 for the sign-in token, 401 for the assertion.
suite(
	"accepts an exchange only with a sign-in token its provider signed with a published key and a channel assertion its application signed under its own subkey with the standard algorithm: the developer writes these cases by hand from ticket #215's test plan, suite 'the exchange, as the bridge reads it'",
	{ todo: true },
	() => {},
);
