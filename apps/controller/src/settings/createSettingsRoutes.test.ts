import assert from 'node:assert/strict';
import { suite, test, type TestContext } from 'node:test';

import type { FastifyInstance } from 'fastify';
import pg from 'pg';

import type { AuditEvent } from '../eventLog/index.js';
import { createServer } from '../http/index.js';
import { createSettingsRoutes } from './createSettingsRoutes.js';
import { DEFAULT_GRANT_RULES } from './readGrantRules.js';

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

const SECONDS = Math.floor(NOW / 1000);

const ISSUER = 'https://auth.example.org/realms/usher';

/** The rows of the settings table a fake store answers with, by the name each row holds. */
interface World {
	/** Whether an administrator has accepted. */
	anyAdministrator: boolean;

	/** The stored value of the grant rules. */
	grantRules: unknown;

	/** The rows of the settings table, every setting's name and stored value, grant rules included. */
	settingRows: readonly { name: string; value: unknown }[];
}

// Every setting at its default, the fixed ones at the values a first run seeds.
const SEEDED_ROWS: readonly { name: string; value: unknown }[] = [
	{ name: 'backChannelLogout', value: true },
	{ name: 'eventSource', value: 'https://usher.example.org/controller' },
	{ name: 'firstUser', value: { realmRole: 'usher-first-user' } },
	{ name: 'grantAutoAccept', value: false },
	{ name: 'grantRateThreshold', value: { operationCount: 10, windowSeconds: 60 } },
	{ name: 'grantRules', value: DEFAULT_GRANT_RULES },
	{ name: 'heartbeatMilliseconds', value: 10000 },
	{ name: 'issuer', value: ISSUER },
	{ name: 'noticePageLimit', value: 500 },
	{ name: 'noticeRereadMilliseconds', value: 2000 },
	{ name: 'retentionGraceSeconds', value: 60 },
	{ name: 'retentionMarginSeconds', value: 30 },
	{ name: 'selfGrantMaximumLifetimeSeconds', value: 86400 },
	{ name: 'signInTokenMaximumLifetimeSeconds', value: 300 },
	{ name: 'streamLimitPerAudience', value: 64 },
	{ name: 'streamMaximumLifetimeSeconds', value: 900 },
	{ name: 'streamQueueLimit', value: 1000 },
	{ name: 'submitterCategory', value: 'global.unmarked' },
	{ name: 'tokenLifetimeSeconds', value: 300 },
];

const WORLD: World = {
	anyAdministrator: true,
	grantRules: DEFAULT_GRANT_RULES,
	settingRows: SEEDED_ROWS,
};

interface Stand {
	/** Every event the operations recorded. */
	recorded: AuditEvent[];

	/** The statements read outside a transaction, with their values. */
	reads: { text: string; values: readonly unknown[] }[];

	server: FastifyInstance;
}

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

// The callers: Ana holds the first-user role and is the administrator; Bo is a person; the service account is
// refused everywhere.
const TOKENS: Readonly<Record<string, ReturnType<typeof tokenOf>>> = {
	ana: tokenOf('subject-ana', ['usher-first-user']),
	bo: tokenOf('subject-bo', []),
	service: tokenOf('service-1', ['usher-first-user'], { client_id: 'lyric-svc' }),
};

