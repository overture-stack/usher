import assert from 'node:assert/strict';
import { suite, test, type TestContext } from 'node:test';

import type { FastifyInstance } from 'fastify';
import pg from 'pg';

import type { AuditEvent, TransactionOptions } from '../eventLog/index.js';
import { createServer } from '../http/index.js';
import { createCategoryRoutes } from './createCategoryRoutes.js';
import type { CategoryStore } from './types.js';

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);

const ISSUER = 'https://auth.example.org/realms/usher';

/** A global category as the fake store holds one: its bare name, its `categories.id`, and its description. */
interface Global {
	description: string | null;
	id: string;
}

/** What the fake store and the fake administrator status hold for one test. */
interface World {
	/** Whether any administrator has accepted yet. */
	anyAdministrator: boolean;

	/** The subjects who are platform administrators. */
	administrators: readonly string[];

	/** The global categories, by bare name. */
	globals: Readonly<Record<string, Global>>;

	/** The subjects counted as owners of at least one resource. */
	owners: readonly string[];
}

interface Stand {
	/** The store's methods, in the order each was called, with the values each was given. */
	calls: { method: keyof CategoryStore; values: readonly unknown[] }[];

	/** The statements read outside a transaction. */
	reads: { text: string; values: readonly unknown[] }[];

	recorded: AuditEvent[];
	server: FastifyInstance;

	/** How many transactions the operations began. */
	transactions: { count: number; options: (TransactionOptions | undefined)[] };

	/** The globals as the store holds them after the calls, by bare name. */
	globals: Record<string, Global>;
}

const WORLD: World = {
	anyAdministrator: true,
	administrators: ['subject-ana'],
	globals: {
		controlled: { description: 'Controlled records', id: 'category-controlled' },
		unmarked: { description: null, id: 'category-unmarked' },
	},
	owners: ['subject-owner'],
};

const tokenOf = (subject: string, roles: readonly string[], departures: Readonly<Record<string, unknown>> = {}) => ({
	claims: {
		aud: ['usher-management'],
		azp: 'usher-ui',
		exp: Math.floor(NOW / 1000) + 300,
		iat: Math.floor(NOW / 1000) - 10,
		iss: ISSUER,
		realm_access: { roles },
		sub: subject,
		typ: 'Bearer',
		...departures,
	},
	header: { alg: 'RS256', typ: 'JWT' },
	kind: 'verified' as const,
});

// The bearer credential each caller sends, by the caller's name.
const TOKENS: Readonly<Record<string, ReturnType<typeof tokenOf>>> = {
	ana: tokenOf('subject-ana', []),
	bo: tokenOf('subject-bo', []),
	owner: tokenOf('subject-owner', []),
	service: tokenOf('service-1', ['usher-service-account'], { client_id: 'lyric-svc' }),
};

