import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { decodeJwt } from 'jose';
import pg from 'pg';

import { managementClaims, readReadiness } from './admin.js';
import { runningContainers } from './containerEnvironment.js';
import {
	type KeycloakPerson,
	type KeycloakRealmOptions,
	startDedicatedPostgresql,
	startKeycloak,
} from './containers.js';
import type { MigrationOptions } from './controller.js';
import {
	DATABASE_ROLES,
	type DatabaseTemplate,
	TEMPLATE_RETENTION_FLOOR_SECONDS,
	TEMPLATE_SETTINGS,
	USHER_SCHEMA,
} from './database.js';
import { ENVIRONMENT_VARIABLES, HARNESS_STORE_TIMEOUT_MILLISECONDS } from './controller.js';
import { exchange, PEOPLE } from './exchange.js';
import {
	APPLICATION_KEY_RELOAD_INTERVAL_MILLISECONDS,
	COMPRESSED_CONTROLLER_TIMING,
	configurationToRead,
	HARNESS_EVENT_SOURCE,
	type Harness,
	startInstance,
	HARNESS_LOGOUT_CLIENT,
	harnessApplicationNames,
	harnessConfiguration,
	passwordsApart,
	realmAdministrator,
	realmRegistrar,
	REALM_REGISTRANT_REFUSAL,
	RETENTION_DEFAULTS,
	restoreSnapshot,
	retentionFloorSeconds,
	standInAdministrator,
	STARTED_STORE_TEMPLATE,
	startHarness,
	startReadOnlyInstance,
	suiteHarness,
	takeSnapshot,
	withHarness,
	withRegisteredIds,
	withTrailingSlash,
} from './harness.js';
import { startIdentityProvider } from '../peripherals/identityProvider.js';
import {
	fixtureApplicationId,
	insertNotices,
	noticePositions,
	POLICY_TABLES,
	type PolicyFixture,
	qualified,
	readNoticeStream,
	seedPolicy,
	storedExternalIds,
} from './policy.js';
import { cleanupFor } from './waiting.js';

const SETTINGS = Object.freeze({
	cacheUrl: 'redis://127.0.0.1:6379',
	databaseSchema: 'usher',
	databaseUrl: 'postgres://usher_controller@127.0.0.1:5432/usher_test',
	identityProviderIssuer: 'http://127.0.0.1:8080/realms/usher-test',
	overrides: {},
});

const isCanonicalKey = (key: string): boolean =>
	/^[\w-]{43}$/u.test(key) && Buffer.from(key, 'base64url').toString('base64url') === key;

// A stand-in migration building only the schema, which the Controller's runtime role may not use, so
// the Controller refuses its start once the harness is past its database.
const schemaOnly: DatabaseTemplate = {
	migrate: async ({ databaseUrl, schema }) => {
		const postgres = new pg.Client({ connectionString: databaseUrl });
		await postgres.connect();
		try {
			await postgres.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
		} finally {
			await postgres.end();
		}
	},
	name: `harness_schema_${randomBytes(6).toString('hex')}`,
	schema: USHER_SCHEMA,
};

// What a start the Controller refuses rejects with: its refusal, naming the variable at fault.
const refusalNaming = (variable: string): { message: RegExp } => ({
	message: new RegExp(`\\b${variable}\\b`, 'u'),
});

// Random bytes recorded as the key-encryption key's fingerprint, as a first start records one, so
// every later start on the store is refused, naming the key-encryption key's variable: no key made
// by the harness derives them.
const recordForeignFingerprint = async (client: pg.ClientBase): Promise<void> => {
	const { keyFingerprints } = POLICY_TABLES;
	const { fingerprint, keyName, recordedAt } = keyFingerprints.columns;
	await client.query(
		`INSERT INTO ${qualified(keyFingerprints)} (${pg.escapeIdentifier(keyName)}, ${pg.escapeIdentifier(fingerprint)}, ${pg.escapeIdentifier(recordedAt)}) VALUES ('keyEncryptionKey', $1, now())`,
		[randomBytes(32)],
	);
};

const openHandles = (): Readonly<Record<string, number>> =>
	Object.fromEntries(
		['TCPServerWrap', 'TCPSocketWrap'].map((kind) => [
			kind,
			process.getActiveResourcesInfo().filter((resource) => resource === kind).length,
		]),
	);

// A socket's handle is released a moment after its close settles, so the count is read again for
// up to a second before it is compared.
const settledHandles = async (
	expected: Readonly<Record<string, number>>,
	attempts = 20,
): Promise<Readonly<Record<string, number>>> => {
	const current = openHandles();
	if (attempts > 0 && JSON.stringify(current) !== JSON.stringify(expected)) {
		await delay(50);
		return settledHandles(expected, attempts - 1);
	}
	return current;
};

// A password holding characters escaped in a URL, so its decoding is proven too.
const freshPassword = (): string => `${randomBytes(12).toString('base64url')}/@:%`;

const withPassword = (url: string, password: string): string => {
	const parsed = new URL(url);
	parsed.password = encodeURIComponent(password);
	return parsed.href;
};

