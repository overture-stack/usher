import assert from 'node:assert/strict';
import { suite, test, type TestContext } from 'node:test';

import type { FastifyInstance } from 'fastify';
import pg from 'pg';

import type { AuditEvent, TransactionOptions } from '../eventLog/index.js';
import { createServer } from '../http/index.js';
import { createRevocationRoutes } from './createRevocationRoutes.js';
import type { PrincipalRevocationRecord, RevocationStore } from './types.js';

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);

const ISSUER = 'https://auth.example.org/realms/usher';

/** What the fake store holds for one test: who Usher has met, who is a live administrator, and who stands revoked. */
interface World {
	/** The subjects Usher has met, each with its `users.id`. */
	people: Readonly<Record<string, string>>;

	/** The subjects who are live administrators, not revoked. */
	administrators: readonly string[];

	/** The people holding a standing revocation, by `users.id`. */
	standing: Readonly<Record<string, PrincipalRevocationRecord>>;
}

interface Stand {
	/** The events recorded by committed and refused changes, in order. */
	recorded: AuditEvent[];

	/** The standing revocations after the calls, for the assertions. */
	standing: Record<string, PrincipalRevocationRecord & { liftedAt?: Date }>;

	/** The sign-outs of everyone written, by reason. */
	signOutsOfEveryone: string[];

	/** How many transactions began, and the options each was begun with. */
	transactions: { count: number; options: (TransactionOptions | undefined)[] };

	server: FastifyInstance;
}

const WORLD: World = {
	administrators: ['subject-ana', 'subject-bo'],
	people: { 'subject-ana': 'user-ana', 'subject-bo': 'user-bo', 'subject-cy': 'user-cy' },
	standing: {},
};

const tokenOf = (subject: string, roles: readonly string[] = []) => ({
	claims: {
		aud: ['usher-management'],
		azp: 'usher-ui',
		exp: Math.floor(NOW / 1000) + 300,
		iat: Math.floor(NOW / 1000) - 10,
		iss: ISSUER,
		realm_access: { roles },
		sub: subject,
		typ: 'Bearer',
	},
	header: { alg: 'RS256', typ: 'JWT' },
	kind: 'verified' as const,
});

const TOKENS: Readonly<Record<string, ReturnType<typeof tokenOf>>> = {
	ana: tokenOf('subject-ana'),
	bo: tokenOf('subject-bo'),
	cy: tokenOf('subject-cy'),
};

