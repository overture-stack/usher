import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { suite, test } from 'node:test';

import {
  captureLog,
  changedVariables,
  type ControllerConfiguration,
  ENVIRONMENT_VARIABLES,
  environmentFor,
  type FieldWithVariable,
  readRefusal,
  refusalText,
} from './controller.js';

const discarding = (): Writable =>
  new Writable({
    write: (_chunk, _encoding, callback) => {
      callback();
    },
  });

const syntheticKey = (fill: number): string =>
  Buffer.alloc(32, fill).toString('base64url');

const freshSecret = (): string => randomBytes(32).toString('base64url');

const CONFIGURATION: ControllerConfiguration = {
  administratorRole: 'usher-platform-admin',
  allowedCharactersExtra: '',
  autoAccept: false,
  backChannelLogoutAudiences: ['portal-test'],
  baseline: ['count', 'view', 'export'],
  cachePassword: freshSecret(),
  cacheUrl: 'redis://127.0.0.1:6379',
  clock: { now: () => Date.UTC(2026, 0, 1) },
  cursorKey: syntheticKey(3),
  databasePassword: freshSecret(),
  databaseSchema: 'usher',
  databaseUrl: 'postgres://usher_controller@127.0.0.1:5432/usher_test',
  directoryClientId: 'usher-directory',
  directoryClientSecret: syntheticKey(6),
  directoryRealm: 'usher-test',
  directoryUrl: 'http://127.0.0.1:8080',
  egoMigrationAllStudyPolicies: [],
  egoMigrationBaseTier: null,
  egoMigrationPrefixes: [],
  eventSource: 'https://usher.example.org/controller',
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
  platformDefaultAccessLevel: 'registered',
  port: 0,
  retentionGraceSeconds: 60,
  retentionMarginSeconds: 30,
  selfGrantMaximumSeconds: 86_400,
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
  administratorRole: 'ims-usher-admin',
  allowedCharactersExtra: ' :*/Éé',
  autoAccept: true,
  backChannelLogoutAudiences: ['portal-test', 'submission-test'],
  baseline: [],
  cachePassword: freshSecret(),
  cacheUrl: 'redis://127.0.0.1:6380',
  cursorKey: syntheticKey(5),
  databasePassword: freshSecret(),
  databaseSchema: 'usher_other',
  databaseUrl: 'postgres://usher_controller@127.0.0.1:5433/usher_test',
  directoryClientId: 'usher-directory-other',
  directoryClientSecret: syntheticKey(7),
  directoryRealm: 'overture',
  directoryUrl: 'https://auth.example.org',
  egoMigrationAllStudyPolicies: ['ENVIRONMENTAL', 'ALL, STUDIES'],
  egoMigrationBaseTier: 'grant',
  egoMigrationPrefixes: [''],
  eventSource: 'https://usher-two.example.org/controller',
  grantRateThreshold: { operationCount: 3, windowSeconds: 5 },
  heartbeatMilliseconds: 500,
  host: '::1',
  identityProviderIssuer: 'https://auth.example.org/realms/usher',
  instanceName: 'usher-test-2',
  issuer: 'https://usher-two.example.org',
  keyEncryptionKey: freshSecret(),
  managementAudience: 'usher-management-other',
  managementClients: ['usher-ui-test', 'usher-cli-test'],
  noticePageLimit: 20,
  noticeRereadMilliseconds: 250,
  platformDefaultAccessLevel: 'open',
  port: 8443,
  retentionGraceSeconds: 90,
  retentionMarginSeconds: 45,
  selfGrantMaximumSeconds: 14_400,
  signInTokenMaximumLifetimeSeconds: 900,
  signedInRule: ['view'],
  storeTimeoutMilliseconds: 250,
  streamLimitPerAudience: 2,
  streamMaximumLifetimeSeconds: 60,
  streamQueueLimit: 10,
  submitterCategory: 'global.controlled',
  tokenLifetimeSeconds: 120,
  trustedProxies: ['127.0.0.1', '::1'],
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
      Object.keys(CONFIGURATION).length - 2,
    );
  });

  test('names every variable it writes in the exported map, and no other', () => {
    assert.deepEqual(
      Object.values(ENVIRONMENT_VARIABLES).toSorted(),
      Object.keys(environmentFor(CONFIGURATION)).toSorted(),
    );
    assert.equal(
      ENVIRONMENT_VARIABLES.streamQueueLimit,
      changedVariables(
        environmentFor(CONFIGURATION),
        environmentFor({ ...CONFIGURATION, streamQueueLimit: 7 }),
      )[0],
    );
  });

  test("carries the key-encryption key and each store's password as given, each in a variable of its own", () => {
    const environment = environmentFor(CONFIGURATION);

    assert.deepEqual(
      [
        environment[ENVIRONMENT_VARIABLES.keyEncryptionKey],
        environment[ENVIRONMENT_VARIABLES.databasePassword],
        environment[ENVIRONMENT_VARIABLES.cachePassword],
      ],
      [
        CONFIGURATION.keyEncryptionKey,
        CONFIGURATION.databasePassword,
        CONFIGURATION.cachePassword,
      ],
    );
    assert.deepEqual(
      [
        ENVIRONMENT_VARIABLES.keyEncryptionKey,
        ENVIRONMENT_VARIABLES.databasePassword,
        ENVIRONMENT_VARIABLES.cachePassword,
      ],
      [
        'USHER_KEY_ENCRYPTION_KEY',
        'USHER_DATABASE_PASSWORD',
        'USHER_CACHE_PASSWORD',
      ],
    );
  });

  test('gives every other field a variable of its own', () => {
    const base = environmentFor(CONFIGURATION);
    const changedByField = Object.entries(OTHER_VALUES).map(([field, value]) =>
      changedVariables(
        base,
        environmentFor({ ...CONFIGURATION, [field]: value }),
      ),
    );

    assert.ok(changedByField.every((changed) => changed.length === 1));
    assert.equal(
      new Set(changedByField.flat()).size,
      Object.keys(OTHER_VALUES).length,
    );
  });
});

suite('the helpers for a refusal test', () => {
  test('names the variables two environments differ in, sorted', () => {
    assert.deepEqual(
      changedVariables(
        environmentFor(CONFIGURATION),
        environmentFor({ ...CONFIGURATION, port: 9, tokenLifetimeSeconds: 60 }),
      ),
      [
        ENVIRONMENT_VARIABLES.port,
        ENVIRONMENT_VARIABLES.tokenLifetimeSeconds,
      ].toSorted(),
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

    assert.deepEqual(capture.lines(), [
      '{"type":"first"}',
      '{"type":"second"}',
    ]);
  });
});
