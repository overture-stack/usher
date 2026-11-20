import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { suite, test } from 'node:test';

import { DEFAULT_GRANT_RULES } from '../../src/settings/readGrantRules.js';

import {
	captureLog,
	changedVariables,
	type ControllerConfiguration,
	ENVIRONMENT_VARIABLES,
	environmentFor,
	type FieldWithVariable,
	grantRulesOf,
	type PendingSettings,
	SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES,
	schemaMigrationEnvironmentFor,
	readRefusal,
	refusalText,
	type StoredField,
	storedSettingsOf,
} from './controller.js';

const discarding = (): Writable =>
	new Writable({
		write: (_chunk, _encoding, callback) => {
			callback();
		},
	});

const syntheticKey = (fill: number): string => Buffer.alloc(32, fill).toString('base64url');

const freshSecret = (): string => randomBytes(32).toString('base64url');

const CONFIGURATION: ControllerConfiguration = {
	allowedCharactersExtra: '',
	apiDocsClient: '',
	autoAccept: false,
	backChannelLogoutAudiences: ['portal-test'],
	baseline: ['count', 'view', 'export'],
	cachePassword: freshSecret(),
	cacheUrl: 'redis://127.0.0.1:6379',
	clock: { now: () => Date.UTC(2026, 0, 1) },
	cursorKey: syntheticKey(3),
	databaseAllowUnverifiedConnection: false,
	databaseControlConnections: 5,
	databaseExchangeConnections: 10,
	databasePassword: freshSecret(),
	databaseSchema: 'usher',
	databaseUrl: 'postgres://usher_controller@127.0.0.1:5432/usher_test',
	directoryClientId: 'usher-directory',
	directoryClientSecret: syntheticKey(6),
	directoryRealm: 'usher-test',
	directoryUrl: 'http://127.0.0.1:8080',
	egoImportAllStudyPolicies: [],
	egoImportBaseTier: null,
	egoImportPrefixes: [],
	eventSource: 'https://usher.example.org/controller',
	firstUserRole: 'usher-first-user',
	grantRateThreshold: { operationCount: 100, windowSeconds: 60 },
	heartbeatMilliseconds: 10_000,
	host: '127.0.0.1',
	identityProviderIssuer: 'http://127.0.0.1:8080/realms/usher-test',
	instanceName: 'usher-test-1',
	issuer: 'https://usher.example.org',
	keyEncryptionKey: freshSecret(),
	logStream: process.stdout,
	managementAudience: 'usher-management-test',
	managementClients: ['usher-ui-test'],
	noticePageLimit: 500,
	noticeRereadMilliseconds: 2000,
	port: 0,
	retentionGraceSeconds: 60,
	retentionMarginSeconds: 30,
	selfGrantMaximumLifetimeSeconds: 86_400,
	serviceAccountRole: 'usher-service-account',
	signInTokenMaximumLifetimeSeconds: 3600,
	signedInRule: ['count', 'view', 'export'],
	storeTimeoutMilliseconds: 5000,
	streamLimitPerAudience: 64,
	streamMaximumLifetimeSeconds: 900,
	streamQueueLimit: 1000,
	submitterCategory: 'global.unmarked',
	tokenLifetimeSeconds: 300,
	trustedProxies: [],
};

const OTHER_VALUES: {
	[Field in FieldWithVariable]: ControllerConfiguration[Field];
} = {
	apiDocsClient: 'usher-ui-test',
	backChannelLogoutAudiences: ['portal-test', 'submission-test'],
	cursorKey: syntheticKey(5),
	databaseAllowUnverifiedConnection: true,
	databaseControlConnections: 3,
	databaseExchangeConnections: 12,
	databasePassword: freshSecret(),
	databaseSchema: 'usher_other',
	databaseUrl: 'postgres://usher_controller@127.0.0.1:5433/usher_test',
	directoryClientId: 'usher-directory-other',
	directoryClientSecret: syntheticKey(7),
	directoryRealm: 'overture',
	directoryUrl: 'https://auth.example.org',
	host: '::1',
	identityProviderIssuer: 'https://auth.example.org/realms/usher',
	instanceName: 'usher-test-2',
	keyEncryptionKey: freshSecret(),
	managementAudience: 'usher-management-other',
	managementClients: ['usher-ui-test', 'usher-cli-test'],
	port: 8443,
	serviceAccountRole: 'ims-usher-service',
	storeTimeoutMilliseconds: 250,
	trustedProxies: ['127.0.0.1', '::1'],
};

