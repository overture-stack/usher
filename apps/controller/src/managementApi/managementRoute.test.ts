import assert from 'node:assert/strict';
import { request } from 'node:http';
import { suite, test, type TestContext } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { type Actor, type AuditEvent, type LineFields, REFUSED_SUBJECT_MAXIMUM_LENGTH } from '../eventLog/index.js';
import { createServer, problem } from '../http/index.js';
import { CommitUnconfirmed } from '../storeTimeout/index.js';
import type { TokenClaims, TokenVerification } from '../identityProvider/index.js';
import { EXCESSIVE_LIFETIME, MISSING_ISSUED_AT, type StoredRefusal } from '../signInTokens/index.js';
import { createWindowedRefusals, type WindowedRefusals } from '../windowedRefusals/index.js';
import { managementRoute, STORE_FAILED } from './managementRoute.js';
import { BODY_LIMIT_BYTES } from './problems.js';
import { refusalTallyEvent } from './refusalTallyEvent.js';
import { readTextMembers } from './requestBody.js';
import type {
	AdministratorStatus,
	AfterCommitStepName,
	ManagementDependencies,
	ManagementOperation,
	OperationOutcome,
} from './types.js';

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

const SECONDS = Math.floor(NOW / 1000);

const ISSUER = 'https://auth.example.org/realms/usher';

const MAXIMUM_LIFETIME_SECONDS = 3600;

const SETTINGS = Object.freeze({
	clock: { now: () => NOW },
	firstUser: { realmRole: 'usher-first-user' },
	identityProviderIssuer: ISSUER,
	managementAudience: 'usher-management',
	managementClients: ['usher-ui'],
	serviceAccountRole: 'usher-service-account',
	signInTokenMaximumFor: () => MAXIMUM_LIFETIME_SECONDS,
});

const SHELF_LIMIT = problem('shelfFull', 409, 'Shelf full', 'The shelf is full.');

const claimsOf = (departures: Readonly<Record<string, unknown>> = {}): TokenClaims =>
	Object.fromEntries(
		Object.entries({
			aud: ['usher-management'],
			azp: 'usher-ui',
			exp: SECONDS + 300,
			iat: SECONDS - 10,
			iss: ISSUER,
			realm_access: { roles: ['offline_access'] },
			sub: 'subject-ana',
			typ: 'Bearer',
			...departures,
		}).filter(([, value]) => value !== undefined),
	);

const verified = (departures?: Readonly<Record<string, unknown>>): TokenVerification => ({
	claims: claimsOf(departures),
	header: { alg: 'RS256', typ: 'JWT' },
	kind: 'verified',
});

interface Recorded {
	actor: Actor;
	event: AuditEvent;
}

interface Line {
	fields: LineFields | undefined;
	message: string;
}

interface Stand {
	/** Whose admin status each request asked the store for, in turn. */
	administratorQuestions: { issuer: string; subject: string }[];

	/** What each request asked to run after its commit, by the names given. */
	afterCommit: (readonly AfterCommitStepName[])[];

	lines: Line[];
	ran: { input: unknown; params: Readonly<Record<string, string>> }[];
	recorded: Recorded[];

	/** The windows the refused credentials are counted in, which a test stops to close them. */
	refusals: WindowedRefusals;

	server: FastifyInstance;
}

// What a test changes of the operation its stand serves.
type OperationDepartures = Partial<
	Pick<
		ManagementOperation<{ title: string }>,
		| 'administratorOnly'
		| 'beforeFirstAdministrator'
		| 'body'
		| 'event'
		| 'firstUserOnly'
		| 'method'
		| 'readInput'
		| 'takesQuery'
	>
>;

// Ana is an administrator, and the only one.
const ANA_ADMINISTERS = async ({ subject }: { subject: string }): Promise<AdministratorStatus> => ({
	administrator: subject === 'subject-ana',
	anyAdministrator: true,
});

interface StandOptions {
	/** What the store says of administrators, or a failure to say. */
	administrators?: ManagementDependencies['administratorStatus'];
	/** The steps the operation names to run after its commit. */
	afterCommit?: readonly AfterCommitStepName[];

	/** What the operation serves differently from the stand's own. */
	departures?: OperationDepartures;

	/** What the operation answers. */
	outcome?: () => Promise<OperationOutcome>;

	/** How the steps after a commit run, once they are kept as asked. */
	runAfterCommit?: ManagementDependencies['runAfterCommit'];

	/** What the store says of the principal's standing, or a failure to say. */
	standing?: () => Promise<StoredRefusal | undefined>;

	/** What the verifier gives each token. */
	verifications?: Readonly<Record<string, TokenVerification>>;
}

const ROUTE = '/admin/shelves/{id}/books';

// The id the stand's trail gives every event it records.
const EVENT_ID = '0f4c1a2b-3d5e-4f60-8a7b-9c0d1e2f3a4b';

const INSTANT = new Date(NOW).toISOString();

// The managementToken.refusal of a credential refused at the stand's operation, naming no subject.
const refusalOf = (reason: string): Recorded => ({
	actor: { type: 'anonymous' },
	event: {
		data: {
			method: 'POST',
			reason,
			result: 'denied',
			route: ROUTE,
			sourceIp: '127.0.0.1',
		},
		severity: 'warning',
		type: 'managementToken.refusal',
	},
});

// The managementToken.refusalTally closing a window at the stand's fixed instant.
const closingOf = (reason: string, count: number): Recorded => ({
	actor: { type: 'system' },
	event: {
		data: {
			count,
			firstSeenAt: INSTANT,
			lastSeenAt: INSTANT,
			reason,
			windowId: EVENT_ID,
		},
		severity: 'warning',
		type: 'managementToken.refusalTally',
	},
});

// An operation shaped as the application operations are: administrators alone, a JSON body holding
// one required text member, and an event naming the shelf the request names.
const shelving = (
	ran: Stand['ran'],
	outcome: () => Promise<OperationOutcome>,
	afterCommit: readonly AfterCommitStepName[] | undefined,
	departures: OperationDepartures = {},
): ManagementOperation<{ title: string }> => ({
	administratorOnly: true,
	...(afterCommit === undefined ? {} : { afterCommit }),
	body: 'required',
	event: {
		named: async ({ params }) => (params['id'] === 'shelf-1' ? { shelfId: 'shelf-1' } : {}),
		type: 'application.registration',
	},
	method: 'POST',
	readInput: (body) => {
		const reading = readTextMembers(body ?? {}, { title: { required: true } });
		return reading.kind === 'read' ? { input: { title: reading.members['title'] ?? '' }, kind: 'read' } : reading;
	},
	route: ROUTE,
	run: async ({ input, params }) => {
		ran.push({ input, params });
		return outcome();
	},
	...departures,
});

