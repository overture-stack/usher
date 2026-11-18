import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, suite, test } from 'node:test';

import { parseIntoClientConfig } from 'pg-connection-string';

import { StartRefusal } from '../failures/index.js';
import {
  ENVIRONMENT_VARIABLES,
  SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES,
} from './environmentVariables.js';
import { readSchemaMigrationConfiguration } from './readSchemaMigrationConfiguration.js';
import type { ConfigurationEnvironment } from './types.js';

const { databasePassword, databaseUrl } =
  SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES;

const {
  databaseAllowUnverifiedConnection,
  databasePassword: controllerPassword,
  databaseSchema,
  databaseUrl: controllerUrl,
  retentionGraceSeconds,
  retentionMarginSeconds,
  tokenLifetimeSeconds,
} = ENVIRONMENT_VARIABLES;

// A password holding characters a URL escapes, and whitespace kept as given.
const SCHEMA_MIGRATION_PASSWORD = ` ${randomBytes(12).toString('base64url')}/@:% `;

// Every variable the schema migration command requires, and no other.
const REQUIRED: ConfigurationEnvironment = {
  [controllerUrl]: 'postgres://usher_controller@127.0.0.1:5432/usher',
  [databasePassword]: SCHEMA_MIGRATION_PASSWORD,
  [databaseSchema]: 'usher',
  [databaseUrl]: 'postgres://usher_migration@127.0.0.1:5432/usher',
};

const refusalOf = (environment: ConfigurationEnvironment): StartRefusal => {
  try {
    readSchemaMigrationConfiguration(environment);
  } catch (refusal) {
    if (refusal instanceof StartRefusal) {
      return refusal;
    }
    throw refusal;
  }
  return assert.fail(
    'the configuration was read, where a refusal was expected',
  );
};