// A value other than the configuration's for each setting the store holds, as the harness writes it there.
const STORED_VALUES: {
	[Field in StoredField]: ControllerConfiguration[Field];
} = {
	autoAccept: true,
	baseline: [],
	eventSource: 'https://usher-two.example.org/controller',
	firstUserRole: 'ims-usher-first-user',
	heartbeatMilliseconds: 500,
	issuer: 'https://usher-two.example.org',
	noticePageLimit: 20,
	noticeRereadMilliseconds: 250,
	retentionGraceSeconds: 90,
	retentionMarginSeconds: 45,
	selfGrantMaximumLifetimeSeconds: 14_400,
	signInTokenMaximumLifetimeSeconds: 900,
	signedInRule: ['view'],
	streamLimitPerAudience: 2,
	streamMaximumLifetimeSeconds: 60,
	streamQueueLimit: 10,
	submitterCategory: 'global.controlled',
	tokenLifetimeSeconds: 120,
};

// A value other than the configuration's for each setting the Controller does not read yet.
const PENDING_VALUES: {
	[Field in keyof PendingSettings]: PendingSettings[Field];
} = {
	allowedCharactersExtra: ' :*/Éé',
	cachePassword: freshSecret(),
	cacheUrl: 'redis://127.0.0.1:6380',
	egoImportAllStudyPolicies: ['ENVIRONMENTAL', 'ALL, STUDIES'],
	egoImportBaseTier: 'grant',
	egoImportPrefixes: [''],
	grantRateThreshold: { operationCount: 3, windowSeconds: 5 },
};