const standUp = async (
	context: TestContext,
	{
		administrators = ANA_ADMINISTERS,
		afterCommit,
		departures,
		outcome = async () => ({
			body: { shelved: true },
			forbidsStoring: true,
			kind: 'answered',
			status: 201,
		}),
		runAfterCommit = async () => undefined,
		standing = async () => undefined,
		verifications = {},
	}: StandOptions = {},
): Promise<Stand> => {
	const recorded: Recorded[] = [];
	const lines: Line[] = [];
	const trail: ManagementDependencies['trail'] = {
		recordEvent: async (actor, event) => {
			recorded.push({ actor, event });
			return EVENT_ID;
		},
	};
	const log = {
		error: (message: string, fields?: LineFields) => {
			lines.push({ fields, message });
		},
	};
	const stand: Omit<Stand, 'server'> = {
		administratorQuestions: [],
		afterCommit: [],
		lines,
		ran: [],
		recorded,
		refusals: createWindowedRefusals({
			clock: SETTINGS.clock,
			closingEvents: {
				exchange: refusalTallyEvent,
				logout: refusalTallyEvent,
				management: refusalTallyEvent,
			},
			log,
			trail,
		}),
	};
	const server = createServer({
		isLive: () => true,
		isReady: async () => true,
		trustedProxies: [],
	});
	server.route(
		managementRoute(shelving(stand.ran, outcome, afterCommit, departures), {
			administratorStatus: (identity) => {
				stand.administratorQuestions.push(identity);
				return administrators(identity);
			},
			eventLog: log,
			refusals: stand.refusals,
			runAfterCommit: (steps) => {
				stand.afterCommit.push(steps);
				return runAfterCommit(steps);
			},
			settings: SETTINGS,
			storedRefusal: standing,
			tokenVerifier: {
				verify: async (token) =>
					verifications[token] ?? {
						kind: 'unverified',
						reason: 'invalidSignature',
					},
			},
			trail,
		}),
	);
	context.after(() => server.close());
	return { ...stand, server };
};

const BODY = '{"title":"Dubliners"}';

const post = (
	{ server }: Stand,
	{
		body = BODY,
		headers = {},
		token = 'admin',
		url = '/admin/shelves/shelf-1/books',
	}: {
		body?: string;
		headers?: Readonly<Record<string, string>>;
		token?: string | null;
		url?: string;
	} = {},
) =>
	server.inject({
		headers: {
			'content-type': 'application/json',
			...(token === null ? {} : { authorization: `Bearer ${token}` }),
			...headers,
		},
		method: 'POST',
		payload: body,
		url,
	});

// Two Authorization header lines, sent over a socket, since an injected request carries one value per
// header.
const twiceAuthorized = async ({ server }: Stand): Promise<{ body: string; statusCode: number }> => {
	const url = await server.listen({ host: '127.0.0.1', port: 0 });
	const { hostname, port } = new URL(url);
	return new Promise((resolve, reject) => {
		const sent = request(
			{
				// Built from entries, since Node types a known header as holding one value.
				headers: Object.fromEntries([
					['authorization', ['Bearer admin', 'Bearer admin']],
					['content-length', String(Buffer.byteLength(BODY))],
					['content-type', 'application/json'],
				]),
				host: hostname,
				method: 'POST',
				path: '/admin/shelves/shelf-1/books',
				port,
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on('data', (chunk: Buffer) => chunks.push(chunk));
				response.on('end', () => {
					resolve({
						body: Buffer.concat(chunks).toString('utf8'),
						statusCode: response.statusCode ?? 0,
					});
				});
			},
		);
		sent.on('error', reject);
		sent.end(BODY);
	});
};

const codeOf = (answer: { body: string }): unknown => {
	const parsed: unknown = JSON.parse(answer.body);
	return typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'code') : undefined;
};

const ADMIN = { admin: verified() };

