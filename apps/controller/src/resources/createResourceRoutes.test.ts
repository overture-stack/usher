import assert from 'node:assert/strict';
import { suite, test, type TestContext } from 'node:test';

import type { FastifyInstance } from 'fastify';

import type { AddressResolution } from '../directory/index.js';
import type { AuditEvent } from '../eventLog/index.js';
import { createServer } from '../http/index.js';
import { createResourceRoutes } from './createResourceRoutes.js';

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);

const SECONDS = Math.floor(NOW / 1000);

const ISSUER = 'https://auth.example.org/realms/usher';

const APPLICATION_ID = '0b8f7f43-2b4c-4b55-9a39-6c1b7f6f0a11';

interface Stand {
	/** Each address the directory was asked to resolve, as asked. */
	lookups: string[];

	/** Each statement the resource operations sent the store outside a transaction. */
	reads: string[];

	recorded: AuditEvent[];
	server: FastifyInstance;

	/** How many transactions the resource operations began, as they began. */
	transactions: { count: number };
}

/** The fake directory: the subjects it holds by lower-case address, or how it fails. */
type DirectoryWorld = Readonly<Record<string, string>> | 'unavailable' | 'unconfigured';

// The subject of the one account holding each address verified, by the address in lower case.
const ACCOUNTS: Readonly<Record<string, string>> = {
	'ana@example.org': 'subject-ana',
	'bo@example.org': 'subject-bo',
	'root@example.org': 'subject-administrator',
};