suite("the harness's configuration", () => {
	test('gives the cursor and the key-encryption key fresh 32-byte keys in canonical form, and names no application', () => {
		const configuration = harnessConfiguration(SETTINGS);
		const keys = [configuration.cursorKey, configuration.keyEncryptionKey];
		const another = harnessConfiguration(SETTINGS);

		assert.ok(keys.every(isCanonicalKey));
		assert.equal(new Set(keys).size, 2);
		assert.notEqual(another.cursorKey, configuration.cursorKey);
		assert.notEqual(another.keyEncryptionKey, configuration.keyEncryptionKey);
		assert.equal(Object.hasOwn(configuration, 'applications'), false);
	});

	test("takes each store's password out of its URL into a variable of its own, the user name kept", () => {
		const cachePassword = freshPassword();
		const databasePassword = freshPassword();
		const overridden = freshPassword();

		const configuration = harnessConfiguration({
			...SETTINGS,
			cacheUrl: withPassword(SETTINGS.cacheUrl, cachePassword),
			databaseUrl: withPassword(SETTINGS.databaseUrl, databasePassword),
		});
		const overriding = harnessConfiguration({
			...SETTINGS,
			overrides: {
				cacheUrl: withPassword('redis://127.0.0.1:6380', overridden),
			},
		});
		const restated = passwordsApart({
			...configuration,
			databaseUrl: withPassword(configuration.databaseUrl, overridden),
		});

		assert.deepEqual(
			{
				cachePassword: configuration.cachePassword,
				cacheUrl: configuration.cacheUrl,
				databasePassword: configuration.databasePassword,
				databaseUrl: configuration.databaseUrl,
			},
			{
				cachePassword,
				cacheUrl: SETTINGS.cacheUrl,
				databasePassword,
				databaseUrl: SETTINGS.databaseUrl,
			},
		);
		assert.equal(overriding.cachePassword, overridden);
		assert.equal(overriding.cacheUrl, 'redis://127.0.0.1:6380');
		assert.equal(restated.databasePassword, overridden);
		assert.equal(restated.databaseUrl, SETTINGS.databaseUrl);
		assert.equal(restated.cachePassword, cachePassword);
	});

	test('stands a fresh password in for each store with none in its URL', () => {
		const configuration = harnessConfiguration(SETTINGS);
		const another = harnessConfiguration(SETTINGS);

		assert.ok(configuration.cachePassword.length > 0);
		assert.ok(configuration.databasePassword.length > 0);
		assert.notEqual(another.cachePassword, configuration.cachePassword);
		assert.notEqual(another.databasePassword, configuration.databasePassword);
		assert.equal(new URL(configuration.cacheUrl).password, '');
		assert.equal(new URL(configuration.databaseUrl).password, '');
	});

	test("names the management API and its client, the first-user and service-account roles and the rulings' defaults", () => {
		const configuration = harnessConfiguration(SETTINGS);

		assert.deepEqual(
			{
				autoAccept: configuration.autoAccept,
				baseline: configuration.baseline,
				firstUserRole: configuration.firstUserRole,
				host: configuration.host,
				issuer: configuration.issuer,
				managementAudience: configuration.managementAudience,
				managementClients: configuration.managementClients,
				port: configuration.port,
				serviceAccountRole: configuration.serviceAccountRole,
				signedInRule: configuration.signedInRule,
				tokenLifetimeSeconds: configuration.tokenLifetimeSeconds,
			},
			{
				autoAccept: false,
				baseline: ['count', 'view', 'export'],
				firstUserRole: 'usher-first-user',
				host: '127.0.0.1',
				issuer: 'https://usher.example.org',
				managementAudience: 'usher-management-test',
				managementClients: ['usher-ui-test'],
				port: 0,
				serviceAccountRole: 'usher-service-account',
				signedInRule: ['count', 'view', 'export'],
				tokenLifetimeSeconds: 300,
			},
		);
		assert.equal(configuration.identityProviderIssuer, SETTINGS.identityProviderIssuer);
		assert.equal(configuration.databaseUrl, SETTINGS.databaseUrl);
		assert.equal(configuration.cacheUrl, SETTINGS.cacheUrl);
	});

	test("gives the deployment command the retention floor of its configuration, by default the template's", () => {
		const usual = harnessConfiguration(SETTINGS);
		const shortened = harnessConfiguration({
			...SETTINGS,
			overrides: { retentionGraceSeconds: 10, tokenLifetimeSeconds: 120 },
		});

		assert.equal(retentionFloorSeconds(usual), TEMPLATE_RETENTION_FLOOR_SECONDS);
		assert.equal(retentionFloorSeconds(shortened), 160);
	});

	test("lets a test's overrides replace any field, the key-encryption key and the clock included", () => {
		const clock = { now: () => Date.UTC(2026, 0, 1) };
		const keyEncryptionKey = randomBytes(32).toString('base64url');

		const configuration = harnessConfiguration({
			...SETTINGS,
			overrides: {
				autoAccept: true,
				clock,
				keyEncryptionKey,
				tokenLifetimeSeconds: 60,
			},
		});

		assert.equal(configuration.keyEncryptionKey, keyEncryptionKey);
		assert.equal(configuration.autoAccept, true);
		assert.equal(configuration.clock, clock);
		assert.equal(configuration.tokenLifetimeSeconds, 60);
	});
});

// Migrations run again on a clone to set its floor, so this stand-in may run twice, recording each run.
const recordingSchemaOnly = (migrations: MigrationOptions[]): DatabaseTemplate => ({
	migrate: async (options) => {
		migrations.push(options);
		const postgres = new pg.Client({ connectionString: options.databaseUrl });
		await postgres.connect();
		try {
			await postgres.query(`CREATE SCHEMA IF NOT EXISTS ${pg.escapeIdentifier(options.schema)}`);
			await postgres.query(
				`CREATE TABLE IF NOT EXISTS ${pg.escapeIdentifier(options.schema)}.settings (name text PRIMARY KEY, value jsonb NOT NULL, changed_at timestamptz NOT NULL DEFAULT now())`,
			);
			// Every setting the template seeds, so a start on this stand-in reads each of them from its store.
			// One connection runs one query at a time, so the inserts run in turn, each after the one before.
			await Object.entries(TEMPLATE_SETTINGS).reduce<Promise<unknown>>(
				(previous, [name, value]) =>
					previous.then(() =>
						postgres.query(
							`INSERT INTO ${pg.escapeIdentifier(options.schema)}.settings (name, value) VALUES ($1, $2::jsonb) ON CONFLICT DO NOTHING`,
							[name, JSON.stringify(value)],
						),
					),
				Promise.resolve(),
			);
		} finally {
			await postgres.end();
		}
	},
	name: `harness_recording_${randomBytes(6).toString('hex')}`,
	schema: USHER_SCHEMA,
});