suite('the environment a configuration is expressed as', () => {
	test('leaves the clock and the log stream out, so no environment can set either', () => {
		const atEpoch = environmentFor({
			...CONFIGURATION,
			clock: { now: () => 0 },
		});
		const later = environmentFor({
			...CONFIGURATION,
			clock: { now: () => Date.UTC(2030, 5, 1) },
			logStream: discarding(),
		});

		assert.deepEqual(atEpoch, later);
		assert.equal(
			Object.keys(atEpoch).length,
			Object.keys(CONFIGURATION).length -
				2 -
				Object.keys(PENDING_VALUES).length -
				Object.keys(STORED_VALUES).length,
		);
	});

	test('names every variable it writes in the exported map, and no other', () => {
		assert.deepEqual(
			Object.values(ENVIRONMENT_VARIABLES).toSorted(),
			Object.keys(environmentFor(CONFIGURATION)).toSorted(),
		);
		assert.equal(
			ENVIRONMENT_VARIABLES.storeTimeoutMilliseconds,
			changedVariables(
				environmentFor(CONFIGURATION),
				environmentFor({ ...CONFIGURATION, storeTimeoutMilliseconds: 7 }),
			)[0],
		);
	});

	test("carries the key-encryption key, the database password and the directory's client secret as given, each in a variable of its own", () => {
		const environment = environmentFor(CONFIGURATION);

		assert.deepEqual(
			[
				environment[ENVIRONMENT_VARIABLES.keyEncryptionKey],
				environment[ENVIRONMENT_VARIABLES.databasePassword],
				environment[ENVIRONMENT_VARIABLES.directoryClientSecret],
			],
			[CONFIGURATION.keyEncryptionKey, CONFIGURATION.databasePassword, CONFIGURATION.directoryClientSecret],
		);
		assert.deepEqual(
			[
				ENVIRONMENT_VARIABLES.keyEncryptionKey,
				ENVIRONMENT_VARIABLES.databasePassword,
				ENVIRONMENT_VARIABLES.directoryClientSecret,
			],
			['USHER_KEY_ENCRYPTION_KEY', 'USHER_DATABASE_PASSWORD', 'USHER_DIRECTORY_CLIENT_SECRET'],
		);
	});

	test('gives every other field a variable of its own', () => {
		const base = environmentFor(CONFIGURATION);
		const changedByField = Object.entries(OTHER_VALUES).map(([field, value]) =>
			changedVariables(base, environmentFor({ ...CONFIGURATION, [field]: value })),
		);

		assert.ok(changedByField.every((changed) => changed.length === 1));
		assert.equal(new Set(changedByField.flat()).size, Object.keys(OTHER_VALUES).length);
	});

	test('gives the controller none of the settings it does not read yet', () => {
		const base = environmentFor(CONFIGURATION);

		const changedByField = Object.entries(PENDING_VALUES).map(([field, value]) =>
			changedVariables(base, environmentFor({ ...CONFIGURATION, [field]: value })),
		);

		assert.ok(changedByField.every((changed) => changed.length === 0));
	});

	test('gives the controller none of the settings the store holds, so the environment never sets a replaced variable', () => {
		const base = environmentFor(CONFIGURATION);

		const changedByField = Object.entries(STORED_VALUES).map(([field, value]) =>
			changedVariables(base, environmentFor({ ...CONFIGURATION, [field]: value })),
		);

		assert.ok(changedByField.every((changed) => changed.length === 0));
	});
});

suite('the settings a configuration gives the store', () => {
	test('gives the grant rules the product default when the baseline and the signed-in rule are the defaults', () => {
		assert.deepEqual(
			grantRulesOf({
				baseline: CONFIGURATION.baseline,
				signedInRule: CONFIGURATION.signedInRule,
			}),
			DEFAULT_GRANT_RULES,
		);
	});

	test('gives the baseline to everyone and to signed-in principals on open resources, and the signed-in rule on registered ones', () => {
		assert.deepEqual(grantRulesOf({ baseline: ['view'], signedInRule: ['count'] }), [
			{
				resources: [
					{
						accessLevel: 'open',
						categories: [{ actions: ['view'], name: 'global.unmarked' }],
					},
				],
				to: 'everyone',
			},
			{
				resources: [
					{
						accessLevel: 'open',
						categories: [{ actions: ['view'], name: 'global.unmarked' }],
					},
					{
						accessLevel: 'registered',
						categories: [{ actions: ['count'], name: 'global.unmarked' }],
					},
				],
				to: 'signedIn',
			},
		]);
	});

	test('gives an empty baseline no category at all, so nothing is read on open resources', () => {
		assert.deepEqual(grantRulesOf({ baseline: [], signedInRule: [] })[0], {
			resources: [{ accessLevel: 'open', categories: [] }],
			to: 'everyone',
		});
	});

	test('gives each stored field its setting, the first user as its realm role', () => {
		assert.deepEqual(storedSettingsOf(CONFIGURATION), {
			eventSource: CONFIGURATION.eventSource,
			firstUser: { realmRole: CONFIGURATION.firstUserRole },
			grantAutoAccept: CONFIGURATION.autoAccept,
			grantRules: DEFAULT_GRANT_RULES,
			heartbeatMilliseconds: CONFIGURATION.heartbeatMilliseconds,
			issuer: CONFIGURATION.issuer,
			noticePageLimit: CONFIGURATION.noticePageLimit,
			noticeRereadMilliseconds: CONFIGURATION.noticeRereadMilliseconds,
			retentionGraceSeconds: CONFIGURATION.retentionGraceSeconds,
			retentionMarginSeconds: CONFIGURATION.retentionMarginSeconds,
			selfGrantMaximumLifetimeSeconds: CONFIGURATION.selfGrantMaximumLifetimeSeconds,
			signInTokenMaximumLifetimeSeconds: CONFIGURATION.signInTokenMaximumLifetimeSeconds,
			streamLimitPerAudience: CONFIGURATION.streamLimitPerAudience,
			streamMaximumLifetimeSeconds: CONFIGURATION.streamMaximumLifetimeSeconds,
			streamQueueLimit: CONFIGURATION.streamQueueLimit,
			submitterCategory: CONFIGURATION.submitterCategory,
			tokenLifetimeSeconds: CONFIGURATION.tokenLifetimeSeconds,
		});
	});
});