suite('admitting a request to a management operation', () => {
	test('runs the operation for a platform administrator, answering what it answers, and forbids storing an answer that says so', async (context) => {
		const stand = await standUp(context, { verifications: ADMIN });

		const answer = await post(stand);

		assert.equal(answer.statusCode, 201);
		assert.equal(answer.headers['cache-control'], 'no-store');
		assert.deepEqual(JSON.parse(answer.body), { shelved: true });
		assert.deepEqual(stand.ran, [{ input: { title: 'Dubliners' }, params: { id: 'shelf-1' } }]);
		assert.deepEqual(stand.recorded, []);
	});

	test('refuses a request with no credential 401 naming the Bearer scheme, recording and counting nothing', async (context) => {
		const stand = await standUp(context);

		const answer = await post(stand, { token: null });

		assert.equal(answer.statusCode, 401);
		assert.equal(answer.headers['www-authenticate'], 'Bearer');
		assert.match(String(answer.headers['content-type']), /^application\/problem\+json/u);
		await stand.refusals.stop();
		assert.deepEqual([stand.recorded, stand.ran], [[], []]);
	});

	test('refuses two credentials, another scheme, or a credential in the query 400, before verifying anything, recording the first as managementToken.refusal for malformedCredential and counting the rest in its window', async (context) => {
		const stand = await standUp(context, { verifications: ADMIN });

		const answers = [
			await twiceAuthorized(stand),
			await post(stand, { headers: { authorization: 'Basic admin' } }),
			await post(stand, {
				token: null,
				url: '/admin/shelves/shelf-1/books?access_token=admin',
			}),
		];

		answers.forEach((answer) => {
			assert.equal(answer.statusCode, 400);
			assert.equal(codeOf(answer), 'malformedCredential');
		});
		const recordedBeforeStop = [...stand.recorded];
		await stand.refusals.stop();

		assert.deepEqual(recordedBeforeStop, [refusalOf('malformedCredential')]);
		assert.deepEqual(stand.recorded, [refusalOf('malformedCredential'), closingOf('malformedCredential', 3)]);
		assert.deepEqual(stand.ran, []);
	});

	test("records the first credential it cannot verify for each reason as managementToken.refusal naming no subject, and counts each later one in that reason's window, whatever the credential", async (context) => {
		const stand = await standUp(context, {
			verifications: {
				forged: { kind: 'unverified', reason: 'invalidSignature' },
				forgedAgain: { kind: 'unverified', reason: 'invalidSignature' },
				other: { kind: 'unverified', reason: 'otherIssuer' },
				unreadable: { kind: 'unverified', reason: 'unreadableToken' },
			},
		});

		const answers = [
			await post(stand, { token: 'other' }),
			await post(stand, { token: 'forged' }),
			await post(stand, { token: 'unreadable' }),
			await post(stand, { token: 'forgedAgain' }),
			await post(stand, { token: 'forged' }),
		];
		const recordedBeforeStop = [...stand.recorded];
		await stand.refusals.stop();

		answers.forEach((answer) => assert.equal(answer.statusCode, 401));
		assert.deepEqual(recordedBeforeStop, [
			refusalOf('otherIssuer'),
			refusalOf('invalidSignature'),
			refusalOf('unreadableToken'),
		]);
		assert.deepEqual(stand.recorded.slice(3), [
			closingOf('otherIssuer', 1),
			closingOf('invalidSignature', 3),
			closingOf('unreadableToken', 1),
		]);
	});

	test("records a verified token's first refusal for a reason, counts its later ones in that window, and opens another window for another token", async (context) => {
		const stand = await standUp(context, {
			verifications: {
				expired: verified({ exp: SECONDS - 60 }),
				expiredToo: verified({ exp: SECONDS - 60 }),
			},
		});

		const answers = [
			await post(stand, { token: 'expired' }),
			await post(stand, { token: 'expired' }),
			await post(stand, { token: 'expiredToo' }),
			await post(stand, { token: 'expired' }),
		];
		const recordedBeforeStop = stand.recorded.map(({ event }) => event.type);
		await stand.refusals.stop();

		answers.forEach((answer) => assert.equal(answer.statusCode, 401));
		assert.deepEqual(recordedBeforeStop, ['managementToken.refusal', 'managementToken.refusal']);
		assert.deepEqual(stand.recorded.slice(2), [closingOf('expiredToken', 3), closingOf('expiredToken', 1)]);
	});

	test('records a verified token naming no usable subject as managementToken.refusal for missingSubject, naming no subject', async (context) => {
		const stand = await standUp(context, {
			verifications: {
				blank: verified({ sub: '' }),
				nameless: verified({ sub: undefined }),
				numbered: verified({ sub: 7 }),
			},
		});

		const answers = [
			await post(stand, { token: 'nameless' }),
			await post(stand, { token: 'blank' }),
			await post(stand, { token: 'numbered' }),
		];

		answers.forEach((answer) => {
			assert.equal(answer.statusCode, 401);
			assert.equal(codeOf(answer), 'credentialRefused');
		});
		assert.deepEqual(
			stand.recorded,
			answers.map(() => ({
				actor: { type: 'anonymous' },
				event: {
					data: {
						method: 'POST',
						reason: 'missingSubject',
						result: 'denied',
						route: ROUTE,
						sourceIp: '127.0.0.1',
					},
					severity: 'warning',
					type: 'managementToken.refusal',
				},
			})),
		);
		assert.deepEqual(stand.ran, []);
	});

	test("records a verified token refused for its claims as managementToken.refusal, its actor anonymous, naming the route's template and the token's subject", async (context) => {
		const stand = await standUp(context, {
			verifications: { expired: verified({ exp: SECONDS - 60 }) },
		});

		const answer = await post(stand, { token: 'expired' });

		assert.equal(answer.statusCode, 401);
		assert.deepEqual(stand.recorded, [
			{
				actor: { type: 'anonymous' },
				event: {
					data: {
						method: 'POST',
						reason: 'expiredToken',
						refusedSubject: 'subject-ana',
						result: 'denied',
						route: ROUTE,
						sourceIp: '127.0.0.1',
					},
					severity: 'warning',
					type: 'managementToken.refusal',
				},
			},
		]);
		assert.deepEqual(stand.ran, []);
	});

	test('refuses a verified token naming no iat, and one whose exp falls more than the configured maximum lifetime after its iat, 401 credentialRefused, recording a managementToken.refusal naming its subject for each', async (context) => {
		const stand = await standUp(context, {
			verifications: {
				overLong: verified({
					exp: SECONDS + MAXIMUM_LIFETIME_SECONDS,
				}),
				undated: verified({ iat: undefined }),
			},
		});

		const answers = [await post(stand, { token: 'undated' }), await post(stand, { token: 'overLong' })];

		assert.deepEqual(
			answers.map((answer) => [answer.statusCode, codeOf(answer)]),
			[
				[401, 'credentialRefused'],
				[401, 'credentialRefused'],
			],
		);
		assert.deepEqual(
			stand.recorded,
			[MISSING_ISSUED_AT, EXCESSIVE_LIFETIME].map((reason) => ({
				actor: { type: 'anonymous' },
				event: {
					data: {
						method: 'POST',
						reason,
						refusedSubject: 'subject-ana',
						result: 'denied',
						route: ROUTE,
						sourceIp: '127.0.0.1',
					},
					severity: 'warning',
					type: 'managementToken.refusal',
				},
			})),
		);
		assert.deepEqual(stand.ran, []);
	});

	test('refuses a verified ID token 401 credentialRefused, recording one managementToken.refusal for otherType naming its subject', async (context) => {
		const stand = await standUp(context, {
			verifications: { identity: verified({ typ: 'ID' }) },
		});

		const answer = await post(stand, { token: 'identity' });

		assert.equal(answer.statusCode, 401);
		assert.equal(codeOf(answer), 'credentialRefused');
		assert.deepEqual(stand.recorded, [
			{
				actor: { type: 'anonymous' },
				event: {
					data: {
						method: 'POST',
						reason: 'otherType',
						refusedSubject: 'subject-ana',
						result: 'denied',
						route: ROUTE,
						sourceIp: '127.0.0.1',
					},
					severity: 'warning',
					type: 'managementToken.refusal',
				},
			},
		]);
		assert.deepEqual(stand.ran, []);
	});

	test('names a refused subject of the maximum length whole, and leaves out a longer one', async (context) => {
		const atLimit = 'a'.repeat(REFUSED_SUBJECT_MAXIMUM_LENGTH);
		const pastLimit = 'b'.repeat(REFUSED_SUBJECT_MAXIMUM_LENGTH + 1);
		const stand = await standUp(context, {
			verifications: {
				atLimit: verified({ exp: undefined, sub: atLimit }),
				pastLimit: verified({ exp: undefined, sub: pastLimit }),
			},
		});

		await post(stand, { token: 'atLimit' });
		await post(stand, { token: 'pastLimit' });

		assert.deepEqual(
			stand.recorded.map(({ event }) => event.data['refusedSubject']),
			[atLimit, undefined],
		);
		assert.equal(Object.hasOwn(stand.recorded[1]?.event.data ?? {}, 'refusedSubject'), false);
	});

	test('answers every refused credential alike, whether recorded, counted or neither', async (context) => {
		const stand = await standUp(context, {
			verifications: {
				expired: verified({ exp: SECONDS - 60 }),
				identity: verified({ typ: 'ID' }),
				nameless: verified({ sub: undefined }),
				other: { kind: 'unverified', reason: 'otherIssuer' },
				otherClient: verified({ azp: 'portal' }),
			},
		});

		const answers = await Promise.all(
			[null, 'expired', 'identity', 'nameless', 'other', 'otherClient'].map((token) => post(stand, { token })),
		);

		const shown = answers.map(({ body, headers, statusCode }) => ({
			authenticate: headers['www-authenticate'],
			body,
			statusCode,
		}));
		shown.forEach((answer) => assert.deepEqual(answer, shown[0]));
	});

	test('records a revoked principal, a platform revocation or a session signed out as managementToken.refusal naming the subject, and answers a store that cannot say 503 with a line', async (context) => {
		const refusals: (StoredRefusal | Error)[] = [
			'revokedPrincipal',
			'revokedPlatform',
			'signedOutSession',
			Object.assign(new Error('the store is down'), { code: 'ECONNREFUSED' }),
		];
		const stand = await standUp(context, {
			standing: async () => {
				const next = refusals.shift();
				if (next instanceof Error) {
					throw next;
				}
				return next;
			},
			verifications: ADMIN,
		});

		const answers = [await post(stand), await post(stand), await post(stand), await post(stand)];

		assert.deepEqual(
			answers.map((answer) => [answer.statusCode, codeOf(answer)]),
			[
				[401, 'credentialRefused'],
				[401, 'credentialRefused'],
				[401, 'credentialRefused'],
				[503, 'storeUnavailable'],
			],
		);
		assert.deepEqual(
			stand.recorded.map(({ actor, event }) => [
				actor,
				event.type,
				event.data['reason'],
				event.data['refusedSubject'],
			]),
			[
				[{ type: 'anonymous' }, 'managementToken.refusal', 'revokedPrincipal', 'subject-ana'],
				[{ type: 'anonymous' }, 'managementToken.refusal', 'revokedPlatform', 'subject-ana'],
				[{ type: 'anonymous' }, 'managementToken.refusal', 'signedOutSession', 'subject-ana'],
			],
		);
		assert.deepEqual(stand.lines, [
			{
				fields: { code: 'ECONNREFUSED', method: 'POST', route: ROUTE },
				message: STORE_FAILED,
			},
		]);
		assert.deepEqual(stand.ran, []);
	});

	test("answers 503 while the identity provider's keys cannot be fetched, recording, counting and writing nothing per request", async (context) => {
		const stand = await standUp(context, {
			verifications: { admin: { kind: 'keysUnavailable' } },
		});

		const answers = [await post(stand), await post(stand)];

		answers.forEach((answer) => {
			assert.equal(answer.statusCode, 503);
			assert.equal(codeOf(answer), 'identityProviderUnavailable');
		});
		await stand.refusals.stop();
		assert.deepEqual([stand.lines, stand.recorded, stand.ran], [[], [], []]);
	});

	test('answers 503 signingKeyUnconfirmed with Retry-After for a signing key not confirmed yet, recording, counting and writing nothing', async (context) => {
		const stand = await standUp(context, {
			verifications: {
				admin: { kind: 'signingKeyUnconfirmed', retryAfterSeconds: 17 },
			},
		});

		const answer = await post(stand);

		assert.equal(answer.statusCode, 503);
		assert.equal(answer.headers['retry-after'], '17');
		assert.equal(codeOf(answer), 'signingKeyUnconfirmed');
		await stand.refusals.stop();
		assert.deepEqual([stand.lines, stand.recorded, stand.ran], [[], [], []]);
	});

	test('refuses a subject or session holding text that cannot be stored, or a session that is not text, 400, recording managementToken.refusal for unrepresentableSubject, naming no subject', async (context) => {
		const stand = await standUp(context, {
			verifications: {
				nul: verified({ sub: 'ana\u0000' }),
				number: verified({ sid: 42 }),
				surrogate: verified({ sid: '\uD800' }),
			},
		});

		const answers = [
			await post(stand, { token: 'nul' }),
			await post(stand, { token: 'surrogate' }),
			await post(stand, { token: 'number' }),
		];

		answers.forEach((answer) => {
			assert.equal(answer.statusCode, 400);
			assert.equal(codeOf(answer), 'unrepresentableText');
		});
		assert.deepEqual(
			stand.recorded,
			answers.map(() => ({
				actor: { type: 'anonymous' },
				event: {
					data: {
						method: 'POST',
						reason: 'unrepresentableSubject',
						result: 'denied',
						route: ROUTE,
						sourceIp: '127.0.0.1',
					},
					severity: 'warning',
					type: 'managementToken.refusal',
				},
			})),
		);
		assert.deepEqual(stand.ran, []);
	});
});