const clusterState = async (
	superuserUrl: string,
): Promise<{ databases: readonly string[]; roles: readonly string[] }> => {
	const superuser = new pg.Client({ connectionString: superuserUrl });
	await superuser.connect();
	try {
		const databases = await superuser.query<{ datname: string }>(
			"SELECT datname FROM pg_database WHERE datname NOT IN ('postgres', 'template0', 'template1') ORDER BY datname",
		);
		const roles = await superuser.query<{ rolname: string }>(
			'SELECT rolname FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname',
			[Object.values(DATABASE_ROLES)],
		);
		return {
			databases: databases.rows.map(({ datname }) => datname),
			roles: roles.rows.map(({ rolname }) => rolname),
		};
	} finally {
		await superuser.end();
	}
};

suite('a harness whose controller refuses to start', () => {
	test("fails with the controller's refusal once past its database, leaving nothing it started running", async () => {
		const before = openHandles();

		await assert.rejects(
			startHarness({ template: schemaOnly }),
			refusalNaming(ENVIRONMENT_VARIABLES.databaseSchema),
		);

		assert.deepEqual(await settledHandles(before), before);
	});

	test("puts its database on a test file's own PostgreSQL when given one, and leaves nothing there it started", async (context) => {
		const dedicated = await startDedicatedPostgresql();
		context.after(() => dedicated.remove());
		const migrations: MigrationOptions[] = [];
		const template = recordingSchemaOnly(migrations);
		const before = openHandles();

		await assert.rejects(
			startHarness({
				configuration: { tokenLifetimeSeconds: 120 },
				postgresql: dedicated,
				template,
			}),
			refusalNaming(ENVIRONMENT_VARIABLES.databaseSchema),
		);

		assert.deepEqual(
			migrations.map(({ databaseUrl }) => ({
				port: new URL(databaseUrl).port,
				template: new URL(databaseUrl).pathname === `/${template.name}`,
			})),
			[{ port: new URL(dedicated.container.url).port, template: true }],
		);
		assert.deepEqual(await clusterState(dedicated.container.url), {
			databases: [template.name],
			roles: [DATABASE_ROLES.runtime, DATABASE_ROLES.migration],
		});
		assert.deepEqual(await settledHandles(before), before);
	});
});

const FIXTURE: PolicyFixture = {
	applications: {
		'arranger-test': { registeredBy: 'ana', serves: ['STUDY-A1'] },
		'lyric-test': { serves: [] },
	},
	grants: {
		anaViews: {
			category: 'unmarked',
			holder: { user: 'ana' },
			resource: 'STUDY-A1',
			role: 'viewer',
		},
	},
	resources: { 'STUDY-A1': { baseTier: 'open', name: 'A1' } },
	users: {
		ana: { subject: 'ana-subject' },
		bo: { subject: 'bo-subject' },
	},
};

const databaseCount = async (name: string): Promise<number | undefined> => {
	const superuser = new pg.Client({
		connectionString: runningContainers().postgresql.url,
	});
	await superuser.connect();
	try {
		const { rows } = await superuser.query<{ count: number }>(
			'SELECT count(*)::int AS count FROM pg_database WHERE datname = $1',
			[name],
		);
		return rows[0]?.count;
	} finally {
		await superuser.end();
	}
};

const REGISTERING = configurationToRead();

const realmPerson = (username: string, realmRoles: readonly string[]): KeycloakPerson => ({
	email: username,
	password: randomBytes(18).toString('base64url'),
	realmRoles,
	username,
});

// A realm of the harness's own: its management client, an administrator holding the configured
// first-user role, which marks the person the harness seeds as an administrator, and a person
// holding none.
const REGISTRAR_REALM: KeycloakRealmOptions = Object.freeze({
	clients: [
		{
			audiences: [REGISTERING.managementAudience],
			clientId: REGISTERING.managementClients[0] ?? 'usher-ui-test',
		},
	],
	people: [
		realmPerson('registrar@example.org', [REGISTERING.firstUserRole]),
		realmPerson('bystander@example.org', []),
	],
	realm: 'usher-harness-test',
	realmRoles: [REGISTERING.firstUserRole],
});

const REALM_ADMINISTRATOR = 'registrar@example.org';

