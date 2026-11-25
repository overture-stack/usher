import assert from 'node:assert/strict';
import { suite, test, type TestContext } from 'node:test';

import type { FastifyInstance } from 'fastify';

import type { AuditEvent } from '../eventLog/index.js';
import { createServer } from '../http/index.js';
import { createPlannedOperationRoutes, PLANNED_OPERATIONS } from './createPlannedOperationRoutes.js';

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);

const SECONDS = Math.floor(NOW / 1000);

const ISSUER = 'https://auth.example.org/realms/usher';

const tokenOf = (subject: string, departures: Readonly<Record<string, unknown>> = {}) => ({
	claims: {
		aud: ['usher-management'],
		azp: 'usher-ui',
		exp: SECONDS + 300,
		iat: SECONDS - 10,
		iss: ISSUER,
		realm_access: { roles: [] },
		sub: subject,
		typ: 'Bearer',
		...departures,
	},
	header: { alg: 'RS256', typ: 'JWT' },
	kind: 'verified' as const,
});

// The bearer credential each caller sends, by the caller's name: Ana administers the platform, Bo does not.
const TOKENS: Readonly<Record<string, ReturnType<typeof tokenOf>>> = {
	ana: tokenOf('subject-ana'),
	bo: tokenOf('subject-bo'),
	service: tokenOf('service-1', { client_id: 'lyric-svc' }),
};

const ADMINISTRATORS: ReadonlySet<string> = new Set(['subject-ana']);

interface Stand {
	recorded: AuditEvent[];
	server: FastifyInstance;
}

const standUp = (context: TestContext, { anyAdministrator = true } = {}): Stand => {
	const recorded: AuditEvent[] = [];
	const server = createServer({
		isLive: () => true,
		isReady: async () => true,
		trustedProxies: [],
	});
	createPlannedOperationRoutes({
		administratorStatus: async ({ subject }) => ({
			administrator: anyAdministrator && ADMINISTRATORS.has(subject),
			anyAdministrator,
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
				recorded.push(event);
				return 'event-id';
			},
		},
	}).forEach((route) => {
		server.route(route);
	});
	context.after(() => server.close());
	return { recorded, server };
};

// A request path for a route template, each parameter filled with a value of its own.
const pathOf = (route: string): string => route.replaceAll(/\{(\w+)\}/gu, (_whole, name: string) => `some-${name}`);

const send = ({ server }: Stand, caller: string, { method, route }: { method: string; route: string }) =>
	server.inject({
		headers: { authorization: `Bearer ${caller}` },
		method: method as 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT',
		url: pathOf(route),
	});

const answerOf = (answer: { body: string; statusCode: number }): readonly unknown[] => [
	answer.statusCode,
	(JSON.parse(answer.body) as { code?: unknown }).code,
];

suite('the planned operations', () => {
	test('serves exactly the contract operations planned and not yet built', () => {
		assert.deepEqual(
			PLANNED_OPERATIONS.map(({ method, route }) => `${method} ${route}`),
			[
				'GET /admin/audit',
				'POST /admin/imports/ego',
				'GET /admin/resource-fields',
				'POST /admin/resource-fields',
				'DELETE /admin/resources/{externalId}',
				'PATCH /admin/resources/{externalId}',
				'POST /admin/resources/{externalId}/restoration',
				'POST /admin/resources/{externalId}/retirement',
				'POST /admin/resources/{externalId}/revocations',
				'POST /admin/resources/{externalId}/suppression',
				'PUT /admin/roles/{roleName}/capabilities',
			],
		);
	});

	test('answers each 501 notImplemented to a platform administrator, recording nothing', async (context) => {
		const stand = standUp(context);
		const answers = await Promise.all(
			PLANNED_OPERATIONS.map(async (operation) => answerOf(await send(stand, 'ana', operation))),
		);
		assert.deepEqual(
			answers,
			PLANNED_OPERATIONS.map(() => [501, 'notImplemented']),
		);
		assert.deepEqual(stand.recorded, []);
	});

	test('refuses a principal who administers nothing 403 administratorOnly on each operation for administrators alone, and answers 501 on the rest', async (context) => {
		const stand = standUp(context);
		const answers = await Promise.all(
			PLANNED_OPERATIONS.map(async (operation) => answerOf(await send(stand, 'bo', operation))),
		);
		assert.deepEqual(
			answers,
			PLANNED_OPERATIONS.map(({ administratorOnly }) =>
				administratorOnly ? [403, 'administratorOnly'] : [501, 'notImplemented'],
			),
		);
	});

	test('refuses a service account 403 serviceAccountNotPermitted, and everyone 403 noAdministratorYet before an administrator accepts', async (context) => {
		const stand = standUp(context);
		const early = standUp(context, { anyAdministrator: false });
		const answers = await Promise.all(
			PLANNED_OPERATIONS.flatMap((operation) => [
				send(stand, 'service', operation),
				send(early, 'ana', operation),
			]).map(async (answer) => answerOf(await answer)),
		);
		assert.deepEqual(
			answers,
			PLANNED_OPERATIONS.flatMap(() => [
				[403, 'serviceAccountNotPermitted'],
				[403, 'noAdministratorYet'],
			]),
		);
	});

	test('refuses a request with no credential 401, as every operation does', async (context) => {
		const stand = standUp(context);
		const answers = await Promise.all(
			PLANNED_OPERATIONS.map(
				async ({ method, route }) =>
					(
						await stand.server.inject({
							method: method as 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT',
							url: pathOf(route),
						})
					).statusCode,
			),
		);
		assert.deepEqual(
			answers,
			PLANNED_OPERATIONS.map(() => 401),
		);
	});
});