suite("a management operation's refusals, as its own event records them", () => {
	const deniedFor = (stand: Stand): readonly { actor: Actor; data: Readonly<Record<string, unknown>> }[] =>
		stand.recorded.map(({ actor, event }) => {
			assert.equal(event.type, 'application.registration');
			return { actor, data: event.data };
		});

	test('refuses a service account, an administrator notwithstanding, and anyone else not an administrator 403, recording each denied under its actor and naming the shelf', async (context) => {
		const stand = await standUp(context, {
			administrators: async ({ subject }) => ({
				administrator: subject !== 'subject-bo',
				anyAdministrator: true,
			}),
			verifications: {
				reader: verified({ sub: 'subject-bo' }),
				service: verified({ client_id: 'lyric-svc', sub: 'service-1' }),
			},
		});

		const answers = [await post(stand, { token: 'service' }), await post(stand, { token: 'reader' })];

		assert.deepEqual(
			answers.map((answer) => [answer.statusCode, codeOf(answer)]),
			[
				[403, 'serviceAccountNotPermitted'],
				[403, 'administratorOnly'],
			],
		);
		assert.deepEqual(deniedFor(stand), [
			{
				actor: { id: 'service-1', type: 'serviceAccount' },
				data: {
					reason: 'serviceAccountNotPermitted',
					result: 'denied',
					shelfId: 'shelf-1',
					sourceIp: '127.0.0.1',
				},
			},
			{
				actor: { id: 'subject-bo', type: 'human' },
				data: {
					reason: 'administratorOnly',
					result: 'denied',
					shelfId: 'shelf-1',
					sourceIp: '127.0.0.1',
				},
			},
		]);
		assert.equal(stand.recorded[0]?.event.severity, 'warning');
		assert.deepEqual(stand.ran, []);
	});

	test('refuses a body too large, in another media type, unreadable, holding a member twice, or holding text that cannot be stored, and a query, each recorded denied with the code answered', async (context) => {
		const stand = await standUp(context, { verifications: ADMIN });

		const answers = [
			await post(stand, {
				body: `{"title":"${'x'.repeat(BODY_LIMIT_BYTES)}"}`,
			}),
			await post(stand, { headers: { 'content-type': 'text/plain' } }),
			await post(stand, { body: '{"title":' }),
			await post(stand, { body: '{"title":"a","title":"b"}' }),
			await post(stand, { body: '{"title":"a\\u0000"}' }),
			await post(stand, { url: '/admin/shelves/shelf-1/books?page=2' }),
			await post(stand, { body: '{}' }),
			await post(stand, { body: '' }),
		];

		assert.deepEqual(
			answers.map((answer) => [answer.statusCode, codeOf(answer)]),
			[
				[413, 'bodyTooLarge'],
				[415, 'unsupportedMediaType'],
				[400, 'unreadableBody'],
				[400, 'unreadableBody'],
				[400, 'unrepresentableText'],
				[400, 'unreadableQuery'],
				[400, 'unreadableBody'],
				[400, 'unreadableBody'],
			],
		);
		assert.match(String(JSON.parse(answers[0]?.body ?? '{}').detail), /65536/u);
		assert.deepEqual(
			deniedFor(stand).map(({ data }) => data['reason']),
			answers.map(codeOf),
		);
		assert.deepEqual(stand.ran, []);
	});

	test('refuses a path parameter holding text that cannot be stored 400 unrepresentableText before the query and the body, recording it denied naming nothing, and never reads what it names, for a refusal of authority either', async (context) => {
		const looked: Readonly<Record<string, string>>[] = [];
		const stand = await standUp(context, {
			departures: {
				event: {
					named: async ({ params }) => {
						looked.push(params);
						return { shelfId: 'shelf-1' };
					},
					type: 'application.registration',
				},
			},
			verifications: {
				...ADMIN,
				reader: verified({ sub: 'subject-bo' }),
			},
		});

		const answers = [
			await post(stand, {
				body: '{"title":',
				url: '/admin/shelves/shelf%00-1/books?page=2',
			}),
			await post(stand, {
				token: 'reader',
				url: '/admin/shelves/shelf%00-1/books',
			}),
		];

		assert.deepEqual(
			answers.map((answer) => [answer.statusCode, codeOf(answer)]),
			[
				[400, 'unrepresentableText'],
				[403, 'administratorOnly'],
			],
		);
		assert.deepEqual(deniedFor(stand), [
			{
				actor: { id: 'subject-ana', type: 'human' },
				data: {
					reason: 'unrepresentableText',
					result: 'denied',
					sourceIp: '127.0.0.1',
				},
			},
			{
				actor: { id: 'subject-bo', type: 'human' },
				data: {
					reason: 'administratorOnly',
					result: 'denied',
					sourceIp: '127.0.0.1',
				},
			},
		]);
		assert.deepEqual(looked, []);
		assert.deepEqual(stand.ran, []);
	});

	test('records a refusal the operation answers as denied, naming only what exists', async (context) => {
		const stand = await standUp(context, {
			outcome: async () => ({ kind: 'refused', problem: SHELF_LIMIT }),
			verifications: ADMIN,
		});

		const answers = [await post(stand), await post(stand, { url: '/admin/shelves/shelf-2/books' })];

		answers.forEach((answer) => {
			assert.equal(answer.statusCode, 409);
			assert.equal(codeOf(answer), 'shelfFull');
		});
		assert.deepEqual(
			deniedFor(stand).map(({ data }) => data),
			[
				{
					reason: 'shelfFull',
					result: 'denied',
					shelfId: 'shelf-1',
					sourceIp: '127.0.0.1',
				},
				{ reason: 'shelfFull', result: 'denied', sourceIp: '127.0.0.1' },
			],
		);
	});

	test("names in a refused event what the request's body names, as the operation reads it, and nothing of a body holding text that cannot be stored", async (context) => {
		const stand = await standUp(context, {
			departures: {
				event: {
					named: async ({ body }) => {
						const title = body?.['title'];
						return typeof title === 'string' ? { title } : {};
					},
					type: 'application.registration',
				},
			},
			outcome: async () => ({ kind: 'refused', problem: SHELF_LIMIT }),
			verifications: ADMIN,
		});

		const answers = [
			await post(stand),
			await post(stand, { body: '{"title":"Dubliners","x":"\\u0000"}' }),
			await post(stand, { body: '{"title":7}' }),
		];

		assert.deepEqual(
			answers.map((answer) => [answer.statusCode, codeOf(answer)]),
			[
				[409, 'shelfFull'],
				[400, 'unrepresentableText'],
				[400, 'unreadableBody'],
			],
		);
		assert.deepEqual(
			deniedFor(stand).map(({ data }) => data),
			[
				{
					reason: 'shelfFull',
					result: 'denied',
					sourceIp: '127.0.0.1',
					title: 'Dubliners',
				},
				{
					reason: 'unrepresentableText',
					result: 'denied',
					sourceIp: '127.0.0.1',
				},
				{ reason: 'unreadableBody', result: 'denied', sourceIp: '127.0.0.1' },
			],
		);
	});

	test('records a refusal under the event type the operation reads from what the request names', async (context) => {
		const stand = await standUp(context, {
			departures: {
				event: {
					named: async () => ({}),
					type: ({ body }) =>
						body?.['title'] === 'Ulysses'
							? 'application.registration'
							: 'application.servedResourcesChange',
				},
			},
			outcome: async () => ({ kind: 'refused', problem: SHELF_LIMIT }),
			verifications: ADMIN,
		});

		await post(stand, { body: '{"title":"Ulysses"}' });
		await post(stand);
		await post(stand, { body: '{"title":"\\u0000"}' });

		assert.deepEqual(
			stand.recorded.map(({ event }) => [event.type, event.data['reason']]),
			[
				['application.registration', 'shelfFull'],
				['application.servedResourcesChange', 'shelfFull'],
				['application.servedResourcesChange', 'unrepresentableText'],
			],
		);
	});

	test('records the reason an operation gives for its refusal in place of the code answered, the answer unchanged', async (context) => {
		const hidden = problem('shelfNotFound', 404, 'Shelf not found', 'No shelf you may see has the id named.');
		const stand = await standUp(context, {
			outcome: async () => ({
				kind: 'refused',
				problem: hidden,
				recordedReason: 'noAuthorityOnShelf',
			}),
			verifications: ADMIN,
		});

		const answer = await post(stand);

		assert.equal(answer.statusCode, 404);
		assert.deepEqual(JSON.parse(answer.body), hidden);
		assert.deepEqual(
			deniedFor(stand).map(({ data }) => data),
			[
				{
					reason: 'noAuthorityOnShelf',
					result: 'denied',
					shelfId: 'shelf-1',
					sourceIp: '127.0.0.1',
				},
			],
		);
	});

	test('answers a failure the operation throws 503 storeUnavailable, with a line naming its code and the event recorded failed at error', async (context) => {
		const stand = await standUp(context, {
			outcome: async () => {
				throw Object.assign(new Error('permission denied for table'), {
					code: '42501',
				});
			},
			verifications: ADMIN,
		});

		const answer = await post(stand);

		assert.equal(answer.statusCode, 503);
		assert.equal(codeOf(answer), 'storeUnavailable');
		assert.equal(answer.body.includes('permission'), false);
		assert.deepEqual(stand.lines, [
			{
				fields: { code: '42501', method: 'POST', route: ROUTE },
				message: STORE_FAILED,
			},
		]);
		assert.deepEqual(
			stand.recorded.map(({ event }) => ({
				data: event.data,
				severity: event.severity,
			})),
			[
				{
					data: {
						reason: 'storeUnavailable',
						result: 'failed',
						shelfId: 'shelf-1',
						sourceIp: '127.0.0.1',
					},
					severity: 'error',
				},
			],
		);
	});

	test('answers a dependency the operation names unavailable with its problem, the event recorded failed at error naming its code, running no step after a commit', async (context) => {
		const unavailable = {
			code: 'shelfCatalogueUnavailable',
			detail: 'The shelf catalogue cannot answer now. Try again later.',
			status: 503,
			title: 'Shelf catalogue unavailable',
		};
		const stand = await standUp(context, {
			afterCommit: ['keyReload'],
			outcome: async () => ({ kind: 'unavailable', problem: unavailable }),
			verifications: ADMIN,
		});

		const answer = await post(stand);

		assert.equal(answer.statusCode, 503);
		assert.deepEqual(JSON.parse(answer.body), unavailable);
		assert.equal(answer.headers['retry-after'], undefined);
		assert.deepEqual(stand.lines, []);
		assert.deepEqual(stand.afterCommit, []);
		assert.deepEqual(
			stand.recorded.map(({ event }) => ({
				data: event.data,
				severity: event.severity,
			})),
			[
				{
					data: {
						reason: 'shelfCatalogueUnavailable',
						result: 'failed',
						shelfId: 'shelf-1',
						sourceIp: '127.0.0.1',
					},
					severity: 'error',
				},
			],
		);
	});

	test('answers an operation whose COMMIT the store did not confirm 503 outcomeUnknown, recording no event and writing no line of its own', async (context) => {
		const stand = await standUp(context, {
			outcome: async () => {
				throw new CommitUnconfirmed();
			},
			verifications: ADMIN,
		});

		const answer = await post(stand);

		assert.equal(answer.statusCode, 503);
		assert.deepEqual(JSON.parse(answer.body), {
			code: 'outcomeUnknown',
			detail: 'The store did not confirm whether this change was made. Read what it changes before trying again.',
			status: 503,
			title: 'Outcome unknown',
		});
		assert.deepEqual(stand.lines, []);
		assert.deepEqual(stand.recorded, []);
	});

	test('serves the operation at its method alone, every other method answering 404 as an unserved path does', async (context) => {
		const stand = await standUp(context, { verifications: ADMIN });

		const answers = await Promise.all(
			(['GET', 'HEAD', 'PUT'] as const).map((method) =>
				stand.server.inject({
					headers: { authorization: 'Bearer admin' },
					method,
					url: '/admin/shelves/shelf-1/books',
				}),
			),
		);

		answers.forEach((answer) => {
			assert.equal(answer.statusCode, 404);
			assert.equal(answer.body, '');
		});
	});
});