const standUp = (context: TestContext, world: Partial<World> = {}): Stand => {
	const known: World = { ...WORLD, ...world };
	const stand: Stand = {
		recorded: [],
		reads: [],
		server: createServer({ isLive: () => true, isReady: async () => true, trustedProxies: [] }),
	};
	createSettingsRoutes(
		{
			administratorStoreOf: () => ({
				administratorExists: async () => known.anyAdministrator,
				appendNomination: async () => {
					throw new Error('not called by settings');
				},
				declineNomination: async () => {
					throw new Error('not called by settings');
				},
				findOrRecordPerson: async () => {
					throw new Error('not called by settings');
				},
				findPerson: async () => 'person-ana',
				insertAdministrator: async () => {
					throw new Error('not called by settings');
				},
				lockNominations: async () => undefined,
				readNomination: async () => undefined,
				revokeNomination: async () => {
					throw new Error('not called by settings');
				},
			}),
			settings: {
				backChannelLogoutAudiences: ['portal-ui'],
				clock: { now: () => NOW },
				databaseSchema: 'usher',
				identityProviderIssuer: ISSUER,
			},
			source: { reread: async () => undefined },
			store: {
				query: async <Row extends pg.QueryResultRow>(
					text: string,
					values: readonly unknown[] = [],
				): Promise<pg.QueryResult<Row>> => {
					stand.reads.push({ text, values });
					const rows = text.includes("name = 'grantRules'")
						? [{ value: known.grantRules }]
						: known.settingRows;
					return { rows } as unknown as pg.QueryResult<Row>;
				},
			},
			trail: {
				inTransaction: async () => {
					throw new Error('no change reached in these tests');
				},
			},
		},
		{
			administratorStatus: async ({ subject }) => ({
				administrator: subject === 'subject-ana',
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
		stand.server.route(route);
	});
	context.after(() => stand.server.close());
	return stand;
};

const send = (
	{ server }: Stand,
	caller: string,
	{
		body,
		contentType = 'application/json',
		method,
		url,
	}: { body?: unknown; contentType?: string; method: 'GET' | 'PATCH' | 'PUT'; url: string },
) =>
	server.inject({
		headers: {
			authorization: `Bearer ${caller}`,
			...(body === undefined ? {} : { 'content-type': contentType }),
		},
		method,
		url,
		...(body === undefined ? {} : { payload: JSON.stringify(body) }),
	});

const problemCodeOf = (body: string): unknown => (JSON.parse(body) as { code?: unknown }).code;

suite('the settings operations, for platform administrators alone', () => {
	test('answers an administrator every setting but the grant rules, the fixed ones included, recording no event', async (context) => {
		const stand = standUp(context);

		const answer = await send(stand, 'ana', { method: 'GET', url: '/admin/settings' });

		assert.equal(answer.statusCode, 200);
		assert.deepEqual(JSON.parse(answer.body), {
			backChannelLogout: true,
			eventSource: 'https://usher.example.org/controller',
			firstUser: { realmRole: 'usher-first-user' },
			grantAutoAccept: false,
			grantRateThreshold: { operationCount: 10, windowSeconds: 60 },
			heartbeatMilliseconds: 10000,
			issuer: ISSUER,
			noticePageLimit: 500,
			noticeRereadMilliseconds: 2000,
			retentionGraceSeconds: 60,
			retentionMarginSeconds: 30,
			selfGrantMaximumLifetimeSeconds: 86400,
			signInTokenMaximumLifetimeSeconds: 300,
			streamLimitPerAudience: 64,
			streamMaximumLifetimeSeconds: 900,
			streamQueueLimit: 1000,
			submitterCategory: 'global.unmarked',
			tokenLifetimeSeconds: 300,
		});
		assert.deepEqual(stand.recorded, []);
	});

	test('answers 503 storedSettingsInvalid, naming no value, when a stored setting breaks its rule', async (context) => {
		const stand = standUp(context, {
			settingRows: SEEDED_ROWS.map((row) => (row.name === 'noticePageLimit' ? { ...row, value: 0 } : row)),
		});

		const answer = await send(stand, 'ana', { method: 'GET', url: '/admin/settings' });

		assert.equal(answer.statusCode, 503);
		assert.equal(problemCodeOf(answer.body), 'storedSettingsInvalid');
		assert.doesNotMatch(answer.body, /"0"|: 0\b/u);
	});

	test('answers an administrator the stored grant rules, as the store holds them, recording no event', async (context) => {
		const stand = standUp(context);

		const answer = await send(stand, 'ana', { method: 'GET', url: '/admin/settings/grant-rules' });

		assert.equal(answer.statusCode, 200);
		assert.deepEqual(JSON.parse(answer.body), { grantRules: DEFAULT_GRANT_RULES });
		assert.deepEqual(stand.recorded, []);
	});

	test('refuses anyone but an administrator 403 administratorOnly on a change of the grant rules, before the body is read', async (context) => {
		const stand = standUp(context);

		const answer = await send(stand, 'bo', {
			body: { grantRules: 'not a list' },
			method: 'PUT',
			url: '/admin/settings/grant-rules',
		});

		assert.equal(answer.statusCode, 403);
		assert.equal(problemCodeOf(answer.body), 'administratorOnly');
		assert.deepEqual(
			stand.recorded.map(({ data, severity, type }) => ({ data, severity, type })),
			[
				{
					data: { reason: 'administratorOnly', result: 'denied', sourceIp: '127.0.0.1' },
					severity: 'warning',
					type: 'grantRules.change',
				},
			],
		);
	});

	test('refuses a grant-rules body the validator refuses 400, naming the rule and not the value, recording the denied change at warning', async (context) => {
		const stand = standUp(context);

		const answer = await send(stand, 'ana', {
			body: { grantRules: 'not a list' },
			method: 'PUT',
			url: '/admin/settings/grant-rules',
		});

		assert.equal(answer.statusCode, 400);
		assert.equal(problemCodeOf(answer.body), 'unreadableBody');
		assert.match(answer.body, /grantRules, which is not a list of entries/u);
		assert.deepEqual(
			stand.recorded.map(({ data, severity, type }) => ({ data, severity, type })),
			[
				{
					data: { reason: 'unreadableBody', result: 'denied', sourceIp: '127.0.0.1' },
					severity: 'warning',
					type: 'grantRules.change',
				},
			],
		);
	});

	test('refuses anyone but an administrator 403 administratorOnly on a change of settings, before the body is read, recording the denied change at warning', async (context) => {
		const stand = standUp(context);

		const answer = await send(stand, 'bo', {
			body: { retentionGraceSeconds: 'soon' },
			contentType: 'application/merge-patch+json',
			method: 'PATCH',
			url: '/admin/settings',
		});

		assert.equal(answer.statusCode, 403);
		assert.equal(problemCodeOf(answer.body), 'administratorOnly');
		assert.deepEqual(
			stand.recorded.map(({ data, severity, type }) => ({ data, severity, type })),
			[
				{
					data: { reason: 'administratorOnly', result: 'denied', sourceIp: '127.0.0.1' },
					severity: 'warning',
					type: 'settings.change',
				},
			],
		);
	});

	test('refuses a settings change sent as application/json 415, since the operation takes merge-patch alone', async (context) => {
		const stand = standUp(context);

		const answer = await send(stand, 'ana', {
			body: { noticePageLimit: 100 },
			method: 'PATCH',
			url: '/admin/settings',
		});

		assert.equal(answer.statusCode, 415);
		assert.equal(problemCodeOf(answer.body), 'unsupportedMediaType');
	});

	test('refuses a settings body the operation does not take 400, naming the member and its rule and never a value, recording the denied change at warning', async (context) => {
		const stand = standUp(context);
		const refusedBodies: readonly [unknown, RegExp][] = [
			[{}, /holds no setting to change/u],
			[{ grantRules: [] }, /grantRules, which/u],
			[{ issuer: 'https://elsewhere.example.org' }, /issuer/u],
			[{ firstUser: { subject: 'someone' } }, /firstUser/u],
			[{ unknownSetting: 1 }, /holds a member that no setting takes/u],
			[{ noticePageLimit: 0 }, /noticePageLimit, which/u],
		];

		const answers = await Promise.all(
			refusedBodies.map(([body]) =>
				send(stand, 'ana', {
					body,
					contentType: 'application/merge-patch+json',
					method: 'PATCH',
					url: '/admin/settings',
				}),
			),
		);

		answers.forEach((answer, index) => {
			assert.equal(answer.statusCode, 400, `body ${index} was answered ${answer.statusCode}`);
			assert.equal(problemCodeOf(answer.body), 'unreadableBody');
			assert.match(answer.body, refusedBodies[index]?.[1] ?? /never/u);
			assert.doesNotMatch(answer.body, /"0\b|someone|elsewhere|soon|100|unknownSetting/u);
		});
		assert.equal(stand.recorded.length, refusedBodies.length);
		assert.ok(stand.recorded.every(({ severity, type }) => severity === 'warning' && type === 'settings.change'));
	});

	test('refuses anyone but an administrator 403 administratorOnly before the grant rules are read', async (context) => {
		const stand = standUp(context);

		const answer = await send(stand, 'bo', { method: 'GET', url: '/admin/settings/grant-rules' });

		assert.equal(answer.statusCode, 403);
		assert.equal(problemCodeOf(answer.body), 'administratorOnly');
		assert.deepEqual(stand.reads, []);
	});

	test('refuses a service account 403 serviceAccountNotPermitted before the grant rules are read', async (context) => {
		const stand = standUp(context);

		const answer = await send(stand, 'service', { method: 'GET', url: '/admin/settings/grant-rules' });

		assert.equal(answer.statusCode, 403);
		assert.equal(problemCodeOf(answer.body), 'serviceAccountNotPermitted');
		assert.deepEqual(stand.reads, []);
	});

	test('refuses every settings operation 403 noAdministratorYet until Usher has an administrator', async (context) => {
		const stand = standUp(context, { anyAdministrator: false });

		const answer = await send(stand, 'ana', { method: 'GET', url: '/admin/settings/grant-rules' });

		assert.equal(answer.statusCode, 403);
		assert.equal(problemCodeOf(answer.body), 'noAdministratorYet');
		assert.deepEqual(stand.reads, []);
	});
});