suite('the helpers for a refusal test', () => {
	test('names the variables two environments differ in, sorted', () => {
		assert.deepEqual(
			changedVariables(
				environmentFor(CONFIGURATION),
				environmentFor({
					...CONFIGURATION,
					port: 9,
					storeTimeoutMilliseconds: 60,
				}),
			),
			[ENVIRONMENT_VARIABLES.port, ENVIRONMENT_VARIABLES.storeTimeoutMilliseconds].toSorted(),
		);
	});

	test('gives what reading a refused configuration threw, and throws when the configuration is read', async () => {
		const refused = environmentFor({
			...CONFIGURATION,
			keyEncryptionKey: CONFIGURATION.keyEncryptionKey.slice(0, 42),
		});

		const refusal = await readRefusal(refused);

		assert.ok(refusal instanceof Error);
		assert.match(refusalText(refusal), /USHER_KEY_ENCRYPTION_KEY/u);
		await assert.rejects(readRefusal(environmentFor(CONFIGURATION)), {
			message: 'the configuration was read, where a refusal was expected',
		});
	});

	test('shows everything a refusal carries, its cause and its own members included', () => {
		const refusal = Object.assign(
			new Error('USHER_CURSOR_KEY is 43 base64url characters', {
				cause: new Error('the decoding failed'),
			}),
			{ variable: 'USHER_CURSOR_KEY' },
		);

		const shown = refusalText(refusal);

		assert.match(shown, /USHER_CURSOR_KEY is 43 base64url characters/u);
		assert.match(shown, /the decoding failed/u);
		assert.match(shown, /"variable":"USHER_CURSOR_KEY"/u);
		assert.equal(refusalText('plain'), 'plain');
	});

	test('records every line written to a captured log stream, in order', async () => {
		const capture = captureLog();

		await new Promise<void>((resolve) => {
			capture.stream.write('{"type":"first"}\n{"type":', () => resolve());
		});
		await new Promise<void>((resolve) => {
			capture.stream.write('"second"}\n\n', () => resolve());
		});

		assert.deepEqual(capture.lines(), ['{"type":"first"}', '{"type":"second"}']);
	});
});

suite('the environment a migration run is expressed as', () => {
	test("moves the URL's password to its own variable, names the runtime role as the user of the controller's URL, which carries no password, and names the seed file", () => {
		const password = randomBytes(12).toString('base64url');

		const environment = schemaMigrationEnvironmentFor({
			seedFile: '/run/usher/seed.json',
			databaseUrl: `postgres://usher_migration:${password}@127.0.0.1:5432/usher_test`,
			runtimeRole: 'usher_controller',
			schema: 'usher',
		});

		assert.deepEqual(environment, {
			[SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.seedFile]: '/run/usher/seed.json',
			[ENVIRONMENT_VARIABLES.databaseSchema]: 'usher',
			[ENVIRONMENT_VARIABLES.databaseUrl]: 'postgres://usher_controller@127.0.0.1:5432/usher_test',
			[SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.databasePassword]: password,
			[SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.databaseUrl]:
				'postgres://usher_migration@127.0.0.1:5432/usher_test',
		});
	});
});