const standUp = (context: TestContext, world: Partial<World> = {}): Stand => {
	const known: World = { ...WORLD, ...world };
	const globals: Record<string, Global> = { ...known.globals };
	const stand = {
		calls: [] as Stand['calls'],
		globals,
		reads: [] as Stand['reads'],
		recorded: [] as AuditEvent[],
		transactions: { count: 0, options: [] as (TransactionOptions | undefined)[] },
	};
	// The spelling a global category is stored under, for a name matching it in any letter case.
	const storedSpelling = (name: string): string | undefined =>
		Object.keys(globals).find((stored) => stored.toLowerCase() === name.toLowerCase());
	const fakeStore = (): CategoryStore => ({
		findGlobal: async (name) => {
			stand.calls.push({ method: 'findGlobal', values: [name] });
			const stored = storedSpelling(name);
			const found = stored === undefined ? undefined : globals[stored];
			return found === undefined || stored === undefined ? undefined : { ...found, name: stored };
		},
		insertGlobal: async ({ description, name }) => {
			stand.calls.push({ method: 'insertGlobal', values: [name, description] });
			const existing = storedSpelling(name);
			if (existing !== undefined) {
				return { existing, kind: 'taken' };
			}
			globals[name] = { description, id: `category-${name}` };
			return { id: `category-${name}`, kind: 'inserted' };
		},
		setDescription: async (id, description) => {
			stand.calls.push({ method: 'setDescription', values: [id, description] });
			const name = Object.keys(globals).find((candidate) => globals[candidate]?.id === id);
			if (name !== undefined) {
				globals[name] = { description, id };
			}
		},
	});
	const server = createServer({
		isLive: () => true,
		isReady: async () => true,
		trustedProxies: [],
	});
	createCategoryRoutes(
		{
			categoryStoreOf: () => fakeStore(),
			settings: {
				clock: { now: () => NOW },
				databaseSchema: 'usher',
				identityProviderIssuer: ISSUER,
			},
			store: {
				query: async <Row extends pg.QueryResultRow>(
					text: string,
					values: readonly unknown[] = [],
				): Promise<pg.QueryResult<Row>> => {
					stand.reads.push({ text, values });
					const rows: readonly unknown[] = text.includes('AS "owns"')
						? [{ owns: known.owners.includes(String(values[1])) }]
						: Object.keys(globals)
								.toSorted()
								.map((name) => ({ description: globals[name]?.description ?? null, name }));
					return { rows } as unknown as pg.QueryResult<Row>;
				},
			},
			trail: {
				inTransaction: async (_actor, work, options?: TransactionOptions) => {
					stand.transactions.count += 1;
					stand.transactions.options.push(options);
					const recorded: AuditEvent[] = [];
					const result = await work({
						connection: Object.assign(new pg.Client(), { release: () => undefined }),
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
				administrator: known.administrators.includes(subject),
				anyAdministrator: known.anyAdministrator,
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
	{ body, method, url }: { body?: unknown; method: 'GET' | 'PATCH' | 'POST'; url: string },
) =>
	server.inject({
		headers: {
			authorization: `Bearer ${caller}`,
			...(body === undefined
				? {}
				: { 'content-type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json' }),
		},
		method,
		url,
		...(body === undefined ? {} : { payload: JSON.stringify(body) }),
	});

const register = (stand: Stand, caller: string, body: unknown) =>
	send(stand, caller, { body, method: 'POST', url: '/admin/categories' });

const update = (stand: Stand, caller: string, scopedName: string, body: unknown) =>
	send(stand, caller, { body, method: 'PATCH', url: `/admin/categories/${scopedName}` });

const list = (stand: Stand, caller: string) => send(stand, caller, { method: 'GET', url: '/admin/categories' });

const codeOf = (answer: { body: string }): unknown => Reflect.get(Object(JSON.parse(answer.body)), 'code');

const eventsOf = (stand: Stand): readonly unknown[] =>
	stand.recorded.map(({ data, severity, type }) => ({ data, severity, type }));

const writesOf = (stand: Stand): readonly string[] =>
	stand.calls.filter(({ method }) => method !== 'findGlobal').map(({ method }) => method);

suite('listing the global categories', () => {
	test('lists every global category to a platform administrator, ordered by name, each with its scoped name, the unmarked one included', async (context) => {
		const stand = standUp(context);
		const answer = await list(stand, 'ana');
		assert.equal(answer.statusCode, 200);
		assert.deepEqual(JSON.parse(answer.body), {
			categories: [
				{ description: 'Controlled records', name: 'global.controlled' },
				{ description: null, name: 'global.unmarked' },
			],
		});
		assert.deepEqual(eventsOf(stand), []);
	});

	test('lists the global categories to a principal who owns at least one resource, checking the ownership in one read', async (context) => {
		const stand = standUp(context);
		const answer = await list(stand, 'owner');
		assert.equal(answer.statusCode, 200);
		assert.equal(stand.reads.length, 2);
		assert.deepEqual(stand.reads[0]?.values, [ISSUER, 'subject-owner', new Date(NOW)]);
	});

	test('refuses a principal neither administering the platform nor owning a resource 403 ownersAndAdministratorsOnly', async (context) => {
		const stand = standUp(context);
		const answer = await list(stand, 'bo');
		assert.equal(answer.statusCode, 403);
		assert.equal(codeOf(answer), 'ownersAndAdministratorsOnly');
		assert.deepEqual(eventsOf(stand), []);
	});

	test('refuses a service account 403 serviceAccountNotPermitted before any read', async (context) => {
		const stand = standUp(context);
		const answer = await list(stand, 'service');
		assert.equal(answer.statusCode, 403);
		assert.equal(codeOf(answer), 'serviceAccountNotPermitted');
		assert.equal(stand.reads.length, 0);
	});

	test('refuses every caller 403 noAdministratorYet while Usher has no administrator', async (context) => {
		const stand = standUp(context, { anyAdministrator: false });
		const answer = await list(stand, 'owner');
		assert.equal(answer.statusCode, 403);
		assert.equal(codeOf(answer), 'noAdministratorYet');
	});
});

suite('registering a global category', () => {
	test('registers a category by its name alone, answering 201 with its scoped name and a null description, and records category.creation at warning', async (context) => {
		const stand = standUp(context);
		const answer = await register(stand, 'ana', { name: 'community-governed' });
		assert.equal(answer.statusCode, 201);
		assert.deepEqual(JSON.parse(answer.body), { description: null, name: 'global.community-governed' });
		assert.equal(stand.transactions.count, 1);
		assert.deepEqual(eventsOf(stand), [
			{
				data: {
					category: 'global.community-governed',
					description: null,
					result: 'succeeded',
					sourceIp: '127.0.0.1',
				},
				severity: 'warning',
				type: 'category.creation',
			},
		]);
	});

	test('registers a category with its description, answering the description it was given', async (context) => {
		const stand = standUp(context);
		const answer = await register(stand, 'ana', { description: 'Records under review', name: 'review' });
		assert.equal(answer.statusCode, 201);
		assert.deepEqual(JSON.parse(answer.body), { description: 'Records under review', name: 'global.review' });
	});

	test('refuses everyone but an administrator 403 administratorOnly before the body is read, the body invalid or not', async (context) => {
		const stand = standUp(context);
		const answer = await register(stand, 'owner', { name: 'a.b' });
		assert.equal(answer.statusCode, 403);
		assert.equal(codeOf(answer), 'administratorOnly');
		assert.equal(stand.transactions.count, 0);
	});

	test('refuses a body that is not a name and description 400, naming no value sent', async (context) => {
		const stand = standUp(context);
		const answers = await Promise.all(
			[
				{ description: 'x' },
				{ name: 7 },
				{ description: 7, name: 'review' },
				{ extra: true, name: 'review' },
			].map((body) => register(stand, 'ana', body)),
		);
		assert.deepEqual(
			answers.map(({ statusCode }) => statusCode),
			[400, 400, 400, 400],
		);
		assert.equal(stand.transactions.count, 0);
	});

	test('refuses a name empty, holding a character outside letters, digits, underscores and hyphens, or reserved in any letter case 422 invalidCategoryName, writing nothing', async (context) => {
		const stand = standUp(context);
		const names = ['', 'a.b', 'a b', 'résumé', 'unmarked', 'Unmarked', 'UNMARKED', '__proto__', '__PROTO__'];
		const answers = await Promise.all(names.map((name) => register(stand, 'ana', { name })));
		assert.deepEqual(
			answers.map(({ statusCode }) => statusCode),
			names.map(() => 422),
		);
		assert.deepEqual(
			answers.map((answer) => codeOf(answer)),
			names.map(() => 'invalidCategoryName'),
		);
		assert.equal(stand.transactions.count, 0);
	});

	test('accepts the characters letters, digits, underscores and hyphens allow, and keeps the name in the letter case it was registered in', async (context) => {
		const stand = standUp(context, { globals: {} });
		const answer = await register(stand, 'ana', { name: 'Access_Tier-2' });
		assert.equal(answer.statusCode, 201);
		assert.equal(JSON.parse(answer.body).name, 'global.Access_Tier-2');
	});

	test('refuses a name a global category already holds 409 alreadyExists, writing nothing and recording nothing', async (context) => {
		const stand = standUp(context);
		const answer = await register(stand, 'ana', { name: 'controlled' });
		assert.equal(answer.statusCode, 409);
		assert.equal(codeOf(answer), 'alreadyExists');
		assert.deepEqual(writesOf(stand), ['insertGlobal']);
		assert.deepEqual(eventsOf(stand), [
			{
				data: {
					category: 'global.controlled',
					reason: 'alreadyExists',
					result: 'denied',
					sourceIp: '127.0.0.1',
				},
				severity: 'warning',
				type: 'category.creation',
			},
		]);
		assert.deepEqual(stand.globals['controlled'], { description: 'Controlled records', id: 'category-controlled' });
	});

	test('refuses a name a global category holds in another letter case 409 alreadyExists, naming the spelling registered', async (context) => {
		const stand = standUp(context);
		const answer = await register(stand, 'ana', { name: 'CONTROLLED' });
		assert.equal(answer.statusCode, 409);
		assert.equal(codeOf(answer), 'alreadyExists');
		assert.match(String(Reflect.get(Object(JSON.parse(answer.body)), 'detail')), /global\.controlled/u);
		assert.deepEqual(Object.keys(stand.globals).toSorted(), ['controlled', 'unmarked']);
	});
});

suite('updating a global category description', () => {
	test('sets a description by merge patch, answering 200 with the category as it stands, and records category.descriptionChange at info', async (context) => {
		const stand = standUp(context);
		const answer = await update(stand, 'ana', 'global.controlled', { description: 'Records under review' });
		assert.equal(answer.statusCode, 200);
		assert.deepEqual(JSON.parse(answer.body), { description: 'Records under review', name: 'global.controlled' });
		assert.deepEqual(eventsOf(stand), [
			{
				data: {
					category: 'global.controlled',
					descriptionAfter: 'Records under review',
					descriptionBefore: 'Controlled records',
					result: 'succeeded',
					sourceIp: '127.0.0.1',
				},
				severity: 'info',
				type: 'category.descriptionChange',
			},
		]);
	});

	test('finds the category by a scoped name in any letter case, answering and recording it under the spelling registered', async (context) => {
		const stand = standUp(context);
		const answer = await update(stand, 'ana', 'global.CONTROLLED', { description: 'Records under review' });
		assert.equal(answer.statusCode, 200);
		assert.deepEqual(JSON.parse(answer.body), { description: 'Records under review', name: 'global.controlled' });
		assert.deepEqual(
			stand.recorded.map(({ data }) => Reflect.get(Object(data), 'category')),
			['global.controlled'],
		);
	});

	test('clears a description when the merge patch sends null, answering a null description', async (context) => {
		const stand = standUp(context);
		const answer = await update(stand, 'ana', 'global.controlled', { description: null });
		assert.equal(answer.statusCode, 200);
		assert.deepEqual(JSON.parse(answer.body), { description: null, name: 'global.controlled' });
		assert.equal(stand.globals['controlled']?.description, null);
	});

	test('answers 200 with no write and no event when the patch changes nothing, an empty patch included', async (context) => {
		const stand = standUp(context);
		const same = await update(stand, 'ana', 'global.controlled', { description: 'Controlled records' });
		const empty = await update(stand, 'ana', 'global.controlled', {});
		assert.equal(same.statusCode, 200);
		assert.equal(empty.statusCode, 200);
		assert.deepEqual(JSON.parse(empty.body), { description: 'Controlled records', name: 'global.controlled' });
		assert.deepEqual(writesOf(stand), []);
		assert.deepEqual(eventsOf(stand), []);
	});

	test('refuses everyone but an administrator 403 administratorOnly, before the body is read', async (context) => {
		const stand = standUp(context);
		const answer = await update(stand, 'owner', 'global.controlled', { name: 'renamed' });
		assert.equal(answer.statusCode, 403);
		assert.equal(codeOf(answer), 'administratorOnly');
		assert.equal(stand.transactions.count, 0);
	});

	test('refuses a description that is neither a string nor null 400, before a member other than description is judged 422', async (context) => {
		const stand = standUp(context);
		const answers = await Promise.all([
			update(stand, 'ana', 'global.controlled', { description: 3 }),
			update(stand, 'ana', 'global.controlled', { description: 3, name: 'renamed' }),
		]);
		assert.deepEqual(
			answers.map(({ statusCode }) => statusCode),
			[400, 400],
		);
		assert.equal(stand.transactions.count, 0);
	});

	test('refuses a patch naming a member other than description 422 memberNotSettable, naming name in particular', async (context) => {
		const stand = standUp(context);
		const renamed = await update(stand, 'ana', 'global.controlled', { name: 'renamed' });
		const unknown = await update(stand, 'ana', 'global.controlled', { colour: 'red' });
		assert.equal(renamed.statusCode, 422);
		assert.equal(codeOf(renamed), 'memberNotSettable');
		assert.equal(unknown.statusCode, 422);
		assert.equal(stand.transactions.count, 0);
	});

	test('refuses a scoped name no global category holds 404 categoryNotFound: a resource scope, a bare name, or an unknown global', async (context) => {
		const stand = standUp(context);
		const answers = await Promise.all([
			update(stand, 'ana', 'resource.pilot', { description: 'x' }),
			update(stand, 'ana', 'controlled', { description: 'x' }),
			update(stand, 'ana', 'global.nobody', { description: 'x' }),
		]);
		assert.deepEqual(
			answers.map(({ statusCode }) => statusCode),
			[404, 404, 404],
		);
		assert.deepEqual(
			answers.map((answer) => codeOf(answer)),
			['categoryNotFound', 'categoryNotFound', 'categoryNotFound'],
		);
		assert.deepEqual(writesOf(stand), []);
	});

	test('answers a body with a bad description 400 before an unknown category 404, the order of its checks', async (context) => {
		const stand = standUp(context);
		const answer = await update(stand, 'ana', 'global.nobody', { description: 3 });
		assert.equal(answer.statusCode, 400);
	});
});