// Settles once a condition holds, checking it again after each turn of the event loop, or once it has
// checked for as many turns as it was given, so a condition never met fails the test that awaits it
// rather than holding it open.
const turnsUntil = async (condition: () => boolean, turns = 1000): Promise<void> => {
	if (condition() || turns === 0) {
		return;
	}
	await new Promise((resolve) => {
		setImmediate(resolve);
	});
	await turnsUntil(condition, turns - 1);
};

suite("a management operation's admin status and its first administrator", () => {
	const NO_ADMINISTRATOR = async (): Promise<AdministratorStatus> => ({
		administrator: false,
		anyAdministrator: false,
	});

	const bodyOf = (answer: { body: string }): unknown => JSON.parse(answer.body);

	test("reads admin status from the store on every request, by the trusted issuer and the token's subject, and never from the token", async (context) => {
		const answers: AdministratorStatus[] = [
			{ administrator: false, anyAdministrator: true },
			{ administrator: true, anyAdministrator: true },
		];
		const stand = await standUp(context, {
			administrators: async () => answers.shift() ?? { administrator: false, anyAdministrator: true },
			verifications: {
				admin: verified({
					realm_access: {
						roles: ['usher-first-user', 'usher-platform-admin'],
					},
				}),
			},
		});

		const refused = await post(stand);
		const admitted = await post(stand);

		assert.deepEqual(
			[refused, admitted].map((answer) => [answer.statusCode, codeOf(answer)]),
			[
				[403, 'administratorOnly'],
				[201, undefined],
			],
		);
		assert.deepEqual(stand.administratorQuestions, [
			{ issuer: ISSUER, subject: 'subject-ana' },
			{ issuer: ISSUER, subject: 'subject-ana' },
		]);
	});

	test('refuses every operation 403 noAdministratorYet while no administrator has accepted, service accounts included, recording each denied and saying how the first is made', async (context) => {
		const stand = await standUp(context, {
			administrators: NO_ADMINISTRATOR,
			departures: { administratorOnly: false },
			verifications: {
				...ADMIN,
				first: verified({ realm_access: { roles: ['usher-first-user'] } }),
				service: verified({ client_id: 'lyric-svc', sub: 'service-1' }),
			},
		});

		const answers = [
			await post(stand),
			await post(stand, { token: 'first' }),
			await post(stand, { token: 'service' }),
		];

		assert.deepEqual(
			answers.map((answer) => [answer.statusCode, codeOf(answer)]),
			[
				[403, 'noAdministratorYet'],
				[403, 'noAdministratorYet'],
				[403, 'noAdministratorYet'],
			],
		);
		assert.match(
			String(Reflect.get(Object(bodyOf(answers[0] ?? { body: '{}' })), 'detail')),
			/POST \/admin\/nominations/u,
		);
		assert.deepEqual(
			stand.recorded.map(({ actor, event }) => [
				actor,
				event.type,
				event.data['reason'],
				event.data['result'],
				event.severity,
			]),
			[
				[
					{ id: 'subject-ana', type: 'human' },
					'application.registration',
					'noAdministratorYet',
					'denied',
					'warning',
				],
				[
					{ id: 'subject-ana', type: 'human' },
					'application.registration',
					'noAdministratorYet',
					'denied',
					'warning',
				],
				[
					{ id: 'service-1', type: 'serviceAccount' },
					'application.registration',
					'noAdministratorYet',
					'denied',
					'warning',
				],
			],
		);
		assert.deepEqual(stand.ran, []);
	});

	test('answers an operation served before the first administrator while none has accepted, and refuses a service account 403 serviceAccountNotPermitted there', async (context) => {
		const stand = await standUp(context, {
			administrators: NO_ADMINISTRATOR,
			departures: {
				administratorOnly: false,
				beforeFirstAdministrator: true,
			},
			verifications: {
				...ADMIN,
				service: verified({ client_id: 'lyric-svc', sub: 'service-1' }),
			},
		});

		const answers = [await post(stand), await post(stand, { token: 'service' })];

		assert.deepEqual(
			answers.map((answer) => [answer.statusCode, codeOf(answer)]),
			[
				[201, undefined],
				[403, 'serviceAccountNotPermitted'],
			],
		);
		assert.equal(stand.ran.length, 1);
	});

	test("refuses a token lacking the first-user role 403 notFirstUser for the first user's operation, before its body is read, and gives the principal whether it holds the role", async (context) => {
		const read: unknown[] = [];
		const stand = await standUp(context, {
			administrators: NO_ADMINISTRATOR,
			departures: {
				administratorOnly: false,
				beforeFirstAdministrator: true,
				firstUserOnly: true,
				readInput: (_body, { principal }) => {
					read.push(principal);
					return { input: { title: 'nominated' }, kind: 'read' };
				},
			},
			verifications: {
				...ADMIN,
				first: verified({ realm_access: { roles: ['usher-first-user'] } }),
				recased: verified({ realm_access: { roles: ['Usher-First-User'] } }),
			},
		});

		const answers = [
			await post(stand, { body: '{"title":' }),
			await post(stand, { body: '{"title":', token: 'recased' }),
			await post(stand, { token: 'first' }),
		];

		assert.deepEqual(
			answers.map((answer) => [answer.statusCode, codeOf(answer)]),
			[
				[403, 'notFirstUser'],
				[403, 'notFirstUser'],
				[201, undefined],
			],
		);
		assert.deepEqual(
			stand.recorded.map(({ event }) => [event.data['reason'], event.severity]),
			[
				['notFirstUser', 'warning'],
				['notFirstUser', 'warning'],
			],
		);
		assert.deepEqual(read, [
			{
				administrator: false,
				firstUser: true,
				subject: 'subject-ana',
				tokenLifetimeSeconds: 310,
				type: 'human',
			},
		]);
	});

	test('answers a store that cannot read admin status 503 storeUnavailable with a line naming its code, recording nothing and running nothing', async (context) => {
		const stand = await standUp(context, {
			administrators: async () => {
				throw Object.assign(new Error('the store is down'), {
					code: 'ECONNREFUSED',
				});
			},
			verifications: ADMIN,
		});

		const answer = await post(stand);

		assert.deepEqual([answer.statusCode, codeOf(answer)], [503, 'storeUnavailable']);
		assert.deepEqual(stand.lines, [
			{
				fields: { code: 'ECONNREFUSED', method: 'POST', route: ROUTE },
				message: STORE_FAILED,
			},
		]);
		assert.deepEqual(stand.recorded, []);
		assert.deepEqual(stand.ran, []);
	});
});

