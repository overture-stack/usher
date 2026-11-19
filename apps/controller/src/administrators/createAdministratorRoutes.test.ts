import assert from 'node:assert/strict';
import { suite, test, type TestContext } from 'node:test';

import type { FastifyInstance } from 'fastify';
import pg from 'pg';

import type { AuditEvent } from '../eventLog/index.js';
import { createServer } from '../http/index.js';
import { createAdministratorRoutes } from './createAdministratorRoutes.js';
import type { AdministratorStore, ListedNomination, StoredNomination } from './types.js';

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);

const SECONDS = Math.floor(NOW / 1000);

const ISSUER = 'https://auth.example.org/realms/usher';

const LATEST = '6b1f3c2e-8a4d-4f7b-9c1e-2d3a4b5c6d7e';

const REPLACED = '0c2d4e6f-1a3b-4c5d-8e9f-0a1b2c3d4e5f';

const UNKNOWN = '9e8d7c6b-5a49-4382-b1a0-f9e8d7c6b5a4';

const APPENDED = '3f2e1d0c-9b8a-4766-a554-433221100fed';

/** What the fake store holds for one test. */
interface World {
	/** Whether an administrator has accepted. */
	administratorExists: boolean;

	/** The nominations, by id. */
	nominations: Readonly<Record<string, StoredNomination>>;

	/** Each person Usher has met, by subject, with their `users.id`. */
	people: Readonly<Record<string, string>>;
}

interface Call {
	method: keyof AdministratorStore;
	values: readonly unknown[];
}

interface Stand {
	calls: Call[];

	/** The statements read outside a transaction, with their values. */
	reads: { text: string; values: readonly unknown[] }[];

	recorded: AuditEvent[];
	server: FastifyInstance;

	/** How many transactions the operations began. */
	transactions: { count: number };
}

// Ana is the first user and has met Usher; Bo and Cy have too. Bo holds the latest nomination, and
// an earlier one, both Ana's.
const WORLD: World = {
	administratorExists: false,
	nominations: {
		[LATEST]: {
			id: LATEST,
			latest: true,
			nominatorSubject: 'subject-ana',
			nomineeId: 'person-bo',
		},
		[REPLACED]: {
			id: REPLACED,
			latest: false,
			nominatorSubject: 'subject-ana',
			nomineeId: 'person-bo',
		},
	},
	people: {
		'subject-ana': 'person-ana',
		'subject-bo': 'person-bo',
		'subject-cy': 'person-cy',
	},
};

// The rows a listing reads: Bo's two nominations, the earlier first.
const LISTED: readonly ListedNomination[] = [
	{
		id: REPLACED,
		latest: false,
		nominatedAt: new Date(NOW - 120_000),
		nominatorSubject: 'subject-ana',
	},
	{
		id: LATEST,
		latest: true,
		nominatedAt: new Date(NOW - 60_000),
		nominatorSubject: 'subject-ana',
	},
];

// A store answering from the world given, keeping each call made of it in order.
const fakeStore = (world: World, calls: Call[]): AdministratorStore => {
	const called = (method: keyof AdministratorStore, ...values: unknown[]) => {
		calls.push({ method, values });
	};
	return {
		administratorExists: async () => {
			called('administratorExists');
			return world.administratorExists;
		},
		appendNomination: async (nomination) => {
			called('appendNomination', nomination);
			return { id: APPENDED, nominatedAt: nomination.now };
		},
		findOrRecordPerson: async (subject, now) => {
			called('findOrRecordPerson', subject, now);
			return world.people[subject] ?? `person-new-${subject}`;
		},
		findPerson: async (subject) => {
			called('findPerson', subject);
			return world.people[subject];
		},
		insertAdministrator: async (administrator) => {
			called('insertAdministrator', administrator);
		},
		lockNominations: async () => {
			called('lockNominations');
		},
		readNomination: async (id) => {
			called('readNomination', id);
			return world.nominations[id];
		},
	};
};

const tokenOf = (subject: string, roles: readonly string[], departures: Readonly<Record<string, unknown>> = {}) => ({
	claims: {
		aud: ['usher-management'],
		azp: 'usher-ui',
		exp: SECONDS + 300,
		iat: SECONDS - 10,
		iss: ISSUER,
		realm_access: { roles },
		sub: subject,
		typ: 'Bearer',
		...departures,
	},
	header: { alg: 'RS256', typ: 'JWT' },
	kind: 'verified' as const,
});

// The bearer credential each caller sends, by the caller's name: Ana holds the first-user role, as
// does the service account.
const TOKENS: Readonly<Record<string, ReturnType<typeof tokenOf>>> = {
	ana: tokenOf('subject-ana', ['usher-first-user']),
	bo: tokenOf('subject-bo', []),
	cy: tokenOf('subject-cy', []),
	dee: tokenOf('subject-dee', []),
	service: tokenOf('service-1', ['usher-first-user'], {
		client_id: 'lyric-svc',
	}),
};