const standUp = (context: TestContext, world: Partial<World> = {}): Stand => {
	const known: World = { ...WORLD, ...world };
	const people: Record<string, string> = { ...known.people };
	const standing: Record<string, PrincipalRevocationRecord & { liftedAt?: Date }> = { ...known.standing };
	const stand: Stand = {
		signOutsOfEveryone: [],
		recorded: [],
		server: createServer({ isLive: () => true, isReady: async () => true, trustedProxies: [] }),
		standing,
		transactions: { count: 0, options: [] },
	};
	const fakeRevocations = (): RevocationStore => ({
		liftPrincipal: async (userId, { liftedAt }) => {
			const held = standing[userId];
			if (held === undefined) {
				return undefined;
			}
			standing[userId] = { ...held, liftedAt };
			return held;
		},
		recordSignOutEveryone: async ({ reason }) => {
			stand.signOutsOfEveryone.push(reason);
		},
		recordPrincipal: async ({ reason, revokedAt, userId }) => {
			if (standing[userId] !== undefined) {
				return false;
			}
			standing[userId] = { reason, revokedAt };
			return true;
		},
		standingOf: async (userId) => {
			const held = standing[userId];
			return held?.liftedAt === undefined ? held : undefined;
		},
	});
	const fakeAdministrators = () => ({
		countAdministrators: async () => known.administrators.length,
		findOrRecordPerson: async (subject: string) => {
			people[subject] ??= `user-${subject}`;
			return people[subject] ?? '';
		},
		findPerson: async (subject: string) => people[subject],
		isAdministrator: async (subject: string) => known.administrators.includes(subject),
	});
	createRevocationRoutes(
		{
			administratorStoreOf: () => fakeAdministrators(),
			revocationStoreOf: () => fakeRevocations(),
			settings: {
				clock: { now: () => NOW },
				databaseSchema: 'usher',
				identityProviderIssuer: ISSUER,
			},
			store: {
				query: async <Row extends pg.QueryResultRow>(): Promise<pg.QueryResult<Row>> =>
					({ rows: [] }) as unknown as pg.QueryResult<Row>,
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
		stand.server.route(route);
	});
	context.after(() => stand.server.close());
	return stand;
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

const REVOKE = '/admin/people/revocations';
const LIFT = '/admin/people/revocations/lifts';
const SIGN_OUTS = '/admin/sign-outs';

// The events of a type that record a change made, not a refusal of it, which an operation records under its own type.
const eventsOf = (stand: Stand, type: string) =>
	stand.recorded.filter((event) => event.type === type && event.data['result'] === 'succeeded');

suite('revoking a principal, as the Management API answers it', () => {
	test('answers 201 and writes the revocation, recording its event critical, for a person Usher has not met', async (context) => {
		const stand = standUp(context);

		const response = await send(stand, 'ana', {
			body: { reason: 'accountClosed', subject: 'subject-new' },
			method: 'POST',
			url: REVOKE,
		});

		assert.equal(response.statusCode, 201);
		assert.equal(response.json().seenBefore, false);
		assert.equal(response.json().subject, 'subject-new');
		assert.equal(response.json().reason, 'accountClosed');
		assert.equal(stand.transactions.options.at(-1)?.exclusiveAuthority, true);
		assert.equal(eventsOf(stand, 'identity.revocation')[0]?.severity, 'critical');
	});

	test('answers seenBefore true for a person Usher has met', async (context) => {
		const stand = standUp(context);

		const response = await send(stand, 'ana', {
			body: { reason: 'termsViolation', subject: 'subject-cy' },
			method: 'POST',
			url: REVOKE,
		});

		assert.equal(response.statusCode, 201);
		assert.equal(response.json().seenBefore, true);
		assert.deepEqual(
			eventsOf(stand, 'identity.revocation').map(({ data: { reason, revokedUserSubject, seenBefore } }) => [
				reason,
				revokedUserSubject,
				seenBefore,
			]),
			[['termsViolation', 'subject-cy', true]],
		);
	});

	test('refuses a shape the body cannot take 400, writing nothing', async (context) => {
		const stand = standUp(context);

		for (const body of [
			{ reason: 'accountClosed' },
			{ reason: 'accountClosed', subject: 7 },
			{ reason: 'accountClosed', subject: '' },
			{ reason: 'accountClosed', subject: 'subject-cy', extra: true },
			{ reason: 7, subject: 'subject-cy' },
		]) {
			assert.equal((await send(stand, 'ana', { body, method: 'POST', url: REVOKE })).statusCode, 400);
		}
		assert.deepEqual(stand.standing, {});
	});

	test('refuses a reason outside the identity revocation reasons 422, writing nothing', async (context) => {
		const stand = standUp(context);

		const response = await send(stand, 'ana', {
			body: { reason: 'keyCompromise', subject: 'subject-cy' },
			method: 'POST',
			url: REVOKE,
		});

		assert.equal(response.statusCode, 422);
		assert.equal(response.json().code, 'invalidRevocationReason');
		assert.deepEqual(stand.standing, {});
	});

	test('refuses a person already revoked 409 alreadyRevoked, before the last administrator is judged', async (context) => {
		const stand = standUp(context, {
			standing: { 'user-ana': { reason: 'accountClosed', revokedAt: new Date(NOW) } },
		});

		const response = await send(stand, 'bo', {
			body: { reason: 'accountClosed', subject: 'subject-ana' },
			method: 'POST',
			url: REVOKE,
		});

		assert.equal(response.statusCode, 409);
		assert.equal(response.json().code, 'alreadyRevoked');
		assert.equal(eventsOf(stand, 'identity.revocation').length, 0);
	});

	test('refuses the last live administrator 409 lastAdministrator, and allows self-revocation while another remains', async (context) => {
		const solo = standUp(context, { administrators: ['subject-ana'] });
		const refused = await send(solo, 'ana', {
			body: { reason: 'accountClosed', subject: 'subject-ana' },
			method: 'POST',
			url: REVOKE,
		});
		assert.equal(refused.statusCode, 409);
		assert.equal(refused.json().code, 'lastAdministrator');
		assert.deepEqual(solo.standing, {});

		const pair = standUp(context);
		const allowed = await send(pair, 'ana', {
			body: { reason: 'accountClosed', subject: 'subject-ana' },
			method: 'POST',
			url: REVOKE,
		});
		assert.equal(allowed.statusCode, 201);
	});

	test('refuses a caller who is not an administrator 403 administratorOnly before the body is read', async (context) => {
		const stand = standUp(context);

		const response = await send(stand, 'cy', { body: { reason: 'accountClosed' }, method: 'POST', url: REVOKE });

		assert.equal(response.statusCode, 403);
		assert.equal(response.json().code, 'administratorOnly');
	});
});

suite('lifting a principal revocation, as the Management API answers it', () => {
	test('answers 200 and keeps the revocation as lifted, recording its event critical', async (context) => {
		const revokedAt = new Date(NOW - 60_000);
		const stand = standUp(context, { standing: { 'user-cy': { reason: 'securityIncident', revokedAt } } });

		const response = await send(stand, 'ana', { body: { subject: 'subject-cy' }, method: 'POST', url: LIFT });

		assert.equal(response.statusCode, 200);
		assert.equal(response.json().subject, 'subject-cy');
		assert.equal(stand.standing['user-cy']?.liftedAt?.getTime(), NOW);
		assert.deepEqual(
			eventsOf(stand, 'identity.revocationLift').map(({ data: { liftedUserSubject, reason }, severity }) => [
				severity,
				liftedUserSubject,
				reason,
			]),
			[['critical', 'subject-cy', 'securityIncident']],
		);
	});

	test('refuses a subject Usher has never met, or one holding no standing revocation, 409 notRevoked', async (context) => {
		const stand = standUp(context);

		for (const subject of ['subject-new', 'subject-cy']) {
			const response = await send(stand, 'ana', { body: { subject }, method: 'POST', url: LIFT });
			assert.equal(response.statusCode, 409);
			assert.equal(response.json().code, 'notRevoked');
		}
		assert.equal(eventsOf(stand, 'identity.revocationLift').length, 0);
	});

	test('refuses a body with a member other than subject 400', async (context) => {
		const stand = standUp(context);

		const response = await send(stand, 'ana', {
			body: { reason: 'accountClosed', subject: 'subject-cy' },
			method: 'POST',
			url: LIFT,
		});

		assert.equal(response.statusCode, 400);
	});
});

suite('signing out everyone, as the Management API answers it', () => {
	test('answers 201 with the reason and the instant, writes the sign-out, and records its event critical', async (context) => {
		const stand = standUp(context);

		const response = await send(stand, 'ana', {
			body: { confirm: true, reason: 'credentialCompromise' },
			method: 'POST',
			url: SIGN_OUTS,
		});

		assert.equal(response.statusCode, 201);
		assert.deepEqual(response.json(), { reason: 'credentialCompromise', signedOutAt: new Date(NOW).toISOString() });
		assert.deepEqual(stand.signOutsOfEveryone, ['credentialCompromise']);
		assert.equal(eventsOf(stand, 'identity.signOutEveryone')[0]?.severity, 'critical');
	});

	test('refuses confirmation other than true 422 notConfirmed, and a reason outside the sign-out reasons 422, keyCompromise included', async (context) => {
		const stand = standUp(context);

		const unconfirmed = await send(stand, 'ana', {
			body: { confirm: false, reason: 'securityIncident' },
			method: 'POST',
			url: SIGN_OUTS,
		});
		assert.equal(unconfirmed.statusCode, 422);
		assert.equal(unconfirmed.json().code, 'notConfirmed');

		const refused = await Promise.all(
			['accountClosed', 'keyCompromise'].map((reason) =>
				send(stand, 'ana', { body: { confirm: true, reason }, method: 'POST', url: SIGN_OUTS }),
			),
		);
		assert.deepEqual(
			refused.map((response) => [response.statusCode, response.json().code]),
			[
				[422, 'invalidSignOutReason'],
				[422, 'invalidSignOutReason'],
			],
		);
		assert.deepEqual(stand.signOutsOfEveryone, []);
	});

	test('refuses a confirm that is not a boolean 400', async (context) => {
		const stand = standUp(context);

		const response = await send(stand, 'ana', {
			body: { confirm: 'true', reason: 'securityIncident' },
			method: 'POST',
			url: SIGN_OUTS,
		});

		assert.equal(response.statusCode, 400);
	});
});