suite('the steps a management operation names to run after its commit', () => {
	test('are run once the operation has answered its change, the answer sent only once they have', async (context) => {
		const release: { steps: (() => void) | undefined } = { steps: undefined };
		const stand = await standUp(context, {
			afterCommit: ['keyReload'],
			runAfterCommit: () =>
				new Promise((resolve) => {
					release.steps = () => {
						resolve();
					};
				}),
			verifications: ADMIN,
		});
		const sent = { answered: false };

		const answering = post(stand).then((answer) => {
			sent.answered = true;
			return answer;
		});
		await turnsUntil(() => release.steps !== undefined);
		const answeredWhileRunning = sent.answered;
		release.steps?.();
		const answer = await answering;

		assert.equal(answeredWhileRunning, false);
		assert.equal(answer.statusCode, 201);
		assert.equal(stand.ran.length, 1);
		assert.deepEqual(stand.afterCommit, [['keyReload']]);
	});

	test('are none for an operation naming none', async (context) => {
		const stand = await standUp(context, { verifications: ADMIN });

		const answer = await post(stand);

		assert.equal(answer.statusCode, 201);
		assert.deepEqual(stand.afterCommit.flat(), []);
	});

	test('are run for a change whose COMMIT went unconfirmed, before it is answered 503 outcomeUnknown', async (context) => {
		const release: { steps: (() => void) | undefined } = { steps: undefined };
		const stand = await standUp(context, {
			afterCommit: ['keyReload'],
			outcome: async () => {
				throw new CommitUnconfirmed();
			},
			runAfterCommit: () =>
				new Promise((resolve) => {
					release.steps = () => {
						resolve();
					};
				}),
			verifications: ADMIN,
		});
		const sent = { answered: false };

		const answering = post(stand).then((answer) => {
			sent.answered = true;
			return answer;
		});
		await turnsUntil(() => release.steps !== undefined);
		const answeredWhileRunning = sent.answered;
		release.steps?.();
		const answer = await answering;

		assert.equal(answeredWhileRunning, false);
		assert.equal(answer.statusCode, 503);
		assert.equal(codeOf(answer), 'outcomeUnknown');
		assert.deepEqual(stand.afterCommit, [['keyReload']]);
		assert.deepEqual(stand.recorded, []);
	});

	test('are never run for a request refused before the operation runs, a refusal it answers, or any failure it throws but an unconfirmed COMMIT', async (context) => {
		const outcomes: readonly (() => Promise<OperationOutcome>)[] = [
			async () => ({ kind: 'refused', problem: SHELF_LIMIT }),
			async () => {
				throw Object.assign(new Error('the store went away'), {
					code: '57P01',
				});
			},
		];
		const stands = await Promise.all(
			outcomes.map((outcome) =>
				standUp(context, {
					afterCommit: ['keyReload'],
					outcome,
					verifications: ADMIN,
				}),
			),
		);
		const unread = stands[0] ?? assert.fail('no stand');

		const answers = [
			await post(unread, { body: '{"title":7}' }),
			...(await Promise.all(stands.map((stand) => post(stand)))),
		];

		assert.deepEqual(
			answers.map(({ statusCode }) => statusCode),
			[400, 409, 503],
		);
		assert.deepEqual(
			stands.map(({ afterCommit }) => afterCommit),
			[[], []],
		);
	});
});