// The resource routes over a store and a trail that answer nothing, each counting what reaches it,
// a directory answering from the world given, and a verifier admitting one platform administrator's
// token.
const standUp = (context: TestContext, directory: DirectoryWorld = ACCOUNTS): Stand => {
	const stand = {
		lookups: [] as string[],
		reads: [] as string[],
		recorded: [] as AuditEvent[],
		transactions: { count: 0 },
	};
	const server = createServer({
		isLive: () => true,
		isReady: async () => true,
		trustedProxies: [],
	});
	createResourceRoutes(
		{
			directory: {
				resolveAddress: async (address): Promise<AddressResolution> => {
					stand.lookups.push(address);
					if (typeof directory === 'string') {
						return { kind: directory };
					}
					const subject = directory[address.toLowerCase()];
					return subject === undefined ? { kind: 'unheld' } : { kind: 'resolved', subject };
				},
			},
			settings: {
				clock: { now: () => NOW },
				grantAutoAccept: false,
				databaseSchema: 'usher',
				identityProviderIssuer: ISSUER,
			},
			store: {
				query: async (text) => {
					stand.reads.push(text);
					throw new Error('the store answers nothing here');
				},
			},
			trail: {
				inTransaction: async () => {
					stand.transactions.count += 1;
					throw new Error('the store answers nothing here');
				},
			},
		},
		{
			administratorStatus: async ({ subject }) => ({
				administrator: subject === 'subject-administrator',
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
				verify: async () => ({
					claims: {
						aud: ['usher-management'],
						azp: 'usher-ui',
						exp: SECONDS + 300,
						iat: SECONDS - 10,
						iss: ISSUER,
						sub: 'subject-administrator',
						typ: 'Bearer',
					},
					header: { alg: 'RS256', typ: 'JWT' },
					kind: 'verified',
				}),
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

const codeOf = (body: string): unknown => {
	const parsed: unknown = JSON.parse(body);
	return typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'code') : undefined;
};

suite('the resource routes, for a path parameter holding text that cannot be stored', () => {
	test('refuses each path parameter holding a NUL 400 unrepresentableText, reading nothing from the store and beginning no transaction', async (context) => {
		const stand = standUp(context);
		const requests = [
			{ method: 'GET', url: '/admin/resources/STUDY%00A1' },
			{
				method: 'PUT',
				url: `/admin/resources/STUDY%00A1/applications/${APPLICATION_ID}`,
			},
			{ method: 'PUT', url: '/admin/resources/STUDY-A1/applications/a%00b' },
			{
				method: 'DELETE',
				url: `/admin/resources/STUDY%00A1/applications/${APPLICATION_ID}`,
			},
			{
				method: 'DELETE',
				url: '/admin/resources/STUDY-A1/applications/a%00b',
			},
		] as const;

		const answers = await Promise.all(
			requests.map(({ method, url }) =>
				stand.server.inject({
					headers: { authorization: 'Bearer administrator' },
					method,
					url,
				}),
			),
		);

		assert.deepEqual(
			answers.map(({ body, statusCode }) => [statusCode, codeOf(body)]),
			requests.map(() => [400, 'unrepresentableText']),
		);
		assert.deepEqual(stand.reads, []);
		assert.equal(stand.transactions.count, 0);
	});

	test('records each refused change to a served set denied, naming nothing, and records nothing failed nor anything for a read', async (context) => {
		const stand = standUp(context);

		await stand.server.inject({
			headers: { authorization: 'Bearer administrator' },
			method: 'GET',
			url: '/admin/resources/STUDY%00A1',
		});
		await stand.server.inject({
			headers: { authorization: 'Bearer administrator' },
			method: 'PUT',
			url: `/admin/resources/STUDY%00A1/applications/${APPLICATION_ID}`,
		});
		await stand.server.inject({
			headers: { authorization: 'Bearer administrator' },
			method: 'DELETE',
			url: '/admin/resources/STUDY-A1/applications/a%00b',
		});

		assert.deepEqual(
			stand.recorded.map(({ data, severity, type }) => ({
				data,
				severity,
				type,
			})),
			[
				{
					data: {
						reason: 'unrepresentableText',
						result: 'denied',
						sourceIp: '127.0.0.1',
					},
					severity: 'warning',
					type: 'application.servedResourcesChange',
				},
				{
					data: {
						reason: 'unrepresentableText',
						result: 'denied',
						sourceIp: '127.0.0.1',
					},
					severity: 'warning',
					type: 'application.servedResourcesChange',
				},
			],
		);
		assert.deepEqual(stand.reads, []);
	});
});

// Registers STUDY-N1 at the grant level as the platform administrator, naming the owners given.
const register = ({ server }: Stand, owners: readonly Readonly<Record<string, string>>[]) =>
	server.inject({
		headers: {
			authorization: 'Bearer administrator',
			'content-type': 'application/json',
		},
		method: 'POST',
		payload: JSON.stringify({
			accessLevel: 'grant',
			displayName: 'Owned study',
			externalId: 'STUDY-N1',
			owners,
		}),
		url: '/admin/resources',
	});

// The events recorded, each by its data, its severity and its type.
const eventsOf = ({ recorded }: Stand) => recorded.map(({ data, severity, type }) => ({ data, severity, type }));

suite('the resource routes, for a registration naming its owners', () => {
	test('resolves each owner named by address in turn, as given, before its transaction begins', async (context) => {
		const stand = standUp(context);

		const answer = await register(stand, [
			{ email: 'Bo@Example.org' },
			{ subject: 'subject-cy' },
			{ email: 'ana@example.org' },
		]);

		assert.deepEqual(stand.lookups, ['Bo@Example.org', 'ana@example.org']);
		assert.equal(stand.transactions.count, 1);
		assert.deepEqual([answer.statusCode, codeOf(answer.body)], [503, 'storeUnavailable']);
	});

	test('refuses an owner whose address no single account holds 404 holderNotFound, beginning no transaction, and records it denied', async (context) => {
		const stand = standUp(context);

		const answer = await register(stand, [{ email: 'bo@example.org' }, { email: 'nobody@example.org' }]);

		assert.deepEqual([answer.statusCode, codeOf(answer.body)], [404, 'holderNotFound']);
		assert.equal(stand.transactions.count, 0);
		assert.deepEqual(eventsOf(stand), [
			{
				data: {
					reason: 'holderNotFound',
					result: 'denied',
					sourceIp: '127.0.0.1',
				},
				severity: 'warning',
				type: 'resource.registration',
			},
		]);
	});

	test('refuses an owner whose address resolves to the caller 403 administratorSelfOwnership, beginning no transaction', async (context) => {
		const stand = standUp(context);

		const answer = await register(stand, [{ email: 'ROOT@example.org' }]);

		assert.deepEqual([answer.statusCode, codeOf(answer.body)], [403, 'administratorSelfOwnership']);
		assert.equal(stand.transactions.count, 0);
	});

	test('refuses one person named twice once addresses are resolved, by a subject and an address or by two addresses, 422 ownerNamedTwice', async (context) => {
		const stand = standUp(context, {
			...ACCOUNTS,
			'ana.alias@example.org': 'subject-ana',
		});

		const answers = [
			await register(stand, [{ subject: 'subject-ana' }, { email: 'ana@example.org' }]),
			await register(stand, [{ email: 'ana.alias@example.org' }, { email: 'ana@example.org' }]),
		];

		assert.deepEqual(
			answers.map(({ body, statusCode }) => [statusCode, codeOf(body)]),
			[
				[422, 'ownerNamedTwice'],
				[422, 'ownerNamedTwice'],
			],
		);
		assert.equal(stand.transactions.count, 0);
	});

	test('answers 503 directoryNotConfigured with no directory configured, telling the caller to name the owner by subject, and records it failed at warning', async (context) => {
		const stand = standUp(context, 'unconfigured');

		const answer = await register(stand, [{ subject: 'subject-ana' }, { email: 'bo@example.org' }]);

		assert.deepEqual([answer.statusCode, codeOf(answer.body)], [503, 'directoryNotConfigured']);
		assert.equal(answer.headers['retry-after'], undefined);
		assert.equal(
			Reflect.get(JSON.parse(answer.body) as object, 'detail'),
			'Addresses cannot be resolved without a configured directory, which the variables USHER_DIRECTORY_URL, USHER_DIRECTORY_REALM, USHER_DIRECTORY_CLIENT_ID, USHER_DIRECTORY_CLIENT_SECRET configure; name the owner by subject.',
		);
		assert.equal(stand.transactions.count, 0);
		assert.deepEqual(
			eventsOf(stand).map(({ data, severity }) => [data['reason'], data['result'], severity]),
			[['directoryNotConfigured', 'failed', 'warning']],
		);
	});

	test('answers 503 directoryUnavailable while the directory cannot answer, beginning no transaction, and records it failed at error', async (context) => {
		const stand = standUp(context, 'unavailable');

		const answer = await register(stand, [{ email: 'bo@example.org' }]);

		assert.deepEqual([answer.statusCode, codeOf(answer.body)], [503, 'directoryUnavailable']);
		assert.equal(stand.transactions.count, 0);
		assert.deepEqual(
			eventsOf(stand).map(({ data, severity }) => [data['reason'], data['result'], severity]),
			[['directoryUnavailable', 'failed', 'error']],
		);
	});

	test('refuses a registration naming its caller an owner 403 administratorSelfOwnership, beginning no transaction, and records it denied for that reason', async (context) => {
		const stand = standUp(context);

		const answer = await stand.server.inject({
			headers: {
				authorization: 'Bearer administrator',
				'content-type': 'application/json',
			},
			method: 'POST',
			payload: JSON.stringify({
				accessLevel: 'grant',
				displayName: 'Self-owned study',
				externalId: 'STUDY-P1',
				owners: [{ subject: 'subject-administrator' }],
			}),
			url: '/admin/resources',
		});

		assert.deepEqual([answer.statusCode, codeOf(answer.body)], [403, 'administratorSelfOwnership']);
		assert.equal(stand.transactions.count, 0);
		assert.deepEqual(
			stand.recorded.map(({ data }) => data['reason']),
			['administratorSelfOwnership'],
		);
	});
});