suite("the platform administrator registering a harness's applications", () => {
	test("is by default the stand-in's, its token carrying the stand-in's issuer, the management API, the first management client and no role beyond Keycloak's defaults", async (context) => {
		const provider = await startIdentityProvider();
		context.after(() => provider.stop());
		const configuration = harnessConfiguration({
			...SETTINGS,
			identityProviderIssuer: provider.issuer,
		});

		const claims = decodeJwt(await standInAdministrator(provider)(configuration));
		const expected = managementClaims(provider, configuration, PEOPLE.administrator, false);

		assert.equal(claims.iss, provider.issuer);
		assert.deepEqual(Object.fromEntries(Object.keys(expected).map((name) => [name, claims[name]])), expected);
	});

	test('signs in the administrator the caller names, not the first holder of the first-user role, and the first holder by default', async () => {
		const signedIn: string[] = [];
		const keycloak = {
			signIn: async (_clientId: string, person: KeycloakPerson) => {
				signedIn.push(person.username);
				return { accessToken: 'token', idToken: 'id', refreshToken: 'refresh' };
			},
		};
		const options: KeycloakRealmOptions = {
			...REGISTRAR_REALM,
			people: [
				realmPerson('first.holder@example.org', [REGISTERING.firstUserRole]),
				realmPerson(REALM_ADMINISTRATOR, [REGISTERING.firstUserRole]),
				realmPerson('bystander@example.org', []),
			],
		};

		await realmAdministrator({ keycloak, options })(REGISTERING);
		await realmAdministrator({ administrator: REALM_ADMINISTRATOR, keycloak, options })(REGISTERING);

		assert.deepEqual(signedIn, ['first.holder@example.org', REALM_ADMINISTRATOR]);
	});

	test("is, given a realm's source, the realm's own administrator signed in through its management client under the realm's issuer, and is refused by a realm holding no administrator", async (context) => {
		const keycloak = await startKeycloak(REGISTRAR_REALM);
		context.after(() => keycloak.remove());

		const claims = decodeJwt(
			await realmAdministrator({ administrator: REALM_ADMINISTRATOR, keycloak, options: REGISTRAR_REALM })(
				REGISTERING,
			),
		);
		const withoutAdministrator = realmAdministrator({
			keycloak,
			options: {
				...REGISTRAR_REALM,
				people: REGISTRAR_REALM.people.filter(
					({ realmRoles = [] }) => !realmRoles.includes(REGISTERING.firstUserRole),
				),
			},
		});

		assert.equal(claims.iss, keycloak.issuer);
		assert.equal(claims.sub, await keycloak.subject(REALM_ADMINISTRATOR));
		assert.equal(claims['azp'], REGISTERING.managementClients[0]);
		assert.ok([claims.aud].flat().includes(REGISTERING.managementAudience), 'the token names the management API');
		const realmAccess = claims['realm_access'];
		assert.ok(
			typeof realmAccess === 'object' &&
				realmAccess !== null &&
				'roles' in realmAccess &&
				Array.isArray(realmAccess.roles) &&
				realmAccess.roles.includes(REGISTERING.firstUserRole),
			'the token carries the first-user role',
		);
		await assert.rejects(withoutAdministrator(REGISTERING), {
			message: 'the realm holds no management client or no administrator to sign in',
		});
	});
});

suite("a harness's administrators", () => {
	const administratorSubjects = async (client: pg.ClientBase): Promise<readonly string[]> => {
		const { administrators, userIdentities } = POLICY_TABLES;
		const { rows } = await client.query<{ subject: string }>(
			`SELECT identity.${userIdentities.columns.idpSubjectId} AS subject
         FROM ${qualified(administrators)} held
         JOIN ${qualified(userIdentities)} identity
           ON identity.${userIdentities.columns.userId} = held.${administrators.columns.userId}
        ORDER BY held.${administrators.columns.acceptedAt}`,
		);
		return rows.map(({ subject }) => subject);
	};

	test("seeds PEOPLE.administrator once its controller first listens, then each person an administrator's token is asked for, once", async () => {
		await withHarness({ applications: [] }, async (harness) => {
			const seeded = await administratorSubjects(harness.clients.migration);

			await harness.tokens.administrator(PEOPLE.eli);
			await harness.tokens.administrator(PEOPLE.eli);
			await harness.tokens.firstUser(PEOPLE.ana);
			await harness.tokens.management(PEOPLE.bo);

			assert.deepEqual(seeded, [PEOPLE.administrator.subject]);
			assert.deepEqual(await administratorSubjects(harness.clients.migration), [
				PEOPLE.administrator.subject,
				PEOPLE.eli.subject,
			]);
		});
	});

	test('seeds none when told not to, as before the first user nominates one, nor before its controller first listens', async () => {
		await withHarness({ applications: [], seedsAdministrator: false }, async (told) => {
			assert.deepEqual(await administratorSubjects(told.clients.migration), []);
		});
		await withHarness({ applications: [], startsController: false }, async (harness) => {
			assert.deepEqual(await administratorSubjects(harness.clients.migration), []);
		});
	});

	test("gives the first user's token the configured first-user role, and no other token any role beyond Keycloak's defaults", async () => {
		await withHarness({ applications: [], startsController: false }, async (harness) => {
			const rolesOf = (token: string): unknown => Reflect.get(Object(decodeJwt(token)['realm_access']), 'roles');

			const roles = [
				rolesOf(await harness.tokens.firstUser(PEOPLE.ana)),
				rolesOf(await harness.tokens.administrator(PEOPLE.eli)),
				rolesOf(await harness.tokens.management(PEOPLE.bo)),
			];

			const defaults = ['default-roles-usher-test', 'offline_access', 'uma_authorization'];
			assert.deepEqual(roles, [[...defaults, harness.configuration.firstUserRole], defaults, defaults]);
		});
	});
});

suite('the new configuration defaults', () => {
	test('addresses logout tokens to a client that is no application, and sets the stream and sign-out limits', () => {
		const configuration = harnessConfiguration(SETTINGS);

		assert.deepEqual(configuration.backChannelLogoutAudiences, [HARNESS_LOGOUT_CLIENT]);
		assert.equal(configuration.logStream, process.stdout);
		assert.equal(configuration.signInTokenMaximumLifetimeSeconds, 3600);
		assert.equal(configuration.streamLimitPerAudience, 64);
		assert.equal(configuration.streamQueueLimit, 1000);
		assert.equal(withTrailingSlash(new URL('http://127.0.0.1:8080/usher')).href, 'http://127.0.0.1:8080/usher/');
	});
});