const standUp = (context: TestContext, world: Partial<World> = {}): Stand => {
	const known: World = { ...WORLD, ...world };
	const stand = {
		calls: [] as Call[],
		reads: [] as Stand['reads'],
		recorded: [] as AuditEvent[],
		transactions: { count: 0 },
	};
	const server = createServer({
		isLive: () => true,
		isReady: async () => true,
		trustedProxies: [],
	});
	createAdministratorRoutes(
		{
			administratorStoreOf: () => fakeStore(known, stand.calls),
			settings: {
				clock: { now: () => NOW },
				databaseSchema: 'usher',
				identityProviderIssuer: ISSUER,
			},
			store: {
				// A refused acceptance's nomination, by whether one has the id, or a listing's rows.
				query: async <Row extends pg.QueryResultRow>(
					text: string,
					values: readonly unknown[] = [],
				): Promise<pg.QueryResult<Row>> => {
					stand.reads.push({ text, values });
					const rows = text.includes('AS exists')
						? [{ exists: Object.hasOwn(known.nominations, String(values[0])) }]
						: LISTED.filter(() => values[1] === 'subject-bo');
					return { rows } as unknown as pg.QueryResult<Row>;
				},
			},
			trail: {
				inTransaction: async (_actor, work) => {
					stand.transactions.count += 1;
					const recorded: AuditEvent[] = [];
					const result = await work({
						connection: Object.assign(new pg.Client(), {
							release: () => undefined,
						}),
						record: async (event) => {
							recorded.push(event);
							return 'event-id';
						},
					});
					stand.recorded.push(...recorded);
					return result;
				},
			},
		},
		{
			administratorStatus: async () => ({
				administrator: false,
				anyAdministrator: known.administratorExists,
			}),
			eventLog: { error: () => undefined },
			refusals: { refuse: async () => ({ kind: 'counted' }) },
			runAfterCommit: async () => undefined,
			settings: {
				clock: { now: () => NOW },
				firstUser: { realmRole: 'usher-first-user' },
				identityProviderIssuer: ISSUER,
				managementAudience: 'usher-management',
				managementClients: ['usher-ui'],
				serviceAccountRole: 'usher-service-account',
				signInTokenMaximumFor: () => 3600,
			},
			storedRefusal: async () => undefined,
			tokenVerifier: {
				verify: async (token) => TOKENS[token] ?? { kind: 'unverified', reason: 'invalidSignature' },
			},
			trail: {
				recordEvent: async (_actor, event) => {
					stand.recorded.push(event);
					return 'event-id';
				},
			},
		},
	).forEach((route) => {
		server.route(route);
	});
	context.after(() => server.close());
	return { ...stand, server };
};

const send = (
	{ server }: Stand,
	caller: string,
	{ body, method, url }: { body?: unknown; method: 'GET' | 'POST'; url: string },
) =>
	server.inject({
		headers: {
			authorization: `Bearer ${caller}`,
			...(body === undefined ? {} : { 'content-type': 'application/json' }),
		},
		method,
		url,
		...(body === undefined ? {} : { payload: JSON.stringify(body) }),
	});

const nominate = (stand: Stand, caller: string, subject: string) =>
	send(stand, caller, {
		body: { nominee: { subject } },
		method: 'POST',
		url: '/admin/nominations',
	});

const accept = (stand: Stand, caller: string, id: string) =>
	send(stand, caller, {
		method: 'POST',
		url: `/admin/nominations/${id}/acceptance`,
	});

const outcomeOf = (answer: { body: string; statusCode: number }): readonly unknown[] => [
	answer.statusCode,
	Reflect.get(Object(JSON.parse(answer.body)), 'code'),
];

const methodsOf = (stand: Stand): readonly string[] => stand.calls.map(({ method }) => method);

const eventsOf = (stand: Stand): readonly unknown[] =>
	stand.recorded.map(({ data, severity, type }) => ({
		data,
		severity,
		type,
	}));

const INSTANT = new Date(NOW).toISOString();

