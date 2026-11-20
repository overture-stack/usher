import assert from 'node:assert/strict';
import { suite, test, type TestContext } from 'node:test';

import type { FastifyInstance } from 'fastify';
import pg from 'pg';

import type { AuditEvent } from '../eventLog/index.js';
import { createServer } from '../http/index.js';
import type { ResourceStanding } from '../resourceStanding/index.js';
import { createGrantRoutes } from './createGrantRoutes.js';
import { cursorAfterRequest } from './readGrantRequestListing.js';
import type {
	GrantStore,
	NewDecision,
	NewGrant,
	NewGrantRequest,
	StoredGrant,
	StoredGrantRequest,
	StoredRole,
} from './types.js';

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);

const SECONDS = Math.floor(NOW / 1000);

const ISSUER = 'https://auth.example.org/realms/usher';

const GRANT_ID = '6b1f3c2e-8a4d-4f7b-9c1e-2d3a4b5c6d7e';

const UNKNOWN_GRANT_ID = '0c2d4e6f-1a3b-4c5d-8e9f-0a1b2c3d4e5f';

const REQUEST_ID = '3e5a7c9b-2d4f-4a6c-8b0d-1f3a5c7e9b2d';

const HOUR_MS = 3_600_000;

const VIEWER: StoredRole = {
	capabilities: ['record.count', 'record.export', 'record.view'],
	id: 'role-viewer',
	name: 'viewer',
	plane: 'data',
};

const ROLES: Readonly<Record<string, StoredRole>> = {
	owner: {
		capabilities: ['grant.create', 'grant.revoke', 'resource.view'],
		id: 'role-owner',
		name: 'owner',
		plane: 'control',
	},
	submitter: {
		capabilities: ['record.create', 'record.update'],
		id: 'role-submitter',
		name: 'submitter',
		plane: 'data',
	},
	viewer: VIEWER,
};

const STUDY_A1: ResourceStanding = {
	accessLevel: 'grant',
	countedOwner: false,
	externalId: 'STUDY-A1',
	holder: false,
	id: 'resource-a1',
	retired: false,
	suppressed: false,
};

// Cy's pending viewer grant on STUDY-A1 under `global.controlled`, granted by Ana.
const PENDING: StoredGrant = {
	category: 'global.controlled',
	decision: null,
	endedAt: null,
	expiresAt: null,
	grantedAt: new Date(NOW - 60_000),
	granterSubject: 'subject-ana',
	holderSubject: 'subject-cy',
	holderUserId: 'person-cy',
	id: GRANT_ID,
	resource: 'STUDY-A1',
	resourceId: 'resource-a1',
	resourceRetired: false,
	revokedAt: null,
	revokerSubject: null,
	role: 'viewer',
	selfGrant: false,
	selfGrantSince: null,
};

// The administrator's pending request for a viewer grant on STUDY-A1 under `global.controlled`,
// shown two of the role's capabilities when they asked.
const ASKED: StoredGrantRequest = {
	capabilities: ['record.count', 'record.view'],
	category: 'global.controlled',
	decidedAt: null,
	decision: null,
	expiresAt: new Date(NOW + 2 * HOUR_MS),
	grantId: null,
	holderSubject: 'subject-administrator',
	holderUserId: 'person-administrator',
	id: REQUEST_ID,
	kind: 'selfGrant',
	recordCategoryId: 'category-controlled',
	requestedAt: new Date(NOW - 60_000),
	requestedBy: 'person-administrator',
	requestedBySubject: 'subject-administrator',
	resource: 'STUDY-A1',
	resourceId: 'resource-a1',
	resourceRetired: false,
	role: 'viewer',
	roleId: 'role-viewer',
};

/** What the fake store holds for one test. */
interface World {
	/** The categories every resource offers, by scoped name, each with its id. */
	categories: Readonly<Record<string, string>>;

	/** What failure the transaction's COMMIT meets, where one does. */
	commitFailure?: unknown;

	/** How many counted owners a resource has besides a grant's holder. */
	countedOwnersBesides: number;

	/** The people holding a counted owner grant on STUDY-A1. */
	countedOwners: readonly string[];

	/** The grant the store holds, by its id. */
	grant: StoredGrant | undefined;

	/** The grant request the store holds, by its id. */
	grantRequest: StoredGrantRequest | undefined;

	/** Whether a creation finds its terms held already. */
	held: boolean;

	/** The externalIds of the resources the store holds, whatever their standing. */
	registered: readonly string[];

	/** Whether a request finds its holder holding a live grant on its terms. */
	holdsLive: boolean;

	/** Whether a request finds one by the same person on its terms already, pending and unlapsed. */
	pendingRequest: boolean;

	/** The rows a listing of grant requests reads. */
	requestRows: readonly Readonly<Record<string, unknown>>[];

	/** Where each subject stands on STUDY-A1. */
	standings: Readonly<Record<string, Partial<ResourceStanding>>>;
}

interface Call {
	method: keyof GrantStore;
	values: readonly unknown[];
}

interface Read {
	text: string;
	values: readonly unknown[];
}

interface Stand {
	calls: Call[];

	/** The statements read outside any transaction, as read. */
	reads: Read[];

	recorded: AuditEvent[];
	server: FastifyInstance;

	/** How many transactions the grant operations began, as they began. */
	transactions: { count: number };
}

const WORLD: World = {
	categories: {
		'global.controlled': 'category-controlled',
		'global.unmarked': 'category-unmarked',
	},
	countedOwners: ['person-ana', 'person-dana'],
	countedOwnersBesides: 1,
	grant: PENDING,
	grantRequest: ASKED,
	held: false,
	registered: [STUDY_A1.externalId],
	holdsLive: false,
	pendingRequest: false,
	requestRows: [],
	standings: {
		'subject-administrator': {},
		'subject-ana': { countedOwner: true, holder: true },
		'subject-bo': { holder: true },
		'subject-cy': { holder: true },
	},
};

// A store answering from the world given, keeping each call made of it in order.
const fakeStore = (world: World, calls: Call[]): GrantStore => {
	const called = (method: keyof GrantStore, ...values: unknown[]): void => {
		calls.push({ method, values });
	};
	return {
		appendDecision: async (decision: NewDecision) => {
			called('appendDecision', decision);
			return decision.now;
		},
		changeGrant: async (changed) => {
			called('changeGrant', changed);
		},
		countedOwnersBesides: async (question) => {
			called('countedOwnersBesides', question);
			return world.countedOwnersBesides;
		},
		countedOwnersOf: async (question) => {
			called('countedOwnersOf', question);
			return world.countedOwners;
		},
		endExpiredGrant: async (terms, now) => {
			called('endExpiredGrant', terms, now);
			return true;
		},
		findOfferedCategory: async (scopedName, resourceId) => {
			called('findOfferedCategory', scopedName, resourceId);
			return world.categories[scopedName];
		},
		findOrRecordPerson: async (subject, now) => {
			called('findOrRecordPerson', subject, now);
			return `person-${subject.replace('subject-', '')}`;
		},
		findPerson: async (subject) => {
			called('findPerson', subject);
			return `person-${subject.replace('subject-', '')}`;
		},
		findRole: async (name) => {
			called('findRole', name);
			return ROLES[name];
		},
		holdsLiveGrant: async (terms, now) => {
			called('holdsLiveGrant', terms, now);
			return world.holdsLive;
		},
		holdsPendingRequest: async (question) => {
			called('holdsPendingRequest', question);
			return world.pendingRequest;
		},
		insertGrant: async (grant: NewGrant) => {
			called('insertGrant', grant);
			return world.held ? undefined : GRANT_ID;
		},
		insertGrantRequest: async (request: NewGrantRequest) => {
			called('insertGrantRequest', request);
			return REQUEST_ID;
		},
		locateGrant: async (grantId) => {
			called('locateGrant', grantId);
			return world.grant?.id === grantId
				? {
						externalId: world.grant.resource,
						resourceId: world.grant.resourceId,
					}
				: undefined;
		},
		locateGrantRequest: async (requestId) => {
			called('locateGrantRequest', requestId);
			return world.grantRequest?.id === requestId ? { resourceId: world.grantRequest.resourceId } : undefined;
		},
		lockResource: async (resourceId) => {
			called('lockResource', resourceId);
		},
		readGrant: async (grantId) => {
			called('readGrant', grantId);
			return world.grant?.id === grantId ? world.grant : undefined;
		},
		readGrantRequest: async (requestId) => {
			called('readGrantRequest', requestId);
			return world.grantRequest?.id === requestId ? world.grantRequest : undefined;
		},
		readStanding: async (question) => {
			called('readStanding', question);
			const standing = world.standings[question.subject] ?? {};
			return question.externalId === STUDY_A1.externalId ? { ...STUDY_A1, ...standing } : undefined;
		},
		recordDecision: async (decision) => {
			called('recordDecision', decision);
		},
		revokeGrant: async (revocation) => {
			called('revokeGrant', revocation);
		},
		writeNotifications: async (notifications) => {
			called('writeNotifications', notifications);
		},
	};
};