suite("a harness's applications", () => {
	test("names the options' applications first, then each further one named by the fixture, each once", () => {
		const fixture: PolicyFixture = {
			applications: {
				'lyric-test': { serves: [] },
				'song-test': { serves: [] },
				'arranger-test': { serves: [] },
			},
		};

		assert.deepEqual(harnessApplicationNames(['arranger-test', 'lyric-test'], fixture), [
			'arranger-test',
			'lyric-test',
			'song-test',
		]);
		assert.deepEqual(harnessApplicationNames([], fixture), ['lyric-test', 'song-test', 'arranger-test']);
		assert.deepEqual(harnessApplicationNames(['score-test'], undefined), ['score-test']);
		assert.deepEqual(
			harnessApplicationNames([], {
				users: { ana: { subject: 'ana-subject' } },
			}),
			[],
		);
	});

	test('holds each fixture application by its registered id, what it serves kept, and leaves one not registered and the rest of the fixture unchanged', () => {
		const registeredId = randomUUID();
		const fixture: PolicyFixture = {
			...FIXTURE,
			applications: {
				...FIXTURE.applications,
				'song-test': { description: 'Song', serves: ['STUDY-A1'] },
			},
		};

		assert.deepEqual(
			withRegisteredIds(fixture, [
				{ displayName: 'arranger-test', id: registeredId },
				{ displayName: 'score-test', id: randomUUID() },
			]),
			{
				...FIXTURE,
				applications: {
					'arranger-test': {
						id: registeredId,
						registeredBy: 'ana',
						serves: ['STUDY-A1'],
					},
					'lyric-test': { serves: [] },
					'song-test': { description: 'Song', serves: ['STUDY-A1'] },
				},
			},
		);
		const withoutApplications: PolicyFixture = {
			users: { ana: { subject: 'ana-subject' } },
		};
		assert.equal(
			withRegisteredIds(withoutApplications, [{ displayName: 'arranger-test', id: registeredId }]),
			withoutApplications,
		);
	});
});

suite("a harness's applications written through the store", () => {
	const tables = POLICY_TABLES;
	// The issuer of the stand-in a harness starts, named where the rows of two harnesses are compared.
	const STAND_IN_ISSUER = 'the stand-in';

	// The application and key rows a harness's store holds, the identity of each registrant and issuer
	// by subject and issuer, and no id, instant or sealed key.
	const storedRowsOf = async (
		harness: Harness,
	): Promise<{
		applications: readonly {
			description: string | null;
			displayName: string;
			registeredBy: string;
			registeredByIssuer: string;
		}[];
		keys: readonly {
			applicationName: string;
			confirmed: boolean;
			issuedBy: string;
			issuedByIssuer: string;
			live: boolean;
		}[];
	}> => {
		const { rows: applications } = await harness.clients.migration.query<{
			description: string | null;
			displayName: string;
			registeredBy: string;
			registeredByIssuer: string;
		}>(
			`SELECT application.${tables.applications.columns.description} AS description,
                  application.${tables.applications.columns.displayName} AS "displayName",
                  identity.${tables.userIdentities.columns.idpSubjectId} AS "registeredBy",
                  identity.${tables.userIdentities.columns.idpIssuer} AS "registeredByIssuer"
             FROM ${qualified(tables.applications)} application
             JOIN ${qualified(tables.userIdentities)} identity
               ON identity.${tables.userIdentities.columns.userId} = application.${tables.applications.columns.registeredBy}
            ORDER BY application.${tables.applications.columns.displayName}`,
		);
		const { rows: keys } = await harness.clients.migration.query<{
			applicationName: string;
			confirmed: boolean;
			issuedBy: string;
			issuedByIssuer: string;
			live: boolean;
		}>(
			`SELECT application.${tables.applications.columns.displayName} AS "applicationName",
                  held.${tables.applicationKeys.columns.confirmedAt} IS NOT NULL AS confirmed,
                  identity.${tables.userIdentities.columns.idpSubjectId} AS "issuedBy",
                  identity.${tables.userIdentities.columns.idpIssuer} AS "issuedByIssuer",
                  held.${tables.applicationKeys.columns.revokedAt} IS NULL AS live
             FROM ${qualified(tables.applicationKeys)} held
             JOIN ${qualified(tables.applications)} application
               ON application.${tables.applications.columns.id} = held.${tables.applicationKeys.columns.applicationId}
             JOIN ${qualified(tables.userIdentities)} identity
               ON identity.${tables.userIdentities.columns.userId} = held.${tables.applicationKeys.columns.issuedBy}
            ORDER BY application.${tables.applications.columns.displayName}, held.${tables.applicationKeys.columns.issuedAt}`,
		);
		const issuerNamed = (issuer: string): string =>
			issuer === harness.configuration.identityProviderIssuer ? STAND_IN_ISSUER : issuer;
		return {
			applications: applications.map((row) => ({
				...row,
				registeredByIssuer: issuerNamed(row.registeredByIssuer),
			})),
			keys: keys.map((row) => ({ ...row, issuedByIssuer: issuerNamed(row.issuedByIssuer) })),
		};
	};

	test('starts its controller with the identity provider never asked, and serves an anonymous exchange through one of its applications', async () => {
		await withHarness({ applicationsThroughStore: true }, async (harness) => {
			assert.deepEqual(harness.identityProvider.requests, []);

			const answer = await exchange(harness.url, { application: harness.application('arranger-test') });

			assert.equal(answer.status, 200);
		});
	});

	test('starts, and binds its applications, with the identity provider refusing connections from before the start', async (context) => {
		const provider = await startIdentityProvider();
		cleanupFor(context).defer(() => provider.stop());
		await provider.refuseConnections();

		await withHarness({ applicationsThroughStore: true, identityProvider: provider }, async (harness) => {
			assert.deepEqual(
				harness.applications.map(({ displayName }) => displayName),
				['arranger-test', 'lyric-test'],
			);
			assert.ok(harness.application('lyric-test').key.length > 0);
		});
	});

	test('writes the application and key rows that registering through the API writes, the platform administrator registering and issuing in both', async () => {
		const names = ['arranger-test', 'lyric-test'];

		const throughStore = await withHarness(
			{ applications: names, applicationsThroughStore: true },
			async (harness) => ({
				requests: harness.identityProvider.requests.length,
				rows: await storedRowsOf(harness),
			}),
		);
		const throughApi = await withHarness({ applications: names }, async (harness) => ({
			rows: await storedRowsOf(harness),
		}));

		assert.equal(throughStore.requests, 0);
		assert.deepEqual(throughStore.rows, throughApi.rows);
		assert.equal(throughStore.rows.applications.length, names.length);
		assert.equal(throughStore.rows.keys.length, names.length);
		assert.ok(
			throughStore.rows.applications.every(
				({ registeredBy, registeredByIssuer }) =>
					registeredBy === PEOPLE.administrator.subject && registeredByIssuer === STAND_IN_ISSUER,
			),
			'each application is registered by the administrator',
		);
		assert.ok(
			throughStore.rows.keys.every(
				({ issuedBy, issuedByIssuer }) =>
					issuedBy === PEOPLE.administrator.subject && issuedByIssuer === STAND_IN_ISSUER,
			),
			'each key is issued by the administrator',
		);
	});

	test("refuses a start that also gives a Keycloak realm's administrator token, before anything starts, since the registrant would not be the realm's administrator", async () => {
		await assert.rejects(
			startHarness({
				administratorToken: realmRegistrar().administratorToken,
				applicationsThroughStore: true,
			}),
			{ message: REALM_REGISTRANT_REFUSAL },
		);
	});
});