suite("reading the schema migration command's configuration", () => {
  test("reads every variable into its field, the runtime role the one the controller's URL names and the retention floor the sum of its durations", () => {
    const configuration = readSchemaMigrationConfiguration({
      ...REQUIRED,
      [retentionGraceSeconds]: '10',
      [retentionMarginSeconds]: '5',
      [tokenLifetimeSeconds]: '120',
    });

    assert.deepEqual(configuration, {
      databaseAllowUnverifiedConnection: false,
      databasePassword: SCHEMA_MIGRATION_PASSWORD,
      databaseUrl: 'postgres://usher_migration@127.0.0.1:5432/usher',
      retentionFloorSeconds: 135,
      runtimeRole: 'usher_controller',
      schema: 'usher',
    });
  });

  test("takes the controller's defaults for the floor's durations, a 390 s floor", () => {
    const configuration = readSchemaMigrationConfiguration(REQUIRED);

    assert.equal(configuration.retentionFloorSeconds, 300 + 60 + 30);
  });

  test("refuses each required variable left unset, naming every one in one refusal opening with the schema migrations' refusal to run", () => {
    const refusal = refusalOf({});

    assert.deepEqual(refusal.variables, [
      databasePassword,
      databaseUrl,
      controllerUrl,
      databaseSchema,
    ]);
    assert.equal(
      refusal.message,
      `the schema migrations refuse to run: ${databasePassword} is missing; ${databaseUrl} is missing; ${controllerUrl} is missing; ${databaseSchema} is missing`,
    );
  });

  test("takes the runtime role as the driver reads the controller's URL: its last user parameter, else its user information, decoded", () => {
    const cases = [
      {
        role: 'usher controller',
        url: 'postgres://usher%20controller@127.0.0.1:5432/usher',
      },
      {
        role: 'usher_controller',
        url: 'postgres://127.0.0.1:5432/usher?user=usher_controller',
      },
      {
        role: 'usher_controller',
        url: 'postgres://usher_other@127.0.0.1:5432/usher?user=usher_controller',
      },
      {
        role: 'usher_controller',
        url: 'postgres://usher_other@127.0.0.1:5432/usher?user=usher_other&user=usher_controller',
      },
      {
        role: 'usher_controller',
        url: 'postgres://usher_controller@127.0.0.1:5432/usher?user=',
      },
    ];

    const read = cases.map(({ url }) => ({
      driver: parseIntoClientConfig(url).user,
      runtimeRole: readSchemaMigrationConfiguration({
        ...REQUIRED,
        [controllerUrl]: url,
      }).runtimeRole,
    }));

    assert.deepEqual(
      read,
      cases.map(({ role }) => ({ driver: role, runtimeRole: role })),
    );
  });

  test("refuses a controller's URL naming no database role, naming its variable and never its value", () => {
    const urls = [
      'postgres://127.0.0.1:5432/usher',
      'postgres://@127.0.0.1:5432/usher',
      'postgres://127.0.0.1:5432/usher?user=',
    ];

    const refusals = urls.map((url) =>
      refusalOf({ ...REQUIRED, [controllerUrl]: url }),
    );

    refusals.forEach((refusal) => {
      assert.deepEqual(refusal.variables, [controllerUrl]);
      assert.equal(
        refusal.message,
        `the schema migrations refuse to run: ${controllerUrl} names no database role; it must name the role the controller connects as`,
      );
    });
  });

  test('refuses a schema migration URL naming no database role, naming its variable and never its value', () => {
    const urls = [
      'postgres://127.0.0.1:5432/usher',
      'postgres://@127.0.0.1:5432/usher',
      'postgres://127.0.0.1:5432/usher?user=',
      'postgres://%zz@127.0.0.1:5432/usher',
    ];

    const refusals = urls.map((url) =>
      refusalOf({ ...REQUIRED, [databaseUrl]: url }),
    );

    refusals.forEach((refusal) => {
      assert.deepEqual(refusal.variables, [databaseUrl]);
      assert.equal(
        refusal.message,
        `the schema migrations refuse to run: ${databaseUrl} names no database role; it must name the schema migration role`,
      );
    });
  });

  test('reads a schema migration URL naming its role as a user parameter alone, which the driver also uses', () => {
    const url = 'postgres://127.0.0.1:5432/usher?user=usher_migration';

    const configuration = readSchemaMigrationConfiguration({
      ...REQUIRED,
      [databaseUrl]: url,
    });

    assert.equal(configuration.databaseUrl, url);
    assert.equal(parseIntoClientConfig(url).user, 'usher_migration');
  });

  test("refuses a controller's URL carrying a password, naming the controller's password variable and never the password", () => {
    const marker = `secret-${randomUUID()}`;

    const refusal = refusalOf({
      ...REQUIRED,
      [controllerUrl]: `postgres://usher_controller:${marker}@127.0.0.1:5432/usher`,
    });

    assert.deepEqual(refusal.variables, [controllerUrl]);
    assert.match(
      refusal.message,
      new RegExp(`read from ${controllerPassword}`, 'u'),
    );
    assert.equal(
      JSON.stringify(refusal, Object.getOwnPropertyNames(refusal)).includes(
        marker,
      ),
      false,
    );
  });

  test("never reads the controller's password, which it never needs", () => {
    const asked = new Set<string>();
    const environment = new Proxy(
      { ...REQUIRED, [controllerPassword]: 'set' },
      {
        get: (target, name, receiver): unknown => {
          asked.add(String(name));
          return Reflect.get(target, name, receiver);
        },
      },
    );

    readSchemaMigrationConfiguration(environment);

    assert.equal(asked.has(controllerUrl), true);
    assert.equal(asked.has(controllerPassword), false);
  });

  test('refuses a URL carrying a password, in its user information or as a parameter, naming the variable holding the URL and never the password', () => {
    const marker = `secret-${randomUUID()}`;

    const refusals = [
      `postgres://usher_migration:${marker}@127.0.0.1:5432/usher`,
      `postgres://usher_migration@127.0.0.1:5432/usher?password=${marker}`,
    ].map((url) => refusalOf({ ...REQUIRED, [databaseUrl]: url }));

    refusals.forEach((refusal) => {
      assert.deepEqual(refusal.variables, [databaseUrl]);
      assert.match(
        refusal.message,
        new RegExp(`read from ${databasePassword}`, 'u'),
      );
      assert.equal(
        JSON.stringify(refusal, Object.getOwnPropertyNames(refusal)).includes(
          marker,
        ),
        false,
      );
    });
  });

  test("refuses a URL that is not PostgreSQL's", () => {
    const refusal = refusalOf({
      ...REQUIRED,
      [databaseUrl]: 'redis://127.0.0.1:6379',
    });

    assert.deepEqual(refusal.variables, [databaseUrl]);
  });

  test('refuses durations whose floor is more than its column holds, laying the fault on each', () => {
    const refusal = refusalOf({
      ...REQUIRED,
      [retentionGraceSeconds]: '1',
      [tokenLifetimeSeconds]: '2147483647',
    });

    assert.deepEqual(refusal.variables, [
      retentionGraceSeconds,
      retentionMarginSeconds,
      tokenLifetimeSeconds,
    ]);
    assert.match(refusal.message, /more than 2147483647 seconds/u);
  });
});

