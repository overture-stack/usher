import assert from 'node:assert/strict';
import { suite, test, type TestContext } from 'node:test';

import type { FastifyInstance } from 'fastify';
import pg from 'pg';

import type { AccountReading } from '../directory/index.js';
import type { AuditEvent, TransactionOptions } from '../eventLog/index.js';
import { createServer } from '../http/index.js';
import { createAdministratorRoutes } from './createAdministratorRoutes.js';
import type { AdministratorStore, ListedNomination, NominationRecord, StoredNomination } from './types.js';

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);

const SECONDS = Math.floor(NOW / 1000);

const ISSUER = 'https://auth.example.org/realms/usher';

const LATEST = '6b1f3c2e-8a4d-4f7b-9c1e-2d3a4b5c6d7e';

const REPLACED = '0c2d4e6f-1a3b-4c5d-8e9f-0a1b2c3d4e5f';

const DECLINED = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';

const REVOKED = '7d8e9f0a-1b2c-4d3e-9f4a-5b6c7d8e9f0a';

const BY_ANOTHER = '2e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b';

const UNKNOWN = '9e8d7c6b-5a49-4382-b1a0-f9e8d7c6b5a4';

const APPENDED = '3f2e1d0c-9b8a-4766-a554-433221100fed';

const ACCEPTED_BY_ANA = '4c5d6e7f-8a9b-4c0d-9e1f-2a3b4c5d6e7f';

const ACCEPTED_BY_CY = '8b9c0d1e-2f3a-4b5c-8d6e-7f8a9b0c1d2e';

// Ana accepted first, long before Cy; each is a live administrator unless a test removes them.
const ANA_ADMINISTERS_SINCE: AdministratorEntry = {
	acceptedAt: new Date(Date.UTC(2026, 9, 1, 12, 0, 0)),
	nominationId: ACCEPTED_BY_ANA,
	userId: 'person-ana',
};

const CY_ADMINISTERS_SINCE: AdministratorEntry = {
	acceptedAt: new Date(Date.UTC(2026, 10, 1, 12, 0, 0)),
	nominationId: ACCEPTED_BY_CY,
	userId: 'person-cy',
};

/** What the directory answers, when configured. */
type DirectoryState = 'answering' | 'unavailable' | 'unconfigured';

/** An administrator as the fake store holds one: the nomination accepted, the person, and when. */
interface AdministratorEntry {
	acceptedAt: Date;
	nominationId: string;
	userId: string;
}

/** What the fake store and the fake directory hold for one test. */
interface World {
	/** The accounts the directory holds, by subject, when it answers. */
	accounts: Readonly<Record<string, AccountReading>>;

	/** The live administrators, by subject: a removed administrator is not among them. */
	administrators: Record<string, AdministratorEntry>;

	/**
	 * Subjects the gate admitted as administrators whose status the store no longer holds by the time a
	 * change runs in its transaction, as a removal committed between the two would leave them.
	 */
	withdrawn: readonly string[];

	/** Whether the directory answers, cannot answer, or is not configured. */
	directory: DirectoryState;

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

	/** Each subject the directory was asked for. */
	lookups: string[];

	/** The statements read outside a transaction, with their values. */
	reads: { text: string; values: readonly unknown[] }[];

	recorded: AuditEvent[];
	server: FastifyInstance;

	/** How many transactions the operations began, and the options each was begun with. */
	transactions: { count: number; options: (TransactionOptions | undefined)[] };
}

// Ana is the first user and has met Usher; Bo, Cy and Dee are subjects Ana may name. Bo holds the
// latest nomination, and the others: one replaced, one declined, one revoked, and one Cy made.
const BY_ANA = {
	nominatorSubject: 'subject-ana',
	nomineeSubject: 'subject-bo',
	nomineeUserId: 'person-bo',
};

const WORLD: World = {
	accounts: {
		'subject-dee': { account: { email: 'dee@example.org', familyName: null, givenName: null }, kind: 'held' },
	},
	administrators: {},
	directory: 'answering',
	withdrawn: [],
	nominations: {
		[LATEST]: {
			id: LATEST,
			...BY_ANA,
			decidedAt: null,
			nominatedAt: new Date(NOW - 60_000),
			revokedAt: null,
			state: 'pending',
		},
		[REPLACED]: {
			id: REPLACED,
			...BY_ANA,
			decidedAt: null,
			nominatedAt: new Date(NOW - 120_000),
			revokedAt: null,
			state: 'replaced',
		},
		[DECLINED]: {
			id: DECLINED,
			...BY_ANA,
			decidedAt: new Date(NOW - 90_000),
			nominatedAt: new Date(NOW - 100_000),
			revokedAt: null,
			state: 'declined',
		},
		[REVOKED]: {
			id: REVOKED,
			...BY_ANA,
			decidedAt: null,
			nominatedAt: new Date(NOW - 80_000),
			revokedAt: new Date(NOW - 70_000),
			state: 'revoked',
		},
		[BY_ANOTHER]: {
			id: BY_ANOTHER,
			decidedAt: null,
			nominatedAt: new Date(NOW - 30_000),
			nominatorSubject: 'subject-cy',
			nomineeSubject: 'subject-bo',
			nomineeUserId: 'person-bo',
			revokedAt: null,
			state: 'pending',
		},
	},
	people: {
		'subject-ana': 'person-ana',
		'subject-bo': 'person-bo',
		'subject-cy': 'person-cy',
	},
};

// The rows a nominee's listing reads: Bo's nominations, the earlier first.
const LISTED: readonly ListedNomination[] = [
	{
		id: REPLACED,
		nominatedAt: new Date(NOW - 120_000),
		nominatorSubject: 'subject-ana',
		state: 'replaced',
	},
	{
		id: LATEST,
		nominatedAt: new Date(NOW - 60_000),
		nominatorSubject: 'subject-ana',
		state: 'pending',
	},
];