suite('a harness starting no controller', () => {
	test("seeds the whole fixture, its applications under the fixture's ids, reads no URL, and fails a restart its controller refuses", async () => {
		const harness = await startHarness({
			fixture: FIXTURE,
			startsController: false,
			template: STARTED_STORE_TEMPLATE,
		});
		try {
			const { userIdentities } = POLICY_TABLES;
			const { rows } = await harness.clients.migration.query<{
				subject: string;
			}>(`SELECT ${userIdentities.columns.idpSubjectId} AS subject FROM ${qualified(userIdentities)} ORDER BY 1`);

			assert.deepEqual(
				rows.map(({ subject }) => subject),
				['ana-subject', 'bo-subject', 'steward-7b3e9c1a-usher-test'],
			);
			assert.deepEqual(harness.seeded.applications, {
				'arranger-test': fixtureApplicationId('arranger-test'),
				'lyric-test': fixtureApplicationId('lyric-test'),
			});
			assert.ok(harness.seeded.grants['anaViews'] !== undefined);
			assert.throws(() => harness.url, {
				message: 'the harness runs no controller now',
			});
			assert.deepEqual(harness.applications, []);
			assert.throws(() => harness.application('arranger-test'), {
				message: 'the harness registered no application arranger-test',
			});
			await assert.rejects(
				harness.tokens.signIn({
					email: 'ana@example.org',
					subject: 'ana-subject',
				}),
				{
					message: 'the harness registered no application to sign in to',
				},
			);
			await recordForeignFingerprint(harness.clients.migration);
			await assert.rejects(
				harness.restart({ autoAccept: true }),
				refusalNaming(ENVIRONMENT_VARIABLES.keyEncryptionKey),
			);
			assert.equal(harness.configuration.autoAccept, true);
		} finally {
			await harness.stop();
		}
		assert.equal(await databaseCount(harness.database.name), 0);
	});

	test('uses a stand-in the test started, and leaves it running once the harness stops', async (context) => {
		const given = await startIdentityProvider();
		context.after(() => given.stop());

		const harness = await startHarness({
			identityProvider: given,
			startsController: false,
			template: STARTED_STORE_TEMPLATE,
		});
		const used = harness.identityProvider === given;
		const issuer = harness.configuration.identityProviderIssuer;
		await harness.stop();

		assert.equal(used, true);
		assert.equal(issuer, given.issuer);
		assert.equal((await fetch(`${given.issuer}/.well-known/openid-configuration`)).status, 200);
	});
});

suite("a harness's connections, its PostgreSQL stopped under them", () => {
	test('fails the query made next on each, rather than ending the test process, and stops once the PostgreSQL is back', async (context) => {
		const dedicated = await startDedicatedPostgresql();
		context.after(() => dedicated.remove());
		const harness = await startHarness({
			postgresql: dedicated,
			startsController: false,
			template: STARTED_STORE_TEMPLATE,
		});
		const ended = Promise.all(
			[harness.clients.migration, harness.clients.runtime].map(
				(client) =>
					new Promise<void>((resolve) => {
						client.once('end', () => resolve());
					}),
			),
		);

		// The harness stops whatever fails, so nothing it started holds the test process open; its
		// database closes only once the PostgreSQL is back.
		try {
			await dedicated.stop();
			const endedWithin = await Promise.race([ended.then(() => 'ended'), delay(15_000).then(() => 'still open')]);
			const queried = await Promise.all(
				[harness.clients.migration, harness.clients.runtime].map((client) =>
					client.query('SELECT 1').then(
						() => 'answered',
						() => 'failed',
					),
				),
			);

			assert.equal(endedWithin, 'ended');
			assert.deepEqual(queried, ['failed', 'failed']);
		} finally {
			await dedicated.restart();
			await harness.stop();
		}
	});
});