const tokenOf = (subject: string, extra: Readonly<Record<string, unknown>> = {}) => ({
	claims: {
		aud: ['usher-management'],
		azp: 'usher-ui',
		exp: SECONDS + 300,
		iat: SECONDS - 10,
		iss: ISSUER,
		sub: subject,
		typ: 'Bearer',
		...extra,
	},
	header: { alg: 'RS256', typ: 'JWT' },
	kind: 'verified' as const,
});

// The bearer credential each caller sends, by the caller's name.
const TOKENS: Readonly<Record<string, ReturnType<typeof tokenOf>>> = {
	administrator: tokenOf('subject-administrator'),
	ana: tokenOf('subject-ana'),
	bo: tokenOf('subject-bo'),
	cy: tokenOf('subject-cy'),
	eli: tokenOf('subject-eli'),
	secondAdministrator: tokenOf('subject-second-administrator'),
	serviceAccount: tokenOf('subject-service', { realm_access: { roles: ['usher-service-account'] } }),
};

// The platform administrators the store holds.
const ADMINISTRATOR_SUBJECTS: readonly string[] = ['subject-administrator', 'subject-second-administrator'];

const standUp = (context: TestContext, world: Partial<World> = {}, autoAccept = false): Stand => {
	const known: World = { ...WORLD, ...world };
	const stand = {
		calls: [] as Call[],
		reads: [] as Read[],
		recorded: [] as AuditEvent[],
		transactions: { count: 0 },
	};
	const server = createServer({
		isLive: () => true,
		isReady: async () => true,
		trustedProxies: [],
	});
	createGrantRoutes(
		{
			grantStoreOf: () => fakeStore(known, stand.calls),
			settings: {
				clock: { now: () => NOW },
				grantAutoAccept: autoAccept,
				databaseSchema: 'usher',
				identityProviderIssuer: ISSUER,
				selfGrantMaximumLifetimeSeconds: 86_400,
				submitterCategory: 'global.unmarked',
			},
			store: {
				// Whether the store holds the resource a refused request's body names by its externalId, for a question
				// reading the resources, or else the grant or the request its id names. A listing's page of grant requests
				// is the rows the test gives.
				query: async <Row extends pg.QueryResultRow>(
					text: string,
					values: readonly unknown[] = [],
				): Promise<pg.QueryResult<Row>> => {
					stand.reads.push({ text, values });
					const rows = text.includes('ORDER BY')
						? known.requestRows
						: [
								{
									exists: /\.resources\b/u.test(text)
										? known.registered.includes(String(values[0]))
										: values[0] === known.grant?.id || values[0] === known.grantRequest?.id,
								},
							];
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
					if (known.commitFailure !== undefined) {
						throw known.commitFailure;
					}
					stand.recorded.push(...recorded);
					return result;
				},
			},
		},
		{
			administratorStatus: async ({ subject }) => ({
				administrator: ADMINISTRATOR_SUBJECTS.includes(subject),
				anyAdministrator: true,
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
	{
		body,
		method,
		url,
	}: {
		body?: unknown;
		method: 'DELETE' | 'GET' | 'PATCH' | 'POST';
		url: string;
	},
) =>
	server.inject({
		headers: {
			authorization: `Bearer ${caller}`,
			...(body === undefined
				? {}
				: {
						'content-type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json',
					}),
		},
		method,
		url,
		...(body === undefined ? {} : { payload: JSON.stringify(body) }),
	});

const VIEWER_CREATION = {
	category: 'global.controlled',
	holder: { subject: 'subject-cy' },
	resource: 'STUDY-A1',
	role: 'viewer',
};

const create = (stand: Stand, caller: string, body: unknown = VIEWER_CREATION) =>
	send(stand, caller, { body, method: 'POST', url: '/admin/grants' });

const answer = (stand: Stand, caller: string, body: unknown, grantId: string = GRANT_ID) =>
	send(stand, caller, {
		body,
		method: 'POST',
		url: `/admin/grants/${encodeURIComponent(grantId)}/decisions`,
	});

const revoke = (stand: Stand, caller: string, grantId: string = GRANT_ID, body?: unknown) =>
	send(stand, caller, {
		body,
		method: 'DELETE',
		url: `/admin/grants/${encodeURIComponent(grantId)}`,
	});

const parsed = (answered: { body: string }): Readonly<Record<string, unknown>> =>
	JSON.parse(answered.body) as Readonly<Record<string, unknown>>;

const outcomeOf = (answered: { body: string; statusCode: number }): readonly unknown[] => [
	answered.statusCode,
	answered.statusCode < 300 ? undefined : parsed(answered)['code'],
];

const methodsCalled = ({ calls }: Stand): readonly string[] => calls.map(({ method }) => method);

const eventData = ({ recorded }: Stand): readonly Readonly<Record<string, unknown>>[] =>
	recorded.map(({ data, type }) => ({ type, ...data }));

const ACCEPTING = { capabilities: VIEWER.capabilities, decision: 'accepted' };

suite('creating a grant', () => {
	test("records an unmet holder, ends an expired grant on the grant's terms before writing it, and answers 201 with the grant", async (context) => {
		const stand = standUp(context);

		const created = await create(stand, 'ana');

		assert.equal(created.statusCode, 201);
		assert.deepEqual(parsed(created), {
			category: 'global.controlled',
			decision: null,
			expiresAt: null,
			grantedAt: '2026-11-12T12:00:00.000Z',
			grantedBy: { subject: 'subject-ana' },
			holder: { hasAccount: true, subject: 'subject-cy' },
			id: GRANT_ID,
			kind: 'grant',
			resource: 'STUDY-A1',
			revokedAt: null,
			revokedBy: null,
			role: 'viewer',
			selfGrant: false,
			state: 'pending',
		});
		assert.deepEqual(methodsCalled(stand), [
			'findRole',
			'readStanding',
			'findOfferedCategory',
			'findOrRecordPerson',
			'findOrRecordPerson',
			'endExpiredGrant',
			'insertGrant',
		]);
		const terms = {
			holderUserId: 'person-cy',
			recordCategoryId: 'category-controlled',
			resourceId: 'resource-a1',
			roleId: 'role-viewer',
		};
		assert.deepEqual(
			stand.calls.filter(({ method }) => ['endExpiredGrant', 'insertGrant', 'readStanding'].includes(method)),
			[
				{
					method: 'readStanding',
					values: [
						{
							externalId: 'STUDY-A1',
							lock: 'share',
							now: new Date(NOW),
							subject: 'subject-ana',
						},
					],
				},
				{ method: 'endExpiredGrant', values: [terms, new Date(NOW)] },
				{
					method: 'insertGrant',
					values: [
						{
							...terms,
							expiresAt: null,
							grantedAt: new Date(NOW),
							grantedBy: 'person-ana',
							requestedBy: null,
						},
					],
				},
			],
		);
		assert.deepEqual(eventData(stand), [
			{
				category: 'global.controlled',
				grantId: GRANT_ID,
				granteeId: 'subject-cy',
				resourceId: 'STUDY-A1',
				result: 'succeeded',
				role: 'viewer',
				sourceIp: '127.0.0.1',
				type: 'grant.creation',
			},
		]);
	});

	test("records the holder's acceptance, showing what the role confers now, with the grant when auto-accept is on", async (context) => {
		const stand = standUp(context, {}, true);

		const created = await create(stand, 'ana');

		assert.equal(created.statusCode, 201);
		assert.deepEqual(parsed(created)['decision'], {
			capabilities: VIEWER.capabilities,
			decidedAt: '2026-11-12T12:00:00.000Z',
			decision: 'accepted',
		});
		assert.equal(parsed(created)['state'], 'accepted');
		assert.deepEqual(stand.calls.find(({ method }) => method === 'appendDecision')?.values, [
			{
				capabilities: VIEWER.capabilities,
				decision: 'accepted',
				grantId: GRANT_ID,
				now: new Date(NOW),
				userId: 'person-cy',
			},
		]);
	});

	test("gives a submitter grant naming no category the instance's submitter category", async (context) => {
		const stand = standUp(context);

		const created = await create(stand, 'administrator', {
			holder: { subject: 'subject-cy' },
			resource: 'STUDY-A1',
			role: 'submitter',
		});

		assert.equal(created.statusCode, 201);
		assert.equal(parsed(created)['category'], 'global.unmarked');
		assert.deepEqual(stand.calls.find(({ method }) => method === 'findOfferedCategory')?.values, [
			'global.unmarked',
			'resource-a1',
		]);
	});

	test('answers terms held already 409 alreadyHolds, recording it denied, naming the resource and no grant', async (context) => {
		const stand = standUp(context, { held: true });

		const refused = await create(stand, 'ana');

		assert.deepEqual(outcomeOf(refused), [409, 'alreadyHolds']);
		assert.deepEqual(eventData(stand), [
			{
				reason: 'alreadyHolds',
				resourceId: 'STUDY-A1',
				result: 'denied',
				sourceIp: '127.0.0.1',
				type: 'grant.creation',
			},
		]);
	});

	test('answers a principal who may not see the resource as for an absent one, recording a refusal of authority naming the resource, and a resource that does not exist as not found naming none', async (context) => {
		const stand = standUp(context, {
			standings: { ...WORLD.standings, 'subject-bo': {} },
		});

		const hidden = await create(stand, 'bo');
		const absent = await create(stand, 'bo', {
			...VIEWER_CREATION,
			resource: 'STUDY-Z9',
		});

		assert.deepEqual(outcomeOf(hidden), [404, 'resourceNotFound']);
		assert.equal(hidden.body, absent.body);
		assert.deepEqual(eventData(stand), [
			{
				reason: 'noAuthorityOnResource',
				resourceId: 'STUDY-A1',
				result: 'denied',
				sourceIp: '127.0.0.1',
				type: 'grant.creation',
			},
			{
				reason: 'resourceNotFound',
				result: 'denied',
				sourceIp: '127.0.0.1',
				type: 'grant.creation',
			},
		]);
		assert.equal(methodsCalled(stand).includes('insertGrant'), false);
	});

	test("names in a refused creation's event the resource its body names when one is registered under that externalId, whatever the refusal and the resource's standing, and none for text naming no registered resource", async (context) => {
		const stand = standUp(context, {
			standings: { ...WORLD.standings, 'subject-bo': { retired: true } },
		});
		const unknownRole = { ...VIEWER_CREATION, role: 'Viewer' };

		const answers = [
			await create(stand, 'ana', unknownRole),
			await create(stand, 'bo'),
			await create(stand, 'ana', { ...unknownRole, resource: 'STUDY-Z9' }),
			await create(stand, 'administrator', {
				...VIEWER_CREATION,
				resource: 'STUDY-Z9',
			}),
		];

		assert.deepEqual(answers.map(outcomeOf), [
			[422, 'unknownRole'],
			[404, 'resourceNotFound'],
			[422, 'unknownRole'],
			[403, 'administratorGrantsNoConsumerAccess'],
		]);
		assert.deepEqual(
			eventData(stand).map((data) =>
				Object.hasOwn(data, 'resourceId') ? [data['reason'], data['resourceId']] : [data['reason']],
			),
			[
				['unknownRole', 'STUDY-A1'],
				['resourceNotFound', 'STUDY-A1'],
				['unknownRole'],
				['administratorGrantsNoConsumerAccess'],
			],
		);
	});

	test('refuses a holder of a grant on the resource who owns it not 403 noAuthorityOnResource, writing nothing', async (context) => {
		const stand = standUp(context);

		const refused = await create(stand, 'bo');

		assert.deepEqual(outcomeOf(refused), [403, 'noAuthorityOnResource']);
		assert.equal(methodsCalled(stand).includes('insertGrant'), false);
	});

	test("refuses an administrator's consumer grant 403 alike on an absent resource, and a self-named one 422 ahead of it", async (context) => {
		const stand = standUp(context);

		const onKnown = await create(stand, 'administrator');
		const onAbsent = await create(stand, 'administrator', {
			...VIEWER_CREATION,
			resource: 'STUDY-Z9',
		});
		const selfNamed = await create(stand, 'administrator', {
			...VIEWER_CREATION,
			holder: { subject: 'subject-administrator' },
		});
		const selfOwned = await create(stand, 'administrator', {
			holder: { subject: 'subject-administrator' },
			resource: 'STUDY-A1',
			role: 'owner',
		});

		assert.deepEqual(outcomeOf(onKnown), [403, 'administratorGrantsNoConsumerAccess']);
		assert.equal(onKnown.body, onAbsent.body);
		assert.deepEqual(outcomeOf(selfNamed), [422, 'selfNamed']);
		assert.match(String(parsed(selfNamed)['detail']), /\/admin\/grants\/self/u);
		assert.deepEqual(outcomeOf(selfOwned), [403, 'administratorSelfOwnership']);
	});

	test('refuses a role the instance does not define, and a data-plane role naming no category, 422 before any authority is judged', async (context) => {
		const stand = standUp(context);

		const answers = [
			await create(stand, 'bo', { ...VIEWER_CREATION, role: 'Viewer' }),
			await create(stand, 'bo', {
				holder: { subject: 'subject-cy' },
				resource: 'STUDY-A1',
				role: 'viewer',
			}),
		];

		assert.deepEqual(answers.map(outcomeOf), [
			[422, 'unknownRole'],
			[422, 'categoryRequired'],
		]);
		assert.equal(methodsCalled(stand).includes('readStanding'), false);
	});

	test('refuses a category the resource does not offer 422 once authority is judged', async (context) => {
		const stand = standUp(context);

		const refused = await create(stand, 'ana', {
			...VIEWER_CREATION,
			category: 'resource.internal',
		});

		assert.deepEqual(outcomeOf(refused), [422, 'categoryNotOffered']);
		assert.equal(methodsCalled(stand).includes('insertGrant'), false);
	});

	test('answers a holder named by address 503 directoryUnavailable once the rest is judged, recording no person and writing no grant', async (context) => {
		const stand = standUp(context);
		const byAddress = {
			holder: { email: 'sub.bo@example.org' },
			resource: 'STUDY-A1',
			role: 'submitter',
		};

		const unavailable = await create(stand, 'administrator', byAddress);
		const hidden = await create(stand, 'cy', {
			...byAddress,
			resource: 'STUDY-Z9',
		});

		assert.deepEqual(outcomeOf(unavailable), [503, 'directoryUnavailable']);
		assert.deepEqual(outcomeOf(hidden), [404, 'resourceNotFound']);
		assert.equal(methodsCalled(stand).includes('findOrRecordPerson'), false);
	});

	test('answers a retirement committed first 404 resourceNotFound, as for a retired resource', async (context) => {
		const stand = standUp(context, {
			commitFailure: Object.assign(new Error('a retired resource'), {
				code: '23514',
				constraint: 'resources_retired_without_live_grants',
			}),
		});

		const refused = await create(stand, 'ana');

		assert.deepEqual(outcomeOf(refused), [404, 'resourceNotFound']);
	});
});

suite('answering a grant', () => {
	test("appends the holder's answer, showing what the role confers now, locking the resource before the grant, and answers 204", async (context) => {
		const stand = standUp(context);

		const answered = await answer(stand, 'cy', {
			capabilities: [...VIEWER.capabilities].reverse(),
			decision: 'accepted',
		});

		assert.deepEqual(outcomeOf(answered), [204, undefined]);
		assert.equal(answered.body, '');
		assert.deepEqual(methodsCalled(stand), [
			'locateGrant',
			'lockResource',
			'readGrant',
			'findPerson',
			'findRole',
			'appendDecision',
		]);
		assert.deepEqual(stand.calls.find(({ method }) => method === 'appendDecision')?.values, [
			{
				capabilities: VIEWER.capabilities,
				decision: 'accepted',
				grantId: GRANT_ID,
				now: new Date(NOW),
				userId: 'person-cy',
			},
		]);
		assert.deepEqual(eventData(stand), [
			{
				category: 'global.controlled',
				decision: 'accepted',
				grantId: GRANT_ID,
				resourceId: 'STUDY-A1',
				result: 'succeeded',
				role: 'viewer',
				sourceIp: '127.0.0.1',
				type: 'grant.decision',
			},
		]);
	});

	test('answers anyone but the holder, and an unknown or malformed id, 404 grantNotFound alike, recording the refusal of authority apart', async (context) => {
		const stand = standUp(context);

		const answers = [
			await answer(stand, 'bo', ACCEPTING),
			await answer(stand, 'administrator', ACCEPTING),
			await answer(stand, 'cy', ACCEPTING, UNKNOWN_GRANT_ID),
			await answer(stand, 'cy', ACCEPTING, 'not-a-uuid'),
		];

		answers.forEach((answered) => {
			assert.deepEqual(outcomeOf(answered), [404, 'grantNotFound']);
			assert.equal(answered.body, answers[0]?.body);
		});
		assert.deepEqual(
			eventData(stand).map(({ grantId, reason }) => [grantId, reason]),
			[
				[GRANT_ID, 'noAuthorityOnResource'],
				[GRANT_ID, 'noAuthorityOnResource'],
				[undefined, 'grantNotFound'],
				[undefined, 'grantNotFound'],
			],
		);
		assert.equal(stand.transactions.count, 3);
		assert.equal(methodsCalled(stand).includes('appendDecision'), false);
	});

	test('answers a grant revoked, expired, or replaced once expired 409 doesNotHold, as for any expired grant', async (context) => {
		const ended = [
			{ ...PENDING, revokedAt: new Date(NOW - 1000) },
			{ ...PENDING, expiresAt: new Date(NOW) },
			{
				...PENDING,
				endedAt: new Date(NOW - 1000),
				expiresAt: new Date(NOW - 2000),
			},
		];

		const answers = await Promise.all(ended.map((grant) => answer(standUp(context, { grant }), 'cy', ACCEPTING)));

		assert.deepEqual(
			answers.map(outcomeOf),
			ended.map(() => [409, 'doesNotHold']),
		);
	});

	test("refuses capabilities other than the role's current ones, as a set, 422 capabilitiesDiffer", async (context) => {
		const stand = standUp(context);

		const refused = [
			await answer(stand, 'cy', {
				capabilities: [...VIEWER.capabilities, 'record.delete'],
				decision: 'accepted',
			}),
			await answer(stand, 'cy', {
				capabilities: ['record.view'],
				decision: 'accepted',
			}),
		];

		assert.deepEqual(refused.map(outcomeOf), [
			[422, 'capabilitiesDiffer'],
			[422, 'capabilitiesDiffer'],
		]);
	});

	test("refuses declining a resource's last counted owner grant 409 resourceNeedsAnOwner, and answers a commit refused for it alike", async (context) => {
		const ownership: StoredGrant = {
			...PENDING,
			category: null,
			decision: {
				capabilities: ROLES['owner']?.capabilities ?? [],
				decidedAt: new Date(NOW - 30_000),
				decision: 'accepted',
			},
			role: 'owner',
		};
		const declining = {
			capabilities: ROLES['owner']?.capabilities ?? [],
			decision: 'rejected',
		};
		const alone = standUp(context, {
			countedOwnersBesides: 0,
			grant: ownership,
		});
		const raced = standUp(context, {
			commitFailure: Object.assign(new Error('keep an owner'), {
				code: '23514',
				constraint: 'resources_keep_an_owner',
			}),
			grant: ownership,
		});

		const refused = await answer(alone, 'cy', declining);
		const lost = await answer(raced, 'cy', declining);

		assert.deepEqual(outcomeOf(refused), [409, 'resourceNeedsAnOwner']);
		assert.match(String(parsed(refused)['detail']), /add another owner/iu);
		assert.equal(methodsCalled(alone).includes('appendDecision'), false);
		assert.deepEqual(outcomeOf(lost), [409, 'resourceNeedsAnOwner']);
	});
});

suite('revoking a grant', () => {
	test('revokes a grant for a platform administrator, its resource locked first, recording the reason given, and answers with the revoked grant', async (context) => {
		const stand = standUp(context);

		const revoked = await revoke(stand, 'administrator', GRANT_ID, {
			reason: 'accessReview',
		});

		assert.equal(revoked.statusCode, 200);
		assert.deepEqual(
			[
				parsed(revoked)['revokedAt'],
				parsed(revoked)['revokedBy'],
				parsed(revoked)['holder'],
				parsed(revoked)['resource'],
				parsed(revoked)['state'],
			],
			[
				'2026-11-12T12:00:00.000Z',
				{ subject: 'subject-administrator' },
				{ hasAccount: true, subject: 'subject-cy' },
				'STUDY-A1',
				'revoked',
			],
		);
		assert.deepEqual(methodsCalled(stand), [
			'locateGrant',
			'readStanding',
			'readGrant',
			'findOrRecordPerson',
			'revokeGrant',
		]);
		assert.deepEqual(stand.calls.find(({ method }) => method === 'readStanding')?.values, [
			{
				externalId: 'STUDY-A1',
				lock: 'noKeyUpdate',
				now: new Date(NOW),
				subject: 'subject-administrator',
			},
		]);
		assert.deepEqual(eventData(stand), [
			{
				category: 'global.controlled',
				grantId: GRANT_ID,
				granteeId: 'subject-cy',
				reason: 'accessReview',
				resourceId: 'STUDY-A1',
				result: 'succeeded',
				role: 'viewer',
				sourceIp: '127.0.0.1',
				type: 'grant.revocation',
			},
		]);
	});

	test('revokes for a counted owner of its resource, recording unspecified for no reason given', async (context) => {
		const stand = standUp(context);

		const revoked = await revoke(stand, 'ana');

		assert.equal(revoked.statusCode, 200);
		assert.deepEqual(
			eventData(stand).map(({ reason }) => reason),
			['unspecified'],
		);
	});

	test('revokes a grant replaced once expired as any expired grant', async (context) => {
		const stand = standUp(context, {
			grant: {
				...PENDING,
				endedAt: new Date(NOW - 1000),
				expiresAt: new Date(NOW - 2000),
			},
		});

		const revoked = await revoke(stand, 'administrator');

		assert.equal(revoked.statusCode, 200);
		assert.equal(parsed(revoked)['state'], 'revoked');
		assert.equal(parsed(revoked)['expiresAt'], new Date(NOW - 2000).toISOString());
		assert.equal(Object.hasOwn(parsed(revoked), 'endedAt'), false);
		assert.equal(methodsCalled(stand).includes('revokeGrant'), true);
	});

	test('answers a principal without authority on its resource, and an unknown, malformed or empty id, 404 grantNotFound alike, recording the refusal of authority apart', async (context) => {
		const stand = standUp(context);

		const answers = [
			await revoke(stand, 'bo'),
			await revoke(stand, 'cy'),
			await revoke(stand, 'administrator', UNKNOWN_GRANT_ID),
			await revoke(stand, 'administrator', '../STUDY-A1'),
			await revoke(stand, 'administrator', ''),
		];

		answers.forEach((answered) => {
			assert.deepEqual(outcomeOf(answered), [404, 'grantNotFound']);
			assert.equal(answered.body, answers[0]?.body);
		});
		assert.deepEqual(
			eventData(stand).map(({ reason }) => reason),
			['noAuthorityOnResource', 'noAuthorityOnResource', 'grantNotFound', 'grantNotFound', 'grantNotFound'],
		);
		assert.equal(methodsCalled(stand).includes('revokeGrant'), false);
	});

	test('refuses a grant revoked already 409 doesNotHold, keeping its first revocation', async (context) => {
		const stand = standUp(context, {
			grant: {
				...PENDING,
				revokedAt: new Date(NOW - 1000),
				revokerSubject: 'subject-ana',
			},
		});

		const refused = await revoke(stand, 'administrator');

		assert.deepEqual(outcomeOf(refused), [409, 'doesNotHold']);
		assert.equal(methodsCalled(stand).includes('revokeGrant'), false);
	});

	test("refuses revoking a resource's last counted owner grant 409 resourceNeedsAnOwner", async (context) => {
		const stand = standUp(context, {
			countedOwnersBesides: 0,
			grant: {
				...PENDING,
				category: null,
				decision: {
					capabilities: ROLES['owner']?.capabilities ?? [],
					decidedAt: new Date(NOW - 30_000),
					decision: 'accepted',
				},
				role: 'owner',
			},
		});

		const refused = await revoke(stand, 'administrator');

		assert.deepEqual(outcomeOf(refused), [409, 'resourceNeedsAnOwner']);
		assert.equal(methodsCalled(stand).includes('revokeGrant'), false);
	});

	test('refuses a reason no caller may give 422 before reading the store', async (context) => {
		const stand = standUp(context);

		const refused = await revoke(stand, 'administrator', GRANT_ID, {
			reason: 'resourceRetired',
		});

		assert.deepEqual(outcomeOf(refused), [422, 'unknownRevocationReason']);
		assert.equal(stand.transactions.count, 0);
	});
});

const SELF_VIEWER = {
	category: 'global.controlled',
	expiresAt: new Date(NOW + 2 * HOUR_MS).toISOString(),
	resource: 'STUDY-A1',
	role: 'viewer',
};

const selfGrant = (stand: Stand, caller: string, body: unknown = SELF_VIEWER) =>
	send(stand, caller, { body, method: 'POST', url: '/admin/grants/self' });

const decide = (stand: Stand, caller: string, body: unknown, requestId: string = REQUEST_ID) =>
	send(stand, caller, {
		body,
		method: 'POST',
		url: `/admin/grant-requests/${encodeURIComponent(requestId)}/decisions`,
	});

const listRequests = (stand: Stand, caller: string, query = '') =>
	send(stand, caller, { method: 'GET', url: `/admin/grant-requests${query}` });

const severities = ({ recorded }: Stand): readonly unknown[] => recorded.map(({ severity, type }) => [type, severity]);

const valuesOf = (stand: Stand, method: keyof GrantStore): unknown =>
	stand.calls.find((call) => call.method === method)?.values;

suite('creating a self-grant', () => {
	test("issues a counted owner's self-grant at once with their acceptance, tells the resource's other owners, and answers 201 with the grant", async (context) => {
		const stand = standUp(context);

		const created = await selfGrant(stand, 'ana');

		assert.equal(created.statusCode, 201);
		assert.deepEqual(parsed(created), {
			category: 'global.controlled',
			decision: {
				capabilities: VIEWER.capabilities,
				decidedAt: '2026-11-12T12:00:00.000Z',
				decision: 'accepted',
			},
			expiresAt: '2026-11-12T14:00:00.000Z',
			grantedAt: '2026-11-12T12:00:00.000Z',
			grantedBy: { subject: 'subject-ana' },
			holder: { hasAccount: true, subject: 'subject-ana' },
			id: GRANT_ID,
			kind: 'grant',
			resource: 'STUDY-A1',
			revokedAt: null,
			revokedBy: null,
			role: 'viewer',
			selfGrant: true,
			state: 'accepted',
		});
		assert.deepEqual(methodsCalled(stand), [
			'findRole',
			'readStanding',
			'findOfferedCategory',
			'findOrRecordPerson',
			'endExpiredGrant',
			'insertGrant',
			'appendDecision',
			'countedOwnersOf',
			'writeNotifications',
		]);
		assert.deepEqual(valuesOf(stand, 'insertGrant'), [
			{
				expiresAt: new Date(NOW + 2 * HOUR_MS),
				grantedAt: new Date(NOW),
				grantedBy: 'person-ana',
				holderUserId: 'person-ana',
				recordCategoryId: 'category-controlled',
				requestedBy: null,
				resourceId: 'resource-a1',
				roleId: 'role-viewer',
			},
		]);
		assert.equal((valuesOf(stand, 'readStanding') as readonly { lock: string }[])[0]?.lock, 'noKeyUpdate');
		assert.deepEqual(valuesOf(stand, 'writeNotifications'), [
			{
				createdAt: new Date(NOW),
				kind: 'selfGrant',
				recipients: ['person-dana'],
				reference: GRANT_ID,
			},
		]);
		assert.deepEqual(eventData(stand), [
			{
				category: 'global.controlled',
				expiresAt: '2026-11-12T14:00:00.000Z',
				grantId: GRANT_ID,
				resourceId: 'STUDY-A1',
				result: 'succeeded',
				role: 'viewer',
				sourceIp: '127.0.0.1',
				type: 'grant.selfCreation',
			},
		]);
		assert.deepEqual(severities(stand), [['grant.selfCreation', 'warning']]);
	});

	test("takes a platform administrator's self-grant as a request someone else decides, tells each owner of the resource, and answers 202 with the request", async (context) => {
		const stand = standUp(context);

		const asked = await selfGrant(stand, 'administrator');

		assert.equal(asked.statusCode, 202);
		assert.deepEqual(parsed(asked), {
			category: 'global.controlled',
			decidedAt: null,
			expiresAt: '2026-11-12T14:00:00.000Z',
			grantId: null,
			id: REQUEST_ID,
			kind: 'grantRequest',
			requestKind: 'selfGrant',
			requestedAt: '2026-11-12T12:00:00.000Z',
			requestedBy: { subject: 'subject-administrator' },
			resource: 'STUDY-A1',
			role: 'viewer',
			state: 'pending',
		});
		assert.deepEqual(methodsCalled(stand), [
			'findRole',
			'readStanding',
			'findOfferedCategory',
			'findOrRecordPerson',
			'holdsLiveGrant',
			'holdsPendingRequest',
			'insertGrantRequest',
			'countedOwnersOf',
			'writeNotifications',
		]);
		const terms = {
			holderUserId: 'person-administrator',
			recordCategoryId: 'category-controlled',
			resourceId: 'resource-a1',
			roleId: 'role-viewer',
		};
		assert.deepEqual(valuesOf(stand, 'holdsLiveGrant'), [terms, new Date(NOW)]);
		assert.deepEqual(valuesOf(stand, 'holdsPendingRequest'), [
			{
				...terms,
				kind: 'selfGrant',
				now: new Date(NOW),
				requestedBy: 'person-administrator',
			},
		]);
		assert.deepEqual(valuesOf(stand, 'insertGrantRequest'), [
			{
				...terms,
				capabilities: VIEWER.capabilities,
				expiresAt: new Date(NOW + 2 * HOUR_MS),
				kind: 'selfGrant',
				requestedAt: new Date(NOW),
				requestedBy: 'person-administrator',
			},
		]);
		assert.deepEqual(valuesOf(stand, 'writeNotifications'), [
			{
				createdAt: new Date(NOW),
				kind: 'grantRequest',
				recipients: ['person-ana', 'person-dana'],
				reference: REQUEST_ID,
			},
		]);
		assert.deepEqual(eventData(stand), [
			{
				category: 'global.controlled',
				expiresAt: '2026-11-12T14:00:00.000Z',
				kind: 'selfGrant',
				requestId: REQUEST_ID,
				resourceId: 'STUDY-A1',
				result: 'succeeded',
				role: 'viewer',
				sourceIp: '127.0.0.1',
				type: 'grant.request',
			},
		]);
		assert.deepEqual(severities(stand), [['grant.request', 'warning']]);
	});

	test('writes no notification for a request on a resource without an owner', async (context) => {
		const stand = standUp(context, { countedOwners: [] });

		const asked = await selfGrant(stand, 'administrator');

		assert.equal(asked.statusCode, 202);
		assert.equal(methodsCalled(stand).includes('writeNotifications'), false);
	});

	test('refuses a live grant held 409 alreadyHolds, and a request pending and unlapsed on the same terms 409 alreadyRequested, writing nothing', async (context) => {
		const refusals = [
			await selfGrant(standUp(context, { held: true }), 'ana'),
			await selfGrant(standUp(context, { holdsLive: true }), 'administrator'),
			await selfGrant(standUp(context, { pendingRequest: true }), 'administrator'),
		];

		assert.deepEqual(refusals.map(outcomeOf), [
			[409, 'alreadyHolds'],
			[409, 'alreadyHolds'],
			[409, 'alreadyRequested'],
		]);
	});

	test("refuses a control-plane role, an unknown role, and a data-plane role naming no category but submitter, 422 before reading the caller's standing", async (context) => {
		const stand = standUp(context);
		const { category: _category, ...uncategorized } = SELF_VIEWER;

		const refused = [
			await selfGrant(stand, 'ana', { ...uncategorized, role: 'owner' }),
			await selfGrant(stand, 'ana', { ...SELF_VIEWER, role: 'Viewer' }),
			await selfGrant(stand, 'ana', uncategorized),
		];
		const submitter = await selfGrant(standUp(context), 'ana', {
			...uncategorized,
			role: 'submitter',
		});

		assert.deepEqual(refused.map(outcomeOf), [
			[422, 'controlPlaneSelfGrant'],
			[422, 'unknownRole'],
			[422, 'categoryRequired'],
		]);
		assert.equal(methodsCalled(stand).includes('readStanding'), false);
		assert.equal(submitter.statusCode, 201);
		assert.equal(parsed(submitter)['category'], 'global.unmarked');
	});

	test('answers a principal who may not see the resource as for one that does not exist, recording a refusal of authority, and one who may see it and owns it not 403 noAuthorityOnResource', async (context) => {
		const stand = standUp(context);

		const answers = [
			await selfGrant(stand, 'eli'),
			await selfGrant(stand, 'eli', { ...SELF_VIEWER, resource: 'STUDY-ZZ' }),
			await selfGrant(stand, 'cy'),
		];

		assert.deepEqual(answers.map(outcomeOf), [
			[404, 'resourceNotFound'],
			[404, 'resourceNotFound'],
			[403, 'noAuthorityOnResource'],
		]);
		assert.equal(answers[0]?.body, answers[1]?.body);
		assert.deepEqual(
			eventData(stand).map(({ reason, resourceId, type }) => [type, resourceId, reason]),
			[
				['grant.selfCreation', 'STUDY-A1', 'noAuthorityOnResource'],
				['grant.selfCreation', 'STUDY-ZZ', 'resourceNotFound'],
				['grant.selfCreation', 'STUDY-A1', 'noAuthorityOnResource'],
			],
		);
		assert.equal(methodsCalled(stand).includes('insertGrant'), false);
	});

	test('refuses a body breaking its rules before any transaction, a platform administrator naming owner 403 administratorSelfOwnership, and a service account 403', async (context) => {
		const stand = standUp(context);

		const refused = [
			await selfGrant(stand, 'administrator', {
				...SELF_VIEWER,
				expiresAt: new Date(NOW + 86_400_000 + 1000).toISOString(),
			}),
			await selfGrant(stand, 'administrator', {
				expiresAt: SELF_VIEWER.expiresAt,
				resource: 'STUDY-A1',
				role: 'owner',
			}),
			await selfGrant(stand, 'serviceAccount'),
		];

		assert.deepEqual(refused.map(outcomeOf), [
			[422, 'selfGrantTooLong'],
			[403, 'administratorSelfOwnership'],
			[403, 'serviceAccountNotPermitted'],
		]);
		assert.equal(stand.transactions.count, 0);
	});
});

suite('deciding a grant request', () => {
	test('grants for a counted owner, the resource locked before the request, writing the grant asked for with the acceptance shown at the request, and answers 200 with the grant', async (context) => {
		const stand = standUp(context);

		const granted = await decide(stand, 'ana', { decision: 'granted' });

		assert.equal(granted.statusCode, 200);
		assert.deepEqual(parsed(granted), {
			category: 'global.controlled',
			decision: {
				capabilities: ['record.count', 'record.view'],
				decidedAt: '2026-11-12T12:00:00.000Z',
				decision: 'accepted',
			},
			expiresAt: '2026-11-12T14:00:00.000Z',
			grantedAt: '2026-11-12T12:00:00.000Z',
			grantedBy: { subject: 'subject-ana' },
			holder: { hasAccount: true, subject: 'subject-administrator' },
			id: GRANT_ID,
			kind: 'grant',
			resource: 'STUDY-A1',
			revokedAt: null,
			revokedBy: null,
			role: 'viewer',
			selfGrant: true,
			state: 'accepted',
		});
		assert.deepEqual(methodsCalled(stand), [
			'locateGrantRequest',
			'lockResource',
			'readGrantRequest',
			'findPerson',
			'readStanding',
			'findOrRecordPerson',
			'findRole',
			'endExpiredGrant',
			'insertGrant',
			'appendDecision',
			'recordDecision',
		]);
		assert.deepEqual(valuesOf(stand, 'insertGrant'), [
			{
				expiresAt: new Date(NOW + 2 * HOUR_MS),
				grantedAt: new Date(NOW),
				grantedBy: 'person-ana',
				holderUserId: 'person-administrator',
				recordCategoryId: 'category-controlled',
				requestedBy: 'person-administrator',
				resourceId: 'resource-a1',
				roleId: 'role-viewer',
			},
		]);
		assert.deepEqual(valuesOf(stand, 'appendDecision'), [
			{
				capabilities: ['record.count', 'record.view'],
				decision: 'accepted',
				grantId: GRANT_ID,
				now: new Date(NOW),
				userId: 'person-administrator',
			},
		]);
		assert.deepEqual(valuesOf(stand, 'recordDecision'), [
			{
				decidedAt: new Date(NOW),
				decidedBy: 'person-ana',
				decision: 'granted',
				grantId: GRANT_ID,
				requestId: REQUEST_ID,
			},
		]);
		assert.deepEqual(eventData(stand), [
			{
				category: 'global.controlled',
				decision: 'granted',
				expiresAt: '2026-11-12T14:00:00.000Z',
				grantId: GRANT_ID,
				requestId: REQUEST_ID,
				requestedById: 'subject-administrator',
				resourceId: 'STUDY-A1',
				result: 'succeeded',
				role: 'viewer',
				sourceIp: '127.0.0.1',
				type: 'grant.requestDecision',
			},
		]);
		assert.deepEqual(severities(stand), [['grant.requestDecision', 'warning']]);
	});

	test('refuses for another platform administrator, recording the decision alone, and answers 200 with the decided request', async (context) => {
		const stand = standUp(context);

		const refused = await decide(stand, 'secondAdministrator', {
			decision: 'refused',
		});

		assert.equal(refused.statusCode, 200);
		assert.deepEqual(
			[
				parsed(refused)['kind'],
				parsed(refused)['state'],
				parsed(refused)['decidedAt'],
				parsed(refused)['grantId'],
			],
			['grantRequest', 'refused', '2026-11-12T12:00:00.000Z', null],
		);
		assert.equal(methodsCalled(stand).includes('insertGrant'), false);
		assert.deepEqual(valuesOf(stand, 'recordDecision'), [
			{
				decidedAt: new Date(NOW),
				decidedBy: 'person-second-administrator',
				decision: 'refused',
				grantId: null,
				requestId: REQUEST_ID,
			},
		]);
		assert.deepEqual(eventData(stand), [
			{
				decision: 'refused',
				requestId: REQUEST_ID,
				requestedById: 'subject-administrator',
				result: 'succeeded',
				sourceIp: '127.0.0.1',
				type: 'grant.requestDecision',
			},
		]);
		assert.deepEqual(severities(stand), [['grant.requestDecision', 'info']]);
	});

	test('refuses whoever asked and the holder 403 ownRequest, deciding nothing', async (context) => {
		const stand = standUp(context);

		const refused = await decide(stand, 'administrator', {
			decision: 'granted',
		});

		assert.deepEqual(outcomeOf(refused), [403, 'ownRequest']);
		assert.equal(methodsCalled(stand).includes('recordDecision'), false);
	});

	test('answers anyone without authority, an unknown or malformed id, and a request on a retired resource 404 requestNotFound alike, recording the refusal of authority apart', async (context) => {
		const stand = standUp(context);
		const retired = standUp(context, {
			grantRequest: { ...ASKED, resourceRetired: true },
		});

		const answers = [
			await decide(stand, 'cy', { decision: 'refused' }),
			await decide(stand, 'ana', { decision: 'granted' }, UNKNOWN_GRANT_ID),
			await decide(stand, 'ana', { decision: 'granted' }, 'not-a-uuid'),
			await decide(retired, 'ana', { decision: 'granted' }),
		];

		answers.forEach((answered) => {
			assert.deepEqual(outcomeOf(answered), [404, 'requestNotFound']);
			assert.equal(answered.body, answers[0]?.body);
		});
		assert.deepEqual(
			eventData(stand).map(({ decision, reason, requestId, type }) => [type, decision, requestId, reason]),
			[
				['grant.requestDecision', 'refused', REQUEST_ID, 'noAuthorityOnResource'],
				['grant.requestDecision', 'granted', undefined, 'requestNotFound'],
				['grant.requestDecision', 'granted', undefined, 'requestNotFound'],
			],
		);
		assert.equal(methodsCalled(stand).includes('recordDecision'), false);
	});

	test('refuses a request decided already 409 requestDecided, whatever its expiry, and an undecided one at or past its expiry 409 requestLapsed', async (context) => {
		const decided = {
			...ASKED,
			decidedAt: new Date(NOW - 1000),
			decision: 'refused' as const,
		};
		const requests = [
			decided,
			{ ...decided, expiresAt: new Date(NOW - 500) },
			{ ...ASKED, expiresAt: new Date(NOW) },
		];

		const answers = await Promise.all(
			requests.map((grantRequest) =>
				decide(standUp(context, { grantRequest }), 'ana', {
					decision: 'granted',
				}),
			),
		);

		assert.deepEqual(answers.map(outcomeOf), [
			[409, 'requestDecided'],
			[409, 'requestDecided'],
			[409, 'requestLapsed'],
		]);
	});

	test('refuses to grant a request for a holder holding the grant live already 409 alreadyHolds, recording no decision', async (context) => {
		const stand = standUp(context, { held: true });

		const refused = await decide(stand, 'ana', { decision: 'granted' });

		assert.deepEqual(outcomeOf(refused), [409, 'alreadyHolds']);
		assert.equal(methodsCalled(stand).includes('recordDecision'), false);
	});

	test('refuses a decision other than granted or refused 422 before any transaction, its event naming no decision', async (context) => {
		const stand = standUp(context);

		const refused = await decide(stand, 'ana', { decision: 'accepted' });

		assert.deepEqual(outcomeOf(refused), [422, 'unknownDecision']);
		assert.equal(stand.transactions.count, 0);
		assert.deepEqual(
			eventData(stand).map(({ reason, type, ...members }) => [type, reason, Object.hasOwn(members, 'decision')]),
			[['grant.requestDecision', 'unknownDecision', false]],
		);
	});
});

suite('listing grant requests', () => {
	const row = (id: string): Readonly<Record<string, unknown>> => ({
		category: 'global.controlled',
		decidedAt: null,
		decision: null,
		expiresAt: new Date(NOW + 2 * HOUR_MS),
		grantId: null,
		id,
		kind: 'selfGrant',
		requestedAt: new Date(NOW - 60_000),
		requestedBySubject: 'subject-administrator',
		resource: 'STUDY-A1',
		role: 'viewer',
	});

	test('lists the requests the caller may decide or made, a page at a time, naming the page after the last', async (context) => {
		const stand = standUp(context, {
			requestRows: [row(REQUEST_ID), row(UNKNOWN_GRANT_ID)],
		});

		const listed = await listRequests(stand, 'ana', '?limit=1');

		assert.equal(listed.statusCode, 200);
		assert.deepEqual(parsed(listed), {
			next: cursorAfterRequest(REQUEST_ID),
			requests: [
				{
					category: 'global.controlled',
					decidedAt: null,
					expiresAt: '2026-11-12T14:00:00.000Z',
					grantId: null,
					id: REQUEST_ID,
					kind: 'grantRequest',
					requestKind: 'selfGrant',
					requestedAt: '2026-11-12T11:59:00.000Z',
					requestedBy: { subject: 'subject-administrator' },
					resource: 'STUDY-A1',
					role: 'viewer',
					state: 'pending',
				},
			],
		});
		assert.deepEqual(stand.reads.at(-1)?.values, [ISSUER, 'subject-ana', new Date(NOW), false, null, 2]);
	});

	test('names no next page once the store gives no more than the page holds', async (context) => {
		const stand = standUp(context, { requestRows: [row(REQUEST_ID)] });

		const listed = await listRequests(stand, 'administrator', `?cursor=${cursorAfterRequest(UNKNOWN_GRANT_ID)}`);

		assert.equal(parsed(listed)['next'], null);
		assert.deepEqual(stand.reads.at(-1)?.values, [
			ISSUER,
			'subject-administrator',
			new Date(NOW),
			true,
			UNKNOWN_GRANT_ID,
			101,
		]);
	});

	test('refuses a query it cannot read before reading the store', async (context) => {
		const stand = standUp(context);

		const refused = await listRequests(stand, 'ana', '?state=pending');

		assert.deepEqual(outcomeOf(refused), [400, 'unreadableQuery']);
		assert.deepEqual(stand.reads, []);
	});
});

const change = (stand: Stand, caller: string, body: unknown, grantId: string = GRANT_ID) =>
	send(stand, caller, {
		body,
		method: 'PATCH',
		url: `/admin/grants/${encodeURIComponent(grantId)}`,
	});

// Cy's accepted viewer grant on STUDY-A1, ending in a day.
const ENDING: StoredGrant = {
	...PENDING,
	decision: {
		capabilities: VIEWER.capabilities,
		decidedAt: new Date(NOW - 30_000),
		decision: 'accepted',
	},
	expiresAt: new Date(NOW + 24 * HOUR_MS),
};

suite('changing a grant', () => {
	test("moves a grant's end later for a counted owner of its resource, its resource locked first, recording grant.extension at info, and answers 200 with the grant", async (context) => {
		const stand = standUp(context, { grant: ENDING });

		const changed = await change(stand, 'ana', {
			expiresAt: new Date(NOW + 48 * HOUR_MS).toISOString(),
		});

		assert.equal(changed.statusCode, 200);
		assert.deepEqual(
			[parsed(changed)['kind'], parsed(changed)['expiresAt'], parsed(changed)['state']],
			['grant', '2026-11-14T12:00:00.000Z', 'accepted'],
		);
		assert.deepEqual(methodsCalled(stand), [
			'locateGrant',
			'readStanding',
			'readGrant',
			'findRole',
			'findPerson',
			'changeGrant',
		]);
		assert.equal((valuesOf(stand, 'readStanding') as readonly { lock: string }[])[0]?.lock, 'noKeyUpdate');
		assert.deepEqual(valuesOf(stand, 'findPerson'), ['subject-ana']);
		assert.deepEqual(valuesOf(stand, 'changeGrant'), [
			{
				expiresAt: new Date(NOW + 48 * HOUR_MS),
				grantId: GRANT_ID,
				roleId: 'role-viewer',
			},
		]);
		assert.deepEqual(eventData(stand), [
			{
				category: 'global.controlled',
				endAfter: '2026-11-14T12:00:00.000Z',
				endBefore: '2026-11-13T12:00:00.000Z',
				grantId: GRANT_ID,
				granteeId: 'subject-cy',
				resourceId: 'STUDY-A1',
				result: 'succeeded',
				sourceIp: '127.0.0.1',
				type: 'grant.extension',
			},
		]);
		assert.deepEqual(severities(stand), [['grant.extension', 'info']]);
	});

	test('records an end moved earlier as grant.reduction at warning, a removed one as grant.extension with no end after, and a role change as grant.roleChange, at warning when it widens, each naming the grant', async (context) => {
		const stand = standUp(context, { grant: ENDING });

		await change(stand, 'ana', {
			expiresAt: new Date(NOW + HOUR_MS).toISOString(),
		});
		await change(stand, 'ana', { expiresAt: null });
		await change(stand, 'ana', { role: 'submitter' });

		assert.deepEqual(
			stand.recorded.map(({ data, severity, type }) => [
				type,
				severity,
				type === 'grant.roleChange' ? data['roleBefore'] : data['endBefore'],
				type === 'grant.roleChange' ? data['roleAfter'] : data['endAfter'],
				data['grantId'],
				data['granteeId'],
			]),
			[
				[
					'grant.reduction',
					'warning',
					'2026-11-13T12:00:00.000Z',
					'2026-11-12T13:00:00.000Z',
					GRANT_ID,
					'subject-cy',
				],
				['grant.extension', 'info', '2026-11-13T12:00:00.000Z', null, GRANT_ID, 'subject-cy'],
				['grant.roleChange', 'warning', 'viewer', 'submitter', GRANT_ID, undefined],
			],
		);
		assert.deepEqual(eventData(stand).at(-1), {
			category: 'global.controlled',
			grantId: GRANT_ID,
			resourceId: 'STUDY-A1',
			result: 'succeeded',
			roleAfter: 'submitter',
			roleBefore: 'viewer',
			sourceIp: '127.0.0.1',
			type: 'grant.roleChange',
		});
	});

	test('writes nothing and records nothing for a change keeping the end and the role', async (context) => {
		const stand = standUp(context, { grant: ENDING });

		const kept = await change(stand, 'ana', { role: 'viewer' });

		assert.equal(kept.statusCode, 200);
		assert.equal(methodsCalled(stand).includes('changeGrant'), false);
		assert.deepEqual(stand.recorded, []);
	});

	test("answers anyone without authority on the grant's resource, an unknown or malformed id, and a grant on a retired resource 404 grantNotFound alike, recording the refusal of authority apart", async (context) => {
		const stand = standUp(context, { grant: ENDING });
		const retired = standUp(context, {
			grant: ENDING,
			standings: {
				'subject-ana': { countedOwner: true, holder: true, retired: true },
			},
		});
		const later = { expiresAt: new Date(NOW + 48 * HOUR_MS).toISOString() };

		const answers = [
			await change(stand, 'cy', later),
			await change(stand, 'ana', later, UNKNOWN_GRANT_ID),
			await change(stand, 'ana', later, 'not-a-uuid'),
			await change(retired, 'ana', later),
		];

		answers.forEach((answered) => {
			assert.deepEqual(outcomeOf(answered), [404, 'grantNotFound']);
			assert.equal(answered.body, answers[0]?.body);
		});
		assert.deepEqual(
			eventData(stand).map(({ grantId, reason, type }) => [type, grantId, reason]),
			[
				['grant.extension', GRANT_ID, 'noAuthorityOnResource'],
				['grant.extension', undefined, 'grantNotFound'],
				['grant.extension', undefined, 'grantNotFound'],
			],
		);
		assert.equal(methodsCalled(stand).includes('changeGrant'), false);
	});

	test("lets a platform administrator reduce a consumer grant and refuses their extension of it 403, judging the change's rules first", async (context) => {
		const stand = standUp(context, { grant: ENDING });

		const answers = [
			await change(stand, 'administrator', {
				expiresAt: new Date(NOW + HOUR_MS).toISOString(),
			}),
			await change(stand, 'administrator', {
				expiresAt: new Date(NOW + 48 * HOUR_MS).toISOString(),
			}),
			await change(stand, 'administrator', { role: 'owner' }),
		];

		assert.deepEqual(answers.map(outcomeOf), [
			[200, undefined],
			[403, 'administratorGrantsNoConsumerAccess'],
			[422, 'roleInOtherPlane'],
		]);
	});

	test('refuses a revoked grant 409 doesNotHold, a replaced one 409 grantReplaced, a role the instance does not define 422, and a body in any media type but a merge patch 415', async (context) => {
		const later = { expiresAt: new Date(NOW + 48 * HOUR_MS).toISOString() };
		const revoked = standUp(context, {
			grant: { ...ENDING, revokedAt: new Date(NOW - 1000) },
		});
		const replaced = standUp(context, {
			grant: {
				...ENDING,
				endedAt: new Date(NOW - 1000),
				expiresAt: new Date(NOW - 2000),
			},
		});
		const stand = standUp(context, { grant: ENDING });

		const answers = [
			await change(revoked, 'ana', later),
			await change(replaced, 'ana', later),
			await change(stand, 'ana', { role: 'reviewer' }),
			await stand.server.inject({
				headers: {
					authorization: 'Bearer ana',
					'content-type': 'application/json',
				},
				method: 'PATCH',
				payload: JSON.stringify(later),
				url: `/admin/grants/${GRANT_ID}`,
			}),
		];

		assert.deepEqual(answers.map(outcomeOf), [
			[409, 'doesNotHold'],
			[409, 'grantReplaced'],
			[422, 'unknownRole'],
			[415, 'unsupportedMediaType'],
		]);
	});

	test("holds a self-grant's end within the longest self-grant life of its request", async (context) => {
		const stand = standUp(context, {
			grant: {
				...ENDING,
				expiresAt: new Date(NOW + 2 * HOUR_MS),
				selfGrant: true,
				selfGrantSince: new Date(NOW - 2 * HOUR_MS),
			},
		});

		const answers = [
			await change(stand, 'ana', {
				expiresAt: new Date(NOW + 23 * HOUR_MS).toISOString(),
			}),
			await change(stand, 'ana', { expiresAt: null }),
		];

		assert.deepEqual(answers.map(outcomeOf), [
			[422, 'selfGrantTooLong'],
			[422, 'selfGrantExpiryRequired'],
		]);
	});

	test("refuses a platform administrator extending or widening a grant they hold 403 selfWideningNotPermitted, the holder found by the caller's person, and lets them end it earlier", async (context) => {
		const submitting = { ...ENDING, role: 'submitter' };
		const stand = standUp(context, {
			grant: {
				...submitting,
				holderSubject: 'subject-administrator',
				holderUserId: 'person-administrator',
			},
		});
		const elsewhere = standUp(context, {
			grant: {
				...submitting,
				holderSubject: 'subject-administrator',
				holderUserId: 'person-elsewhere',
			},
		});
		const later = { expiresAt: new Date(NOW + 48 * HOUR_MS).toISOString() };

		const answers = [
			await change(stand, 'administrator', later),
			await change(stand, 'administrator', { expiresAt: null }),
			await change(stand, 'administrator', { role: 'viewer' }),
			await change(stand, 'administrator', {
				expiresAt: new Date(NOW + HOUR_MS).toISOString(),
			}),
			await change(elsewhere, 'administrator', later),
		];

		assert.deepEqual(answers.map(outcomeOf), [
			[403, 'selfWideningNotPermitted'],
			[403, 'selfWideningNotPermitted'],
			[403, 'selfWideningNotPermitted'],
			[200, undefined],
			[200, undefined],
		]);
		assert.deepEqual(valuesOf(stand, 'findPerson'), ['subject-administrator']);
	});

	test("holds a counted owner extending a grant they hold to an expiry within the longest self-grant life of the change's instant", async (context) => {
		const stand = standUp(context, {
			grant: {
				...ENDING,
				expiresAt: new Date(NOW + 2 * HOUR_MS),
				holderSubject: 'subject-ana',
				holderUserId: 'person-ana',
			},
		});

		const answers = [
			await change(stand, 'ana', {
				expiresAt: new Date(NOW + 24 * HOUR_MS + 1000).toISOString(),
			}),
			await change(stand, 'ana', { expiresAt: null }),
			await change(stand, 'ana', {
				expiresAt: new Date(NOW + 24 * HOUR_MS).toISOString(),
			}),
		];

		assert.deepEqual(answers.map(outcomeOf), [
			[422, 'selfGrantTooLong'],
			[422, 'selfGrantExpiryRequired'],
			[200, undefined],
		]);
	});
});