// The rows the first user's listing reads: every nomination, the earlier first.
const EVERY: readonly NominationRecord[] = [
	{
		decidedAt: null,
		id: REPLACED,
		nominatedAt: new Date(NOW - 120_000),
		nominatorSubject: 'subject-ana',
		nomineeSubject: 'subject-bo',
		revokedAt: null,
		state: 'replaced',
	},
	{
		decidedAt: new Date(NOW - 90_000),
		id: DECLINED,
		nominatedAt: new Date(NOW - 100_000),
		nominatorSubject: 'subject-ana',
		nomineeSubject: 'subject-bo',
		revokedAt: null,
		state: 'declined',
	},
	{
		decidedAt: null,
		id: LATEST,
		nominatedAt: new Date(NOW - 60_000),
		nominatorSubject: 'subject-ana',
		nomineeSubject: 'subject-bo',
		revokedAt: null,
		state: 'pending',
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
			return Object.keys(world.administrators).length > 0;
		},
		countAdministrators: async () => {
			called('countAdministrators');
			return Object.keys(world.administrators).length;
		},
		isAdministrator: async (subject) => {
			called('isAdministrator', subject);
			return Object.hasOwn(world.administrators, subject) && !world.withdrawn.includes(subject);
		},
		pendingNominationOf: async (nomineeUserId) => {
			called('pendingNominationOf', nomineeUserId);
			return Object.values(world.nominations).find(
				(nomination) => nomination.nomineeUserId === nomineeUserId && nomination.state === 'pending',
			)?.id;
		},
		pendingNominationsBy: async (userId) => {
			called('pendingNominationsBy', userId);
			return Object.values(world.nominations)
				.filter(
					(nomination) =>
						nomination.state === 'pending' && world.people[nomination.nominatorSubject] === userId,
				)
				.map(({ id, nomineeSubject }) => ({ id, nomineeSubject }));
		},
		readAdministrator: async (subject) => {
			called('readAdministrator', subject);
			const entry = world.administrators[subject];
			return entry === undefined ? undefined : { nominationId: entry.nominationId, userId: entry.userId };
		},
		removeAdministrator: async (removal) => {
			called('removeAdministrator', removal);
			for (const [subject, entry] of Object.entries(world.administrators)) {
				if (entry.nominationId === removal.nominationId) {
					delete world.administrators[subject];
				}
			}
		},
		appendNomination: async (nomination) => {
			called('appendNomination', nomination);
			return { id: APPENDED, nominatedAt: nomination.now };
		},
		declineNomination: async (decline) => {
			called('declineNomination', decline);
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
		lockAdministrators: async () => {
			called('lockAdministrators');
		},
		readNomination: async (id) => {
			called('readNomination', id);
			return world.nominations[id];
		},
		revokeNomination: async (revocation) => {
			called('revokeNomination', revocation);
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
	const known: World = { ...WORLD, ...world, administrators: { ...(world.administrators ?? WORLD.administrators) } };
	const stand = {
		calls: [] as Call[],
		lookups: [] as string[],
		reads: [] as Stand['reads'],
		recorded: [] as AuditEvent[],
		transactions: { count: 0, options: [] as (TransactionOptions | undefined)[] },
	};
	const server = createServer({
		isLive: () => true,
		isReady: async () => true,
		trustedProxies: [],
	});
	createAdministratorRoutes(
		{
			administratorStoreOf: () => fakeStore(known, stand.calls),
			directory: {
				accountOf: async (subject) => {
					stand.lookups.push(subject);
					return known.directory === 'answering'
						? (known.accounts[subject] ?? { kind: 'absent' })
						: { kind: known.directory };
				},
			},
			settings: {
				clock: { now: () => NOW },
				databaseSchema: 'usher',
				identityProviderIssuer: ISSUER,
			},
			store: {
				// Each read by its alias: whether an administrator exists, whether a person is met, a refused
				// answer's nomination by whether one has the id, the first user's listing, or a nominee's rows.
				query: async <Row extends pg.QueryResultRow>(
					text: string,
					values: readonly unknown[] = [],
				): Promise<pg.QueryResult<Row>> => {
					stand.reads.push({ text, values });
					const rows: readonly unknown[] = text.includes('AS "acceptedAt"')
						? Object.entries(known.administrators)
								.map(([subject, entry]) => ({
									acceptedAt: entry.acceptedAt,
									nominationId: entry.nominationId,
									subject,
								}))
								.sort((earlier, later) => earlier.acceptedAt.getTime() - later.acceptedAt.getTime())
						: text.includes('AS "administratorExists"')
							? [{ administratorExists: Object.keys(known.administrators).length > 0 }]
							: text.includes('AS met')
								? [{ met: Object.hasOwn(known.people, String(values[1])) }]
								: text.includes('AS exists')
									? [{ exists: Object.hasOwn(known.nominations, String(values[0])) }]
									: text.includes('"nomineeSubject"')
										? EVERY
										: LISTED.filter(() => values[1] === 'subject-bo');
					return { rows } as unknown as pg.QueryResult<Row>;
				},
			},
			trail: {
				inTransaction: async (_actor, work, options?: TransactionOptions) => {
					stand.transactions.count += 1;
					stand.transactions.options.push(options);
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
			administratorStatus: async ({ subject }) => ({
				administrator: Object.hasOwn(known.administrators, subject),
				anyAdministrator: Object.keys(known.administrators).length > 0,
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
	{ body, method, url }: { body?: unknown; method: 'DELETE' | 'GET' | 'POST'; url: string },
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

const decide = (stand: Stand, caller: string, id: string, decision: unknown) =>
	send(stand, caller, {
		body: { decision },
		method: 'POST',
		url: `/admin/nominations/${id}/decisions`,
	});

const revoke = (stand: Stand, caller: string, id: string) =>
	send(stand, caller, {
		method: 'DELETE',
		url: `/admin/nominations/${id}`,
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

const LATEST_AT = new Date(NOW - 60_000).toISOString();

const REPLACED_AT = new Date(NOW - 120_000).toISOString();

const DECLINED_AT = new Date(NOW - 100_000).toISOString();

suite("nominating Usher's first administrator", () => {
	test('nominates a person Usher has met, its nominator the first user, recorded on first meeting, answering 201 pending and recording admin.nomination at warning', async (context) => {
		const stand = standUp(context);

		const answer = await nominate(stand, 'ana', 'subject-bo');

		assert.equal(answer.statusCode, 201);
		assert.deepEqual(JSON.parse(answer.body), {
			id: APPENDED,
			nominatedAt: INSTANT,
			nominatedBy: { subject: 'subject-ana' },
			nominee: { subject: 'subject-bo' },
			state: 'pending',
		});
		assert.deepEqual(stand.calls, [
			{ method: 'lockAdministrators', values: [] },
			{ method: 'administratorExists', values: [] },
			{
				method: 'findOrRecordPerson',
				values: ['subject-bo', new Date(NOW)],
			},
			{
				method: 'findOrRecordPerson',
				values: ['subject-ana', new Date(NOW)],
			},
			{
				method: 'appendNomination',
				values: [
					{
						nominatedBy: 'person-ana',
						nomineeUserId: 'person-bo',
						now: new Date(NOW),
					},
				],
			},
		]);
		assert.deepEqual(stand.lookups, []);
		assert.deepEqual(eventsOf(stand), [
			{
				data: {
					nominationId: APPENDED,
					nomineeSubject: 'subject-bo',
					result: 'succeeded',
					sourceIp: '127.0.0.1',
				},
				severity: 'warning',
				type: 'admin.nomination',
			},
		]);
	});

	test('nominates the first user themself, never met before, as nominee and nominator alike, without asking the directory', async (context) => {
		const stand = standUp(context, { people: {} });

		const answer = await nominate(stand, 'ana', 'subject-ana');

		assert.equal(answer.statusCode, 201);
		assert.deepEqual(methodsOf(stand), [
			'lockAdministrators',
			'administratorExists',
			'findOrRecordPerson',
			'appendNomination',
		]);
		assert.deepEqual(stand.calls.at(-1)?.values, [
			{
				nominatedBy: 'person-new-subject-ana',
				nomineeUserId: 'person-new-subject-ana',
				now: new Date(NOW),
			},
		]);
		assert.deepEqual(stand.lookups, []);
	});

	test('nominates an account the directory finds in the trusted realm, recording the nominee on the finding, after the directory answers outside the lock', async (context) => {
		const stand = standUp(context, { people: {} });

		const answer = await nominate(stand, 'ana', 'subject-dee');

		assert.equal(answer.statusCode, 201);
		assert.deepEqual(stand.lookups, ['subject-dee']);
		assert.deepEqual(methodsOf(stand), [
			'lockAdministrators',
			'administratorExists',
			'findOrRecordPerson',
			'findOrRecordPerson',
			'appendNomination',
		]);
		assert.deepEqual(stand.calls.at(-1)?.values, [
			{
				nominatedBy: 'person-new-subject-ana',
				nomineeUserId: 'person-new-subject-dee',
				now: new Date(NOW),
			},
		]);
	});

	test('refuses a nominee the directory finds no account for 404 nomineeNotFound, its detail naming the trusted realm, appending nothing, and records the refusal', async (context) => {
		const stand = standUp(context);

		const answer = await nominate(stand, 'ana', 'subject-unknown');

		assert.deepEqual(outcomeOf(answer), [404, 'nomineeNotFound']);
		assert.equal(
			Reflect.get(Object(JSON.parse(answer.body)), 'detail'),
			`No account in the realm Usher trusts, ${ISSUER}, has this subject. Name the nominee by their user ID in that realm.`,
		);
		assert.deepEqual(stand.lookups, ['subject-unknown']);
		assert.equal(stand.transactions.count, 0);
		assert.deepEqual(stand.recorded.at(-1)?.data, {
			nomineeSubject: 'subject-unknown',
			reason: 'nomineeNotFound',
			result: 'denied',
			sourceIp: '127.0.0.1',
		});
	});

	test('refuses a nominee with no directory configured 404 nomineeNotFound, its detail saying only the first user or a person Usher has met can be nominated', async (context) => {
		const stand = standUp(context, { directory: 'unconfigured' });

		const answer = await nominate(stand, 'ana', 'subject-unknown');

		assert.deepEqual(outcomeOf(answer), [404, 'nomineeNotFound']);
		assert.equal(
			Reflect.get(Object(JSON.parse(answer.body)), 'detail'),
			'No directory is configured, so only the first user or a person Usher has met can be nominated until one is configured.',
		);
		assert.equal(stand.transactions.count, 0);
	});

	test('answers 503 directoryUnavailable while the directory cannot answer for a nominee not yet met, beginning no transaction and recording it failed at error', async (context) => {
		const stand = standUp(context, { directory: 'unavailable' });

		const answer = await nominate(stand, 'ana', 'subject-unknown');

		assert.deepEqual(outcomeOf(answer), [503, 'directoryUnavailable']);
		assert.equal(stand.transactions.count, 0);
		assert.deepEqual(eventsOf(stand), [
			{
				data: {
					nomineeSubject: 'subject-unknown',
					reason: 'directoryUnavailable',
					result: 'failed',
					sourceIp: '127.0.0.1',
				},
				severity: 'error',
				type: 'admin.nomination',
			},
		]);
	});

	test('answers a nominee already met without asking the directory, even while it cannot answer', async (context) => {
		const stand = standUp(context, { directory: 'unavailable' });

		const answer = await nominate(stand, 'ana', 'subject-bo');

		assert.equal(answer.statusCode, 201);
		assert.deepEqual(stand.lookups, []);
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

	test('refuses a first user who is no administrator once one has accepted 403 administratorOnly, before looking the nominee up or beginning a transaction', async (context) => {
		const stand = standUp(context, { administrators: { 'subject-cy': CY_ADMINISTERS_SINCE } });

		const answer = await nominate(stand, 'ana', 'subject-unknown');

		assert.deepEqual(outcomeOf(answer), [403, 'administratorOnly']);
		assert.deepEqual(stand.lookups, []);
		assert.equal(stand.transactions.count, 0);
		assert.deepEqual(stand.recorded.at(-1)?.data, {
			reason: 'administratorOnly',
			result: 'denied',
			sourceIp: '127.0.0.1',
		});
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

suite('nominees answering their nomination', () => {
	test('accepts the latest nomination naming the caller, writing them as the administrator, answering 200 with the nomination accepted and recording admin.nominationDecision at critical', async (context) => {
		const stand = standUp(context);

		const answer = await decide(stand, 'bo', LATEST, 'accept');

		assert.equal(answer.statusCode, 200);
		assert.deepEqual(JSON.parse(answer.body), {
			decidedAt: INSTANT,
			id: LATEST,
			nominatedAt: LATEST_AT,
			nominatedBy: { subject: 'subject-ana' },
			nominee: { subject: 'subject-bo' },
			state: 'accepted',
		});
		assert.deepEqual(stand.calls, [
			{ method: 'lockAdministrators', values: [] },
			{ method: 'readNomination', values: [LATEST] },
			{ method: 'findPerson', values: ['subject-bo'] },
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
					decision: 'accepted',
					nominatedBySubject: 'subject-ana',
					nominationId: LATEST,
					result: 'succeeded',
					sourceIp: '127.0.0.1',
				},
				severity: 'critical',
				type: 'admin.nominationDecision',
			},
		]);
	});

	test('declines the pending nomination naming the caller, recording the decline, answering 200 with the nomination declined and recording admin.nominationDecision at warning', async (context) => {
		const stand = standUp(context);

		const answer = await decide(stand, 'bo', LATEST, 'decline');

		assert.equal(answer.statusCode, 200);
		assert.deepEqual(JSON.parse(answer.body), {
			decidedAt: INSTANT,
			id: LATEST,
			nominatedAt: LATEST_AT,
			nominatedBy: { subject: 'subject-ana' },
			nominee: { subject: 'subject-bo' },
			state: 'declined',
		});
		assert.deepEqual(stand.calls.at(-1), {
			method: 'declineNomination',
			values: [{ nominationId: LATEST, now: new Date(NOW) }],
		});
		assert.equal(methodsOf(stand).includes('insertAdministrator'), false);
		assert.deepEqual(eventsOf(stand), [
			{
				data: {
					decision: 'declined',
					nominatedBySubject: 'subject-ana',
					nominationId: LATEST,
					result: 'succeeded',
					sourceIp: '127.0.0.1',
				},
				severity: 'warning',
				type: 'admin.nominationDecision',
			},
		]);
	});

	test('answers a malformed id 404 nominationNotFound with the reason malformedNominationId, beginning no transaction and recording no id', async (context) => {
		const stand = standUp(context);

		const answer = await decide(stand, 'bo', 'not-a-nomination', 'accept');

		assert.deepEqual(outcomeOf(answer), [404, 'nominationNotFound']);
		assert.equal(stand.transactions.count, 0);
		assert.deepEqual(
			stand.recorded.map(({ data }) => data),
			[
				{
					reason: 'malformedNominationId',
					result: 'denied',
					sourceIp: '127.0.0.1',
				},
			],
		);
	});

	test('answers an id naming no nomination 404 nominationNotFound with the reason unknownNominationId, recording no id', async (context) => {
		const stand = standUp(context);

		const answer = await decide(stand, 'bo', UNKNOWN, 'accept');

		assert.deepEqual(outcomeOf(answer), [404, 'nominationNotFound']);
		assert.deepEqual(
			stand.recorded.map(({ data }) => data),
			[
				{
					reason: 'unknownNominationId',
					result: 'denied',
					sourceIp: '127.0.0.1',
				},
			],
		);
	});

	test('answers a nomination naming someone else, or a caller never met, 404 nominationNotFound with the reason nominationForSomeoneElse, recording the id it names', async (context) => {
		const stand = standUp(context);

		const answers = [await decide(stand, 'cy', LATEST, 'accept'), await decide(stand, 'dee', LATEST, 'accept')];

		assert.deepEqual(answers.map(outcomeOf), [
			[404, 'nominationNotFound'],
			[404, 'nominationNotFound'],
		]);
		assert.deepEqual(
			stand.recorded.map(({ data }) => data),
			[
				{
					nominationId: LATEST,
					reason: 'nominationForSomeoneElse',
					result: 'denied',
					sourceIp: '127.0.0.1',
				},
				{
					nominationId: LATEST,
					reason: 'nominationForSomeoneElse',
					result: 'denied',
					sourceIp: '127.0.0.1',
				},
			],
		);
		assert.equal(methodsOf(stand).includes('insertAdministrator'), false);
		assert.equal(methodsOf(stand).includes('declineNomination'), false);
	});

	test('answers a pending nomination after an administrator has accepted, the nominee accepting it as before', async (context) => {
		const stand = standUp(context, { administrators: { 'subject-cy': CY_ADMINISTERS_SINCE } });

		const answer = await decide(stand, 'bo', LATEST, 'accept');

		assert.deepEqual(outcomeOf(answer), [200, undefined]);
		assert.equal(methodsOf(stand).includes('insertAdministrator'), true);
	});

	test('refuses an answer to a nomination a later one replaced 409 nominationReplaced, writing nothing', async (context) => {
		const stand = standUp(context);

		const answer = await decide(stand, 'bo', REPLACED, 'accept');

		assert.deepEqual(outcomeOf(answer), [409, 'nominationReplaced']);
		assert.equal(methodsOf(stand).includes('insertAdministrator'), false);
		assert.deepEqual(stand.recorded.at(-1)?.data, {
			nominationId: REPLACED,
			reason: 'nominationReplaced',
			result: 'denied',
			sourceIp: '127.0.0.1',
		});
	});

	test('refuses an answer to a nomination already declined 409 nominationAlreadyDecided, and one revoked 409 nominationRevoked', async (context) => {
		const stand = standUp(context);

		const answers = [await decide(stand, 'bo', DECLINED, 'accept'), await decide(stand, 'bo', REVOKED, 'decline')];

		assert.deepEqual(answers.map(outcomeOf), [
			[409, 'nominationAlreadyDecided'],
			[409, 'nominationRevoked'],
		]);
		assert.deepEqual(
			stand.recorded.map(({ data }) => data['reason']),
			['nominationAlreadyDecided', 'nominationRevoked'],
		);
	});

	test('refuses a decision other than accept or decline 422 unknownDecision, a body holding another member 400, and a body without one 400', async (context) => {
		const stand = standUp(context);

		const answers = [
			await decide(stand, 'bo', LATEST, 'approve'),
			await send(stand, 'bo', {
				body: { decision: 'accept', note: 'yes' },
				method: 'POST',
				url: `/admin/nominations/${LATEST}/decisions`,
			}),
			await send(stand, 'bo', { body: {}, method: 'POST', url: `/admin/nominations/${LATEST}/decisions` }),
			await decide(stand, 'bo', LATEST, 1),
		];

		assert.deepEqual(answers.map(outcomeOf), [
			[422, 'unknownDecision'],
			[400, 'unreadableBody'],
			[400, 'unreadableBody'],
			[400, 'unreadableBody'],
		]);
		assert.equal(answers[0]?.body.includes('decision is accept or decline.'), true);
		assert.equal(stand.transactions.count, 0);
	});
});

suite('revoking a nomination as the first user', () => {
	test('revokes the pending nomination the first user made, answering 200 with the nomination revoked and recording admin.nominationRevocation at warning', async (context) => {
		const stand = standUp(context);

		const answer = await revoke(stand, 'ana', LATEST);

		assert.equal(answer.statusCode, 200);
		assert.deepEqual(JSON.parse(answer.body), {
			id: LATEST,
			nominatedAt: LATEST_AT,
			nominatedBy: { subject: 'subject-ana' },
			nominee: { subject: 'subject-bo' },
			revokedAt: INSTANT,
			state: 'revoked',
		});
		assert.deepEqual(stand.calls.at(-1), {
			method: 'revokeNomination',
			values: [{ nominationId: LATEST, now: new Date(NOW) }],
		});
		assert.deepEqual(eventsOf(stand), [
			{
				data: {
					nomineeSubject: 'subject-bo',
					nominationId: LATEST,
					result: 'succeeded',
					sourceIp: '127.0.0.1',
				},
				severity: 'warning',
				type: 'admin.nominationRevocation',
			},
		]);
	});

	test('refuses everyone but the first user 403 notFirstUser before any lookup, beginning no transaction', async (context) => {
		const stand = standUp(context);

		const answers = [await revoke(stand, 'bo', LATEST), await revoke(stand, 'service', LATEST)];

		assert.deepEqual(answers.map(outcomeOf), [
			[403, 'notFirstUser'],
			[403, 'serviceAccountNotPermitted'],
		]);
		assert.equal(stand.transactions.count, 0);
	});

	test('answers a malformed id and an id naming no nomination 404 nominationNotFound, recording each reason, and a nomination the first user did not make 404 with the reason nominationBySomeoneElse', async (context) => {
		const stand = standUp(context);

		const answers = [
			await revoke(stand, 'ana', 'not-a-nomination'),
			await revoke(stand, 'ana', UNKNOWN),
			await revoke(stand, 'ana', BY_ANOTHER),
		];

		assert.deepEqual(answers.map(outcomeOf), [
			[404, 'nominationNotFound'],
			[404, 'nominationNotFound'],
			[404, 'nominationNotFound'],
		]);
		assert.deepEqual(
			stand.recorded.map(({ data }) => data),
			[
				{ reason: 'malformedNominationId', result: 'denied', sourceIp: '127.0.0.1' },
				{ reason: 'unknownNominationId', result: 'denied', sourceIp: '127.0.0.1' },
				{
					nominationId: BY_ANOTHER,
					reason: 'nominationBySomeoneElse',
					result: 'denied',
					sourceIp: '127.0.0.1',
				},
			],
		);
		assert.equal(methodsOf(stand).includes('revokeNomination'), false);
	});

	test('refuses a nomination no longer pending 409, its code naming its state: replaced, already decided, or revoked', async (context) => {
		const stand = standUp(context);

		const answers = [
			await revoke(stand, 'ana', REPLACED),
			await revoke(stand, 'ana', DECLINED),
			await revoke(stand, 'ana', REVOKED),
		];

		assert.deepEqual(answers.map(outcomeOf), [
			[409, 'nominationReplaced'],
			[409, 'nominationAlreadyDecided'],
			[409, 'nominationRevoked'],
		]);
		assert.equal(methodsOf(stand).includes('revokeNomination'), false);
	});
});

suite('the first administrator nominations', () => {
	test('lists every nomination to the first user, oldest first, each as the nomination now stands: nominee, nominator, state, and the instant it was answered or revoked where it was', async (context) => {
		const stand = standUp(context);

		const answer = await send(stand, 'ana', { method: 'GET', url: '/admin/nominations' });

		assert.equal(answer.statusCode, 200);
		assert.deepEqual(JSON.parse(answer.body), {
			nominations: [
				{
					id: REPLACED,
					nominatedAt: REPLACED_AT,
					nominatedBy: { subject: 'subject-ana' },
					nominee: { subject: 'subject-bo' },
					state: 'replaced',
				},
				{
					decidedAt: new Date(NOW - 90_000).toISOString(),
					id: DECLINED,
					nominatedAt: DECLINED_AT,
					nominatedBy: { subject: 'subject-ana' },
					nominee: { subject: 'subject-bo' },
					state: 'declined',
				},
				{
					id: LATEST,
					nominatedAt: LATEST_AT,
					nominatedBy: { subject: 'subject-ana' },
					nominee: { subject: 'subject-bo' },
					state: 'pending',
				},
			],
		});
		assert.deepEqual(stand.recorded, []);
	});

	test('refuses everyone but the first user the listing 403, a service account included, before any lookup', async (context) => {
		const stand = standUp(context);

		const answers = [
			await send(stand, 'bo', { method: 'GET', url: '/admin/nominations' }),
			await send(stand, 'service', { method: 'GET', url: '/admin/nominations' }),
		];

		assert.deepEqual(answers.map(outcomeOf), [
			[403, 'notFirstUser'],
			[403, 'serviceAccountNotPermitted'],
		]);
		assert.equal(stand.reads.length, 0);
	});
});

suite("a nominee's own nominations", () => {
	test('lists the nominations naming the caller, oldest first, each with its nominator by subject, its instant and its state, recording nothing', async (context) => {
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
					nominatedAt: REPLACED_AT,
					nominatedBy: { subject: 'subject-ana' },
					state: 'replaced',
				},
				{
					id: LATEST,
					nominatedAt: LATEST_AT,
					nominatedBy: { subject: 'subject-ana' },
					state: 'pending',
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
		const after = standUp(context, { administrators: { 'subject-ana': ANA_ADMINISTERS_SINCE } });

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

suite('nominating and revoking once an administrator has accepted', () => {
	test('lets an administrator nominate a person Usher has met, the nominee checked for being an administrator and for a pending nomination before the nomination is appended', async (context) => {
		const stand = standUp(context, { administrators: { 'subject-ana': ANA_ADMINISTERS_SINCE } });

		const answer = await nominate(stand, 'ana', 'subject-dee');

		assert.equal(answer.statusCode, 201);
		assert.deepEqual(methodsOf(stand), [
			'lockAdministrators',
			'administratorExists',
			'isAdministrator',
			'isAdministrator',
			'findPerson',
			'findOrRecordPerson',
			'findOrRecordPerson',
			'appendNomination',
		]);
		assert.deepEqual(stand.calls[2]?.values, ['subject-ana']);
		assert.deepEqual(stand.calls[3]?.values, ['subject-dee']);
	});

	test('refuses an administrator the gate admitted whose status the store withdrew before the transaction 403 administratorOnly, appending no nomination', async (context) => {
		const stand = standUp(context, {
			administrators: { 'subject-ana': ANA_ADMINISTERS_SINCE, 'subject-cy': CY_ADMINISTERS_SINCE },
			withdrawn: ['subject-cy'],
		});

		const answer = await nominate(stand, 'cy', 'subject-dee');

		assert.deepEqual(outcomeOf(answer), [403, 'administratorOnly']);
		assert.equal(methodsOf(stand).includes('appendNomination'), false);
	});

	test('refuses an administrator nominating a person who is one already 409 nomineeAlreadyAdministrator, recording the nominee read', async (context) => {
		const stand = standUp(context, {
			administrators: { 'subject-ana': ANA_ADMINISTERS_SINCE, 'subject-cy': CY_ADMINISTERS_SINCE },
		});

		const answer = await nominate(stand, 'ana', 'subject-cy');

		assert.deepEqual(outcomeOf(answer), [409, 'nomineeAlreadyAdministrator']);
		assert.equal(methodsOf(stand).includes('appendNomination'), false);
		assert.deepEqual(stand.recorded.at(-1)?.data, {
			nomineeSubject: 'subject-cy',
			reason: 'nomineeAlreadyAdministrator',
			result: 'denied',
			sourceIp: '127.0.0.1',
		});
	});

	test('refuses a nominee a pending nomination already names 409 nomineeAlreadyNominated, its detail naming that nomination, and records the nominee read', async (context) => {
		const stand = standUp(context, { administrators: { 'subject-ana': ANA_ADMINISTERS_SINCE } });

		const answer = await nominate(stand, 'ana', 'subject-bo');

		assert.deepEqual(outcomeOf(answer), [409, 'nomineeAlreadyNominated']);
		assert.match(Reflect.get(Object(JSON.parse(answer.body)), 'detail') as string, new RegExp(LATEST));
		assert.match(Reflect.get(Object(JSON.parse(answer.body)), 'detail') as string, /DELETE \/admin\/nominations\//);
		assert.equal(methodsOf(stand).includes('appendNomination'), false);
		assert.deepEqual(stand.recorded.at(-1)?.data, {
			nomineeSubject: 'subject-bo',
			reason: 'nomineeAlreadyNominated',
			result: 'denied',
			sourceIp: '127.0.0.1',
		});
	});

	test('keeps a first user nominating again before any administrator has accepted, the earlier nomination replaced, with no check for a pending nomination', async (context) => {
		const stand = standUp(context);

		const answer = await nominate(stand, 'ana', 'subject-bo');

		assert.equal(answer.statusCode, 201);
		assert.equal(methodsOf(stand).includes('pendingNominationOf'), false);
		assert.equal(methodsOf(stand).includes('isAdministrator'), false);
	});

	test('refuses a first user who is not an administrator nominating 403 administratorOnly once one has accepted, and a service account too', async (context) => {
		const stand = standUp(context, { administrators: { 'subject-cy': CY_ADMINISTERS_SINCE } });

		const answers = [await nominate(stand, 'ana', 'subject-dee'), await nominate(stand, 'service', 'subject-dee')];

		assert.deepEqual(answers.map(outcomeOf), [
			[403, 'administratorOnly'],
			[403, 'serviceAccountNotPermitted'],
		]);
		assert.equal(stand.transactions.count, 0);
	});

	test('lets an administrator revoke a pending nomination another administrator made, recording admin.nominationRevocation at warning', async (context) => {
		const stand = standUp(context, {
			administrators: { 'subject-ana': ANA_ADMINISTERS_SINCE, 'subject-cy': CY_ADMINISTERS_SINCE },
		});

		const answer = await revoke(stand, 'cy', LATEST);

		assert.equal(answer.statusCode, 200);
		assert.deepEqual(stand.calls.at(-1), {
			method: 'revokeNomination',
			values: [{ nominationId: LATEST, now: new Date(NOW) }],
		});
		assert.deepEqual(eventsOf(stand), [
			{
				data: {
					nomineeSubject: 'subject-bo',
					nominationId: LATEST,
					result: 'succeeded',
					sourceIp: '127.0.0.1',
				},
				severity: 'warning',
				type: 'admin.nominationRevocation',
			},
		]);
	});

	test('refuses an administrator the gate admitted whose status the store withdrew before the transaction 403 administratorOnly, revoking nothing', async (context) => {
		const stand = standUp(context, {
			administrators: { 'subject-ana': ANA_ADMINISTERS_SINCE, 'subject-cy': CY_ADMINISTERS_SINCE },
			withdrawn: ['subject-cy'],
		});

		const answer = await revoke(stand, 'cy', LATEST);

		assert.deepEqual(outcomeOf(answer), [403, 'administratorOnly']);
		assert.equal(methodsOf(stand).includes('revokeNomination'), false);
	});

	test('refuses a caller who is not an administrator revoking once one has accepted 403 administratorOnly', async (context) => {
		const stand = standUp(context, { administrators: { 'subject-ana': ANA_ADMINISTERS_SINCE } });

		const answer = await revoke(stand, 'cy', LATEST);

		assert.deepEqual(outcomeOf(answer), [403, 'administratorOnly']);
		assert.equal(methodsOf(stand).includes('revokeNomination'), false);
	});

	test('lets an administrator list every nomination once one has accepted', async (context) => {
		const stand = standUp(context, { administrators: { 'subject-ana': ANA_ADMINISTERS_SINCE } });

		const answer = await send(stand, 'ana', { method: 'GET', url: '/admin/nominations' });

		assert.equal(answer.statusCode, 200);
		assert.equal(JSON.parse(answer.body).nominations.length, 3);
	});
});

suite('the administrators, listed and removed', () => {
	test('lists the live administrators to an administrator alone, the oldest acceptance first, each by subject, instant and nomination', async (context) => {
		const stand = standUp(context, {
			administrators: { 'subject-cy': CY_ADMINISTERS_SINCE, 'subject-ana': ANA_ADMINISTERS_SINCE },
		});

		const answer = await send(stand, 'ana', { method: 'GET', url: '/admin/administrators' });

		assert.equal(answer.statusCode, 200);
		assert.deepEqual(JSON.parse(answer.body), {
			administrators: [
				{
					acceptedAt: ANA_ADMINISTERS_SINCE.acceptedAt.toISOString(),
					nominationId: ACCEPTED_BY_ANA,
					subject: 'subject-ana',
				},
				{
					acceptedAt: CY_ADMINISTERS_SINCE.acceptedAt.toISOString(),
					nominationId: ACCEPTED_BY_CY,
					subject: 'subject-cy',
				},
			],
		});
		assert.deepEqual(stand.recorded, []);
	});

	test('refuses the listing to anyone but an administrator 403 administratorOnly, a service account 403 serviceAccountNotPermitted, and before any administrator 403 noAdministratorYet', async (context) => {
		const stand = standUp(context, { administrators: { 'subject-ana': ANA_ADMINISTERS_SINCE } });
		const none = standUp(context);

		const answers = [
			await send(stand, 'bo', { method: 'GET', url: '/admin/administrators' }),
			await send(stand, 'service', { method: 'GET', url: '/admin/administrators' }),
			await send(none, 'ana', { method: 'GET', url: '/admin/administrators' }),
		];

		assert.deepEqual(answers.map(outcomeOf), [
			[403, 'administratorOnly'],
			[403, 'serviceAccountNotPermitted'],
			[403, 'noAdministratorYet'],
		]);
	});

	test('removes another administrator, answering 200, writing the removal by the caller, revoking the nominations the removed one made, and recording each revocation then admin.removal at critical', async (context) => {
		const stand = standUp(context, {
			administrators: { 'subject-ana': ANA_ADMINISTERS_SINCE, 'subject-cy': CY_ADMINISTERS_SINCE },
		});

		const answer = await send(stand, 'ana', { method: 'DELETE', url: '/admin/administrators/subject-cy' });

		assert.equal(answer.statusCode, 200);
		assert.deepEqual(JSON.parse(answer.body), {
			removedAt: INSTANT,
			revokedNominations: 1,
			subject: 'subject-cy',
		});
		assert.deepEqual(
			stand.calls.filter(({ method }) => method === 'removeAdministrator'),
			[
				{
					method: 'removeAdministrator',
					values: [{ nominationId: ACCEPTED_BY_CY, removedBy: 'person-ana', now: new Date(NOW) }],
				},
			],
		);
		assert.deepEqual(
			stand.calls.filter(({ method }) => method === 'revokeNomination'),
			[
				{
					method: 'revokeNomination',
					values: [{ nominationId: BY_ANOTHER, now: new Date(NOW) }],
				},
			],
		);
		assert.deepEqual(eventsOf(stand), [
			{
				data: {
					nomineeSubject: 'subject-bo',
					nominationId: BY_ANOTHER,
					result: 'succeeded',
					sourceIp: '127.0.0.1',
				},
				severity: 'warning',
				type: 'admin.nominationRevocation',
			},
			{
				data: {
					administratorSubject: 'subject-cy',
					result: 'succeeded',
					revokedNominations: 1,
					sourceIp: '127.0.0.1',
				},
				severity: 'critical',
				type: 'admin.removal',
			},
		]);
	});

	test('lets an administrator remove themself while not the last, and their next request then refused 403 administratorOnly', async (context) => {
		const stand = standUp(context, {
			administrators: { 'subject-ana': ANA_ADMINISTERS_SINCE, 'subject-cy': CY_ADMINISTERS_SINCE },
		});

		const removal = await send(stand, 'cy', { method: 'DELETE', url: '/admin/administrators/subject-cy' });
		const next = await send(stand, 'cy', { method: 'GET', url: '/admin/administrators' });

		assert.deepEqual([removal.statusCode, next.statusCode], [200, 403]);
		assert.equal(Reflect.get(Object(JSON.parse(next.body)), 'code'), 'administratorOnly');
	});

	test('refuses removing the last administrator 409 lastAdministrator, writing no removal', async (context) => {
		const stand = standUp(context, { administrators: { 'subject-ana': ANA_ADMINISTERS_SINCE } });

		const answer = await send(stand, 'ana', { method: 'DELETE', url: '/admin/administrators/subject-ana' });

		assert.deepEqual(outcomeOf(answer), [409, 'lastAdministrator']);
		assert.equal(methodsOf(stand).includes('removeAdministrator'), false);
		assert.deepEqual(stand.recorded.at(-1)?.data, {
			administratorSubject: 'subject-ana',
			reason: 'lastAdministrator',
			result: 'denied',
			sourceIp: '127.0.0.1',
		});
	});

	test('answers a subject no live administrator holds 404 administratorNotFound, recording the reason notAdministrator, whether met or not', async (context) => {
		const stand = standUp(context, {
			administrators: { 'subject-ana': ANA_ADMINISTERS_SINCE, 'subject-cy': CY_ADMINISTERS_SINCE },
		});

		const answers = [
			await send(stand, 'ana', { method: 'DELETE', url: '/admin/administrators/subject-bo' }),
			await send(stand, 'ana', { method: 'DELETE', url: '/admin/administrators/subject-unknown' }),
		];

		assert.deepEqual(answers.map(outcomeOf), [
			[404, 'administratorNotFound'],
			[404, 'administratorNotFound'],
		]);
		assert.deepEqual(
			stand.recorded.map(({ data }) => data),
			[
				{
					administratorSubject: 'subject-bo',
					reason: 'notAdministrator',
					result: 'denied',
					sourceIp: '127.0.0.1',
				},
				{
					administratorSubject: 'subject-unknown',
					reason: 'notAdministrator',
					result: 'denied',
					sourceIp: '127.0.0.1',
				},
			],
		);
		assert.equal(methodsOf(stand).includes('removeAdministrator'), false);
	});

	test('refuses an administrator the gate admitted whose status the store withdrew before the transaction 403 administratorOnly, removing no one', async (context) => {
		const stand = standUp(context, {
			administrators: { 'subject-ana': ANA_ADMINISTERS_SINCE, 'subject-cy': CY_ADMINISTERS_SINCE },
			withdrawn: ['subject-ana'],
		});

		const answer = await send(stand, 'ana', { method: 'DELETE', url: '/admin/administrators/subject-cy' });

		assert.deepEqual(outcomeOf(answer), [403, 'administratorOnly']);
		assert.equal(methodsOf(stand).includes('removeAdministrator'), false);
	});

	test('refuses removal to anyone but an administrator 403 administratorOnly, before any lookup', async (context) => {
		const stand = standUp(context, {
			administrators: { 'subject-ana': ANA_ADMINISTERS_SINCE, 'subject-cy': CY_ADMINISTERS_SINCE },
		});

		const answer = await send(stand, 'bo', { method: 'DELETE', url: '/admin/administrators/subject-cy' });

		assert.deepEqual(outcomeOf(answer), [403, 'administratorOnly']);
		assert.equal(stand.transactions.count, 0);
	});
});

suite('the transactions that alter who is an administrator', () => {
	test('begins each change of who is an administrator, nominating, accepting, revoking and removing, holding the administrators lock exclusively', async (context) => {
		const nominating = standUp(context, { administrators: { 'subject-ana': ANA_ADMINISTERS_SINCE } });
		assert.equal((await nominate(nominating, 'ana', 'subject-dee')).statusCode, 201);
		const accepting = standUp(context, { administrators: { 'subject-ana': ANA_ADMINISTERS_SINCE } });
		assert.equal((await decide(accepting, 'bo', LATEST, 'accept')).statusCode, 200);
		const revoking = standUp(context, {
			administrators: { 'subject-ana': ANA_ADMINISTERS_SINCE, 'subject-cy': CY_ADMINISTERS_SINCE },
		});
		assert.equal((await revoke(revoking, 'cy', LATEST)).statusCode, 200);
		const removing = standUp(context, {
			administrators: { 'subject-ana': ANA_ADMINISTERS_SINCE, 'subject-cy': CY_ADMINISTERS_SINCE },
		});
		assert.equal(
			(await send(removing, 'ana', { method: 'DELETE', url: '/admin/administrators/subject-cy' })).statusCode,
			200,
		);

		assert.deepEqual(
			[nominating, accepting, revoking, removing].map(({ transactions }) => transactions.options),
			[
				[{ exclusiveAuthority: true }],
				[{ exclusiveAuthority: true }],
				[{ exclusiveAuthority: true }],
				[{ exclusiveAuthority: true }],
			],
		);
	});
});