suite('a harness for one test', () => {
	test('stops the harness once the work ends, whether or not it succeeded', async () => {
		const seen: { name?: string } = {};

		await assert.rejects(
			withHarness({ startsController: false, template: STARTED_STORE_TEMPLATE }, async (harness) => {
				seen.name = harness.database.name;
				throw new Error('the work failed');
			}),
			{ message: 'the work failed' },
		);

		assert.equal(await databaseCount(seen.name ?? ''), 0);
	});

	test("given the test's context, stops after the cleanups the test defers once it started, and before those deferred earlier", async (context) => {
		const order: string[] = [];
		const seen: { name?: string } = {};
		const held = async (): Promise<number | undefined> => databaseCount(seen.name ?? '');

		await context.test('a test starting an instance on its harness', async (inner) => {
			cleanupFor(inner).defer(async () => {
				order.push(`the earlier step, databases ${await held()}`);
			});
			await withHarness(
				{ startsController: false, template: STARTED_STORE_TEMPLATE },
				async (harness) => {
					seen.name = harness.database.name;
					cleanupFor(inner).defer(async () => {
						const { rows } = await harness.clients.migration.query<{
							one: number;
						}>('SELECT 1 AS one');
						order.push(`the later step, read ${rows[0]?.one}`);
					});
				},
				inner,
			);
			order.push(`the work, databases ${await held()}`);
		});

		assert.deepEqual(order, ['the work, databases 1', 'the later step, read 1', 'the earlier step, databases 0']);
	});
});

suite('a harness one suite shares', () => {
	const shared = suiteHarness({
		startsController: false,
		template: STARTED_STORE_TEMPLATE,
	});
	const names: string[] = [];

	test('starts once, at the first test asking', async () => {
		names.push((await shared()).database.name);
	});

	test('gives every later test the same harness', async () => {
		names.push((await shared()).database.name);

		assert.equal(new Set(names).size, 1);
	});
});

suite('a shared harness whose start fails', () => {
	const attempts = { count: 0 };
	const shared = suiteHarness(() => {
		attempts.count += 1;
		return { template: schemaOnly };
	});

	test('reports the failure to the test asking', async () => {
		await assert.rejects(shared(), refusalNaming(ENVIRONMENT_VARIABLES.databaseSchema));
	});

	test('tries the start again for the next test asking', async () => {
		await assert.rejects(shared(), refusalNaming(ENVIRONMENT_VARIABLES.databaseSchema));

		assert.equal(attempts.count, 2);
	});
});

suite('a configuration only read', () => {
	test('points the stores and the identity provider at loopback, and takes the overrides', () => {
		const configuration = configurationToRead({ autoAccept: true });

		assert.equal(new URL(configuration.cacheUrl).hostname, '127.0.0.1');
		assert.equal(new URL(configuration.databaseUrl).hostname, '127.0.0.1');
		assert.equal(configuration.identityProviderIssuer, 'http://127.0.0.1:8080/realms/usher-test');
		assert.ok(configuration.cachePassword.length > 0);
		assert.ok(configuration.databasePassword.length > 0);
		assert.ok(isCanonicalKey(configuration.keyEncryptionKey));
		assert.equal(configuration.autoAccept, true);
	});
});

suite("batch 2's configuration defaults", () => {
	test('sets the character set, the self-grant maximum, the submitter category, the event source, the instance, the grant rate and no directory or trusted proxy', () => {
		const configuration = harnessConfiguration(SETTINGS);

		assert.deepEqual(
			{
				allowedCharactersExtra: configuration.allowedCharactersExtra,
				directoryUrl: configuration.directoryUrl,
				eventSource: configuration.eventSource,
				grantRateThreshold: configuration.grantRateThreshold,
				instanceName: configuration.instanceName,
				selfGrantMaximumLifetimeSeconds: configuration.selfGrantMaximumLifetimeSeconds,
				submitterCategory: configuration.submitterCategory,
				trustedProxies: configuration.trustedProxies,
			},
			{
				allowedCharactersExtra: '',
				directoryUrl: '',
				eventSource: HARNESS_EVENT_SOURCE,
				grantRateThreshold: { operationCount: 100, windowSeconds: 60 },
				instanceName: 'usher-test-1',
				selfGrantMaximumLifetimeSeconds: 86_400,
				submitterCategory: 'global.unmarked',
				trustedProxies: [],
			},
		);
	});
});

suite('a second controller instance beside the harness', () => {
	test("starts through the seam on the harness's configuration and the overrides, answering readiness at its own URL", async (context) => {
		const harness = await startHarness({
			startsController: false,
			template: STARTED_STORE_TEMPLATE,
		});
		context.after(() => harness.stop());

		const instance = await startInstance(cleanupFor(context), harness, {
			instanceName: 'usher-test-2',
		});
		const readiness = await readReadiness(instance.url);

		assert.equal(instance.configuration.instanceName, 'usher-test-2');
		assert.equal(instance.configuration.keyEncryptionKey, harness.configuration.keyEncryptionKey);
		assert.equal(readiness.status, 200);
	});
});

suite('the timing settings', () => {
	test('default to production values, a store timeout above a loaded start, and compress to a 0.5 s heartbeat, 10 s tokens, a 20 s retention floor and a 250 ms store timeout', () => {
		const usual = harnessConfiguration(SETTINGS);
		const compressed = harnessConfiguration({
			...SETTINGS,
			overrides: COMPRESSED_CONTROLLER_TIMING,
		});

		assert.deepEqual(
			{
				egoImportBaseTier: usual.egoImportBaseTier,
				egoImportPrefixes: usual.egoImportPrefixes,
				heartbeatMilliseconds: usual.heartbeatMilliseconds,
				noticePageLimit: usual.noticePageLimit,
				noticeRereadMilliseconds: usual.noticeRereadMilliseconds,
				streamMaximumLifetimeSeconds: usual.streamMaximumLifetimeSeconds,
				tokenLifetimeSeconds: usual.tokenLifetimeSeconds,
			},
			{
				egoImportBaseTier: null,
				egoImportPrefixes: [],
				heartbeatMilliseconds: 10_000,
				noticePageLimit: 500,
				noticeRereadMilliseconds: 2000,
				streamMaximumLifetimeSeconds: 900,
				tokenLifetimeSeconds: 300,
			},
		);
		assert.equal(usual.storeTimeoutMilliseconds, HARNESS_STORE_TIMEOUT_MILLISECONDS);
		assert.equal(usual.tokenLifetimeSeconds, RETENTION_DEFAULTS.tokenLifetimeSeconds);
		assert.equal(retentionFloorSeconds(usual), retentionFloorSeconds(RETENTION_DEFAULTS));
		assert.equal(compressed.heartbeatMilliseconds, 500);
		assert.equal(compressed.tokenLifetimeSeconds, 10);
		assert.equal(retentionFloorSeconds(compressed), 20);
		assert.equal(compressed.storeTimeoutMilliseconds, 250);
	});
});