suite("verifying the schema migration command's database connection", () => {
  const folder = mkdtempSync(join(tmpdir(), 'usher-migration-configuration-'));
  after(() => rmSync(folder, { force: true, recursive: true }));
  const caFile = join(folder, 'root.crt');
  writeFileSync(caFile, '-----BEGIN CERTIFICATE-----\n');

  const REMOTE = 'postgres://usher_migration@db.example.org:5432/usher';

  test('takes its own connection to a loopback host, or to any other host verifying the server', () => {
    const urls = [
      'postgres://usher_migration@localhost:5432/usher',
      `${REMOTE}?sslmode=verify-full`,
      `${REMOTE}?sslmode=verify-ca&sslrootcert=${caFile}`,
    ];

    const read = urls.map(
      (url) =>
        readSchemaMigrationConfiguration({ ...REQUIRED, [databaseUrl]: url })
          .databaseUrl,
    );

    assert.deepEqual(read, urls);
  });

  test("refuses its own connection leaving the host unverified, require included, naming the command's variable and the rule, and judges the host the driver connects to", () => {
    const urls = [
      `${REMOTE}?sslmode=require`,
      REMOTE,
      'postgres://usher_migration@127.0.0.1:5432/usher?host=db.example.org',
    ];

    const refusals = urls.map((url) =>
      refusalOf({ ...REQUIRED, [databaseUrl]: url }),
    );

    refusals.forEach((refusal) => {
      assert.equal(
        refusal.message,
        `the schema migrations refuse to run: ${databaseUrl} connects to a host other than a loopback host or a Unix socket without verifying the server: set sslmode=verify-full, or sslmode=verify-ca with sslrootcert`,
      );
    });
  });

  test('refuses its own URL naming a CA file in sslrootcert that cannot be read, naming the setting and never the path', () => {
    const missing = join(folder, 'missing.crt');

    const refusal = refusalOf({
      ...REQUIRED,
      [databaseUrl]: `${REMOTE}?sslmode=verify-full&sslrootcert=${missing}`,
    });

    assert.deepEqual(refusal.variables, [databaseUrl]);
    assert.match(
      refusal.message,
      /names a file in sslrootcert that cannot be read/u,
    );
    assert.equal(refusal.message.includes(missing), false);
  });

  test("takes any connection of its own while the controller's USHER_DATABASE_ALLOW_UNVERIFIED_CONNECTION is true, reading that switch as the controller does", () => {
    const configuration = readSchemaMigrationConfiguration({
      ...REQUIRED,
      [databaseAllowUnverifiedConnection]: 'true',
      [databaseUrl]: `${REMOTE}?sslmode=require`,
    });
    const refusal = refusalOf({
      ...REQUIRED,
      [databaseAllowUnverifiedConnection]: 'yes',
      [databaseUrl]: `${REMOTE}?sslmode=require`,
    });

    assert.equal(configuration.databaseAllowUnverifiedConnection, true);
    assert.equal(configuration.databaseUrl, `${REMOTE}?sslmode=require`);
    assert.deepEqual(refusal.variables, [
      databaseAllowUnverifiedConnection,
      databaseUrl,
    ]);
  });

  test("judges its own connection alone, never the controller's URL, which it reads for the runtime role", () => {
    const configuration = readSchemaMigrationConfiguration({
      ...REQUIRED,
      [controllerUrl]: 'postgres://usher_controller@db.example.org:5432/usher',
    });

    assert.equal(configuration.runtimeRole, 'usher_controller');
  });
});