suite("nominating Usher's first administrator", () => {
	test('nominates a person Usher has met, its nominator the first user, recorded on first meeting, answering 201 and recording admin.nomination at warning', async (context) => {
		const stand = standUp(context, {
			people: { 'subject-bo': 'person-bo' },
		});

		const answer = await nominate(stand, 'ana', 'subject-bo');

		assert.equal(answer.statusCode, 201);
		assert.deepEqual(JSON.parse(answer.body), {
			id: APPENDED,
			nominatedAt: INSTANT,
			nominatedBy: { subject: 'subject-ana' },
			nominee: { subject: 'subject-bo' },
		});
		assert.deepEqual(stand.calls, [
			{ method: 'lockNominations', values: [] },
			{ method: 'administratorExists', values: [] },
			{ method: 'findPerson', values: ['subject-bo'] },
			{
				method: 'findOrRecordPerson',
				values: ['subject-ana', new Date(NOW)],
			},
			{
				method: 'appendNomination',
				values: [
					{
						nominatedBy: 'person-new-subject-ana',
						nomineeId: 'person-bo',
						now: new Date(NOW),
					},
				],
			},
		]);
		assert.deepEqual(eventsOf(stand), [
			{
				data: {
					nominationId: APPENDED,
					nomineeId: 'subject-bo',
					result: 'succeeded',
					sourceIp: '127.0.0.1',
				},
				severity: 'warning',
				type: 'admin.nomination',
			},
		]);
	});

	test('nominates the first user themself, never met before, as nominee and nominator alike', async (context) => {
		const stand = standUp(context, { people: {} });

		const answer = await nominate(stand, 'ana', 'subject-ana');

		assert.equal(answer.statusCode, 201);
		assert.deepEqual(methodsOf(stand), [
			'lockNominations',
			'administratorExists',
			'findOrRecordPerson',
			'appendNomination',
		]);
		assert.deepEqual(stand.calls.at(-1)?.values, [
			{
				nominatedBy: 'person-new-subject-ana',
				nomineeId: 'person-new-subject-ana',
				now: new Date(NOW),
			},
		]);
	});

	test('refuses a caller whose token lacks the first-user role 403 notFirstUser before reading the body or beginning a transaction, recording it denied', async (context) => {
		const stand = standUp(context);

		const answers = [
			await nominate(stand, 'bo', 'subject-bo'),
			await send(stand, 'cy', {
				body: { nominee: 'subject-cy' },
				method: 'POST',
				url: '/admin/nominations',
			}),
		];

		assert.deepEqual(answers.map(outcomeOf), [
			[403, 'notFirstUser'],
			[403, 'notFirstUser'],
		]);
		assert.equal(stand.transactions.count, 0);
		assert.deepEqual(
			stand.recorded.map(({ data }) => data),
			[
				{ reason: 'notFirstUser', result: 'denied', sourceIp: '127.0.0.1' },
				{ reason: 'notFirstUser', result: 'denied', sourceIp: '127.0.0.1' },
			],
		);
	});

	test('refuses an administrator already accepted 409 firstAdministratorAccepted before looking the nominee up', async (context) => {
		const stand = standUp(context, { administratorExists: true });

		const answer = await nominate(stand, 'ana', 'subject-unknown');

		assert.deepEqual(outcomeOf(answer), [409, 'firstAdministratorAccepted']);
		assert.deepEqual(methodsOf(stand), ['lockNominations', 'administratorExists']);
		assert.deepEqual(stand.recorded.at(-1)?.data, {
			reason: 'firstAdministratorAccepted',
			result: 'denied',
			sourceIp: '127.0.0.1',
		});
	});

	test('refuses a nominee who is neither the caller nor a person Usher has met 404 nomineeNotFound, appending nothing', async (context) => {
		const stand = standUp(context);

		const answers = [await nominate(stand, 'ana', 'subject-unknown'), await nominate(stand, 'ana', '')];

		assert.deepEqual(answers.map(outcomeOf), [
			[404, 'nomineeNotFound'],
			[404, 'nomineeNotFound'],
		]);
		assert.equal(methodsOf(stand).includes('appendNomination'), false);
	});

	test('refuses a service account 403 serviceAccountNotPermitted, the first-user role notwithstanding', async (context) => {
		const stand = standUp(context);

		const answer = await nominate(stand, 'service', 'subject-bo');

		assert.deepEqual(outcomeOf(answer), [403, 'serviceAccountNotPermitted']);
		assert.equal(stand.transactions.count, 0);
	});

	test("refuses the first user's body it cannot read 400 unreadableBody, beginning no transaction", async (context) => {
		const stand = standUp(context);

		const answer = await send(stand, 'ana', {
			body: { nominee: { email: 'bo@example.org' } },
			method: 'POST',
			url: '/admin/nominations',
		});

		assert.deepEqual(outcomeOf(answer), [400, 'unreadableBody']);
		assert.equal(stand.transactions.count, 0);
	});
});