suite('the reload interval of the live application keys', () => {
	test('is 30 s, a constant of the harness rather than a setting of the controller', () => {
		assert.equal(APPLICATION_KEY_RELOAD_INTERVAL_MILLISECONDS, 30_000);
		assert.deepEqual(
			Object.values(ENVIRONMENT_VARIABLES).filter((name) => name.includes('RELOAD')),
			[],
		);
	});
});

const NOTICES_TABLE_FIXTURE: PolicyFixture = {
	applications: { 'arranger-test': { serves: ['STUDY-A1'] } },
	resources: { 'STUDY-A1': { baseTier: 'open', name: 'A1' } },
	users: { ana: { subject: 'ana-subject' } },
};

suite("a harness's controller, stopped and started apart", () => {
	test('stops none when none runs, and fails a start its controller refuses, leaving none running', async (context) => {
		const harness = await startHarness({
			startsController: false,
			template: STARTED_STORE_TEMPLATE,
		});
		context.after(() => harness.stop());
		await recordForeignFingerprint(harness.clients.migration);

		await harness.stopController();

		await assert.rejects(
			harness.startController({ autoAccept: true }),
			refusalNaming(ENVIRONMENT_VARIABLES.keyEncryptionKey),
		);
		assert.equal(harness.configuration.autoAccept, true);
		assert.throws(() => harness.url, {
			message: 'the harness runs no controller now',
		});
	});
});

suite('a snapshot of a running harness, restored', () => {
	test('restores the store, writes a new epoch, and starts a controller after, which the restored fingerprint refuses', async (context) => {
		const harness = await startHarness({
			fixture: NOTICES_TABLE_FIXTURE,
			startsController: false,
			template: STARTED_STORE_TEMPLATE,
		});
		context.after(() => harness.stop());
		const { migration } = harness.clients;
		await recordForeignFingerprint(migration);
		await insertNotices(migration, [{ kind: 'baseline' }]);
		const positions = await noticePositions(migration);
		const stream = await readNoticeStream(migration);
		const snapshot = await takeSnapshot(harness);
		await seedPolicy(migration, {
			resources: { 'STUDY-B2': { baseTier: 'grant', name: 'B2' } },
		});
		await insertNotices(migration, [{ kind: 'signOutEveryone' }, { kind: 'signOutEveryone' }]);

		await assert.rejects(restoreSnapshot(harness, snapshot), refusalNaming(ENVIRONMENT_VARIABLES.keyEncryptionKey));

		assert.deepEqual(await storedExternalIds(migration), ['STUDY-A1']);
		assert.deepEqual(await noticePositions(migration), positions);
		assert.notEqual((await readNoticeStream(migration)).epoch, stream.epoch);
	});

	test("keeps the snapshot's epoch when told to, for a restore behind issued cursors", async (context) => {
		const harness = await startHarness({
			startsController: false,
			template: STARTED_STORE_TEMPLATE,
		});
		context.after(() => harness.stop());
		const { migration } = harness.clients;
		await recordForeignFingerprint(migration);
		const stream = await readNoticeStream(migration);
		const snapshot = await takeSnapshot(harness);
		await insertNotices(migration, [{ kind: 'baseline' }]);

		await assert.rejects(
			restoreSnapshot(harness, snapshot, { epoch: 'kept' }),
			refusalNaming(ENVIRONMENT_VARIABLES.keyEncryptionKey),
		);

		assert.equal((await readNoticeStream(migration)).epoch, stream.epoch);
		assert.deepEqual(await noticePositions(migration), []);
	});
});

suite('the read-only role', () => {
	test('reads the store and writes nothing, refuses an instance on it whose start would record the fingerprint, and starts one writing nothing once a start under the runtime role has recorded it', async (context) => {
		const scope = cleanupFor(context);
		const harness = await startHarness({
			fixture: NOTICES_TABLE_FIXTURE,
			startsController: false,
			template: STARTED_STORE_TEMPLATE,
		});
		scope.defer(() => harness.stop());
		const reader = new pg.Client({
			connectionString: await harness.database.readOnlyUrl(),
		});
		await reader.connect();
		scope.defer(() => reader.end());

		const { rows } = await reader.query<{ external_id: string }>('SELECT external_id FROM usher.resources');
		const written = await reader
			.query("INSERT INTO usher.notices (kind, created_at) VALUES ('signOutEveryone', now())")
			.then(
				() => 'written',
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);

		const refused = await startReadOnlyInstance(scope, harness).then(
			() => 'started',
			(refusal: unknown) => (refusal instanceof Error ? refusal.message : String(refusal)),
		);
		const recording = await startInstance(scope, harness);
		await recording.stop();
		const recorded = await takeSnapshot(harness);
		const readOnly = await startReadOnlyInstance(scope, harness);
		const readiness = await readReadiness(readOnly.url);

		assert.deepEqual(rows, [{ external_id: 'STUDY-A1' }]);
		assert.match(written, /permission denied/u);
		assert.match(refused, refusalNaming(ENVIRONMENT_VARIABLES.keyEncryptionKey).message);
		assert.equal(readiness.status, 200);
		assert.deepEqual(await takeSnapshot(harness), recorded);
	});
});