suite('a management operation taking a query, or answering with no content', () => {
	test('gives an operation taking a query its parameters as sent, decoded and in order, beside the principal', async (context) => {
		const read: unknown[] = [];
		const stand = await standUp(context, {
			departures: {
				body: 'none',
				method: 'GET',
				readInput: (_body, { principal, query }) => {
					read.push({ principal, query });
					return { input: { title: 'listed' }, kind: 'read' };
				},
				takesQuery: true,
			},
			verifications: ADMIN,
		});

		const answer = await stand.server.inject({
			headers: { authorization: 'Bearer admin' },
			method: 'GET',
			url: '/admin/shelves/shelf-1/books?limit=2&cursor=a%2Bb&limit=3',
		});

		assert.equal(answer.statusCode, 201);
		assert.deepEqual(read, [
			{
				principal: {
					administrator: true,
					firstUser: false,
					subject: 'subject-ana',
					tokenLifetimeSeconds: 310,
					type: 'human',
				},
				query: [
					['limit', '2'],
					['cursor', 'a+b'],
					['limit', '3'],
				],
			},
		]);
	});

	test('records a refusal its reading of the query answers as denied, with the code answered', async (context) => {
		const stand = await standUp(context, {
			departures: {
				body: 'none',
				method: 'GET',
				readInput: () => ({ kind: 'refused', problem: SHELF_LIMIT }),
				takesQuery: true,
			},
			verifications: ADMIN,
		});

		const answer = await stand.server.inject({
			headers: { authorization: 'Bearer admin' },
			method: 'GET',
			url: '/admin/shelves/shelf-1/books?limit=0',
		});

		assert.equal(answer.statusCode, 409);
		assert.deepEqual(
			stand.recorded.map(({ event }) => event.data['reason']),
			['shelfFull'],
		);
		assert.deepEqual(stand.ran, []);
	});

	test('serves an operation at PATCH, reading its body as a JSON Merge Patch alone, and refusing any other media type 415, recorded denied', async (context) => {
		const stand = await standUp(context, {
			departures: { method: 'PATCH' },
			verifications: ADMIN,
		});
		const patch = (contentType: string) =>
			stand.server.inject({
				headers: {
					authorization: 'Bearer admin',
					'content-type': contentType,
				},
				method: 'PATCH',
				payload: BODY,
				url: '/admin/shelves/shelf-1/books',
			});

		const answers = [await patch('application/merge-patch+json'), await patch('application/json')];

		assert.deepEqual(
			answers.map((answer) => [answer.statusCode, codeOf(answer)]),
			[
				[201, undefined],
				[415, 'unsupportedMediaType'],
			],
		);
		assert.match(String(JSON.parse(answers[1]?.body ?? '{}').detail), /application\/merge-patch\+json/u);
		assert.deepEqual(stand.ran, [{ input: { title: 'Dubliners' }, params: { id: 'shelf-1' } }]);
		assert.deepEqual(
			stand.recorded.map(({ event }) => event.data['reason']),
			['unsupportedMediaType'],
		);
	});

	test('serves an operation at PUT, and answers a success carrying no content with no body and no media type', async (context) => {
		const stand = await standUp(context, {
			departures: {
				body: 'none',
				method: 'PUT',
				readInput: () => ({ input: { title: 'shelved' }, kind: 'read' }),
			},
			outcome: async () => ({
				body: undefined,
				forbidsStoring: false,
				kind: 'answered',
				status: 204,
			}),
			verifications: ADMIN,
		});

		const answer = await stand.server.inject({
			headers: { authorization: 'Bearer admin' },
			method: 'PUT',
			url: '/admin/shelves/shelf-1/books',
		});

		assert.equal(answer.statusCode, 204);
		assert.equal(answer.body, '');
		assert.equal(answer.headers['content-type'], undefined);
		assert.equal(stand.ran.length, 1);
	});
});