suite("accepting a nomination as Usher's first administrator", () => {
	test('accepts the latest nomination naming the caller, writing them as the administrator, answering 200 and recording admin.acceptance at critical', async (context) => {
		const stand = standUp(context);

		const answer = await accept(stand, 'bo', LATEST);

		assert.equal(answer.statusCode, 200);
		assert.deepEqual(JSON.parse(answer.body), {
			acceptedAt: INSTANT,
			administrator: { subject: 'subject-bo' },
			nominationId: LATEST,
		});
		assert.deepEqual(stand.calls, [
			{ method: 'lockNominations', values: [] },
			{ method: 'findPerson', values: ['subject-bo'] },
			{ method: 'readNomination', values: [LATEST] },
			{ method: 'administratorExists', values: [] },
			{
				method: 'insertAdministrator',
				values: [
					{
						acceptedAt: new Date(NOW),
						nominationId: LATEST,
						userId: 'person-bo',
					},
				],
			},
		]);
		assert.deepEqual(eventsOf(stand), [
			{
				data: {
					nominatedById: 'subject-ana',
					nominationId: LATEST,
					result: 'succeeded',
					sourceIp: '127.0.0.1',
				},
				severity: 'critical',
				type: 'admin.acceptance',
			},
		]);
	});

	test('answers a malformed id, an id naming no nomination, a nomination naming someone else, and a caller never met 404 nominationNotFound alike, writing nothing', async (context) => {
		const stand = standUp(context);

		const answers = [
			await accept(stand, 'bo', 'not-a-nomination'),
			await accept(stand, 'bo', UNKNOWN),
			await accept(stand, 'cy', LATEST),
			await accept(stand, 'dee', LATEST),
		];

		assert.deepEqual(answers.map(outcomeOf), [
			[404, 'nominationNotFound'],
			[404, 'nominationNotFound'],
			[404, 'nominationNotFound'],
			[404, 'nominationNotFound'],
		]);
		assert.equal(stand.transactions.count, 3);
		assert.equal(methodsOf(stand).includes('insertAdministrator'), false);
		assert.deepEqual(
			stand.recorded.map(({ data }) => data['nominationId']),
			[undefined, undefined, LATEST, LATEST],
		);
	});

	test('refuses an acceptance once an administrator has accepted 409 firstAdministratorAccepted, ahead of a nomination a later one replaced', async (context) => {
		const stand = standUp(context, { administratorExists: true });

		const answers = [await accept(stand, 'bo', LATEST), await accept(stand, 'bo', REPLACED)];

		assert.deepEqual(answers.map(outcomeOf), [
			[409, 'firstAdministratorAccepted'],
			[409, 'firstAdministratorAccepted'],
		]);
		assert.equal(methodsOf(stand).includes('insertAdministrator'), false);
	});

	test('refuses a nomination a later one replaced 409 nominationSuperseded, only the latest being acceptable', async (context) => {
		const stand = standUp(context);

		const answer = await accept(stand, 'bo', REPLACED);

		assert.deepEqual(outcomeOf(answer), [409, 'nominationSuperseded']);
		assert.equal(methodsOf(stand).includes('insertAdministrator'), false);
		assert.deepEqual(stand.recorded.at(-1)?.data, {
			nominationId: REPLACED,
			reason: 'nominationSuperseded',
			result: 'denied',
			sourceIp: '127.0.0.1',
		});
	});
});

suite("a nominee's own nominations", () => {
	test('lists the nominations naming the caller, oldest first, each with its nominator by subject, its instant and whether it is the latest, recording nothing', async (context) => {
		const stand = standUp(context);

		const answer = await send(stand, 'bo', {
			method: 'GET',
			url: '/admin/me/nominations',
		});

		assert.equal(answer.statusCode, 200);
		assert.deepEqual(JSON.parse(answer.body), {
			nominations: [
				{
					id: REPLACED,
					latest: false,
					nominatedAt: new Date(NOW - 120_000).toISOString(),
					nominatedBy: { subject: 'subject-ana' },
				},
				{
					id: LATEST,
					latest: true,
					nominatedAt: new Date(NOW - 60_000).toISOString(),
					nominatedBy: { subject: 'subject-ana' },
				},
			],
		});
		assert.deepEqual(
			stand.reads.map(({ values }) => values),
			[[ISSUER, 'subject-bo']],
		);
		assert.deepEqual(stand.recorded, []);
		assert.equal(stand.transactions.count, 0);
	});

	test('answers a caller named by no nomination an empty list, before and after an administrator has accepted', async (context) => {
		const before = standUp(context);
		const after = standUp(context, { administratorExists: true });

		const answers = [
			await send(before, 'cy', { method: 'GET', url: '/admin/me/nominations' }),
			await send(after, 'cy', { method: 'GET', url: '/admin/me/nominations' }),
		];

		assert.deepEqual(
			answers.map((answer) => [answer.statusCode, JSON.parse(answer.body)]),
			[
				[200, { nominations: [] }],
				[200, { nominations: [] }],
			],
		);
	});
});
