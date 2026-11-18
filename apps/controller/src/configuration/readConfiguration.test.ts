import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, suite, test } from 'node:test';

import { StartRefusal } from '../failures/index.js';
import {
  ENVIRONMENT_VARIABLES,
  SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES,
} from './environmentVariables.js';
import { readConfiguration } from './readConfiguration.js';
import { readSchemaMigrationConfiguration } from './readSchemaMigrationConfiguration.js';
import type {
  ConfigurationEnvironment,
  ControllerConfiguration,
  FieldWithVariable,
} from './types.js';

type FieldValues = Partial<Record<FieldWithVariable, string | undefined>>;

const freshKey = (): string => randomBytes(32).toString('base64url');

const KEY_ENCRYPTION_KEY = freshKey();

const CURSOR_KEY = freshKey();

// Passwords holding characters a URL escapes, and whitespace kept as given.
const DATABASE_PASSWORD = ` ${randomBytes(12).toString('base64url')}/@:% `;

// Every variable the Controller requires, and no other.
const REQUIRED: Readonly<Record<string, string>> = {
  backChannelLogoutAudiences: 'portal-test',
  cursorKey: CURSOR_KEY,
  databasePassword: DATABASE_PASSWORD,
  databaseSchema: 'usher',
  databaseUrl: 'postgres://usher_controller@127.0.0.1:5432/usher',
  eventSource: 'https://usher.example.org/controller',
  host: '127.0.0.1',
  identityProviderIssuer: 'https://auth.example.org/realms/usher',
  instanceName: 'usher-1',
  issuer: 'https://usher.example.org',
  keyEncryptionKey: KEY_ENCRYPTION_KEY,
  managementAudience: 'usher-management',
  managementClients: 'usher-ui',
  port: '8443',
  signInTokenMaximumLifetimeSeconds: '3600',
} satisfies FieldValues;

const BASE64URL =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// 32 bytes leave two bits of the last character unused, which canonical form keeps zero.
const withTrailingBitSet = (key: string): string =>
  `${key.slice(0, -1)}${BASE64URL[BASE64URL.indexOf(key.slice(-1)) | 1] ?? ''}`;

const environmentOf = (values: FieldValues): ConfigurationEnvironment =>
  Object.fromEntries(
    Object.entries(values).map(([field, value]) => [
      ENVIRONMENT_VARIABLES[field as FieldWithVariable],
      value,
    ]),
  );

const environmentWith = (values: FieldValues): ConfigurationEnvironment =>
  environmentOf({ ...REQUIRED, ...values });

const refusalOf = (environment: ConfigurationEnvironment): StartRefusal => {
  try {
    readConfiguration(environment);
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

// Everything a refusal shows a reader, as a test searching it for a value would read it.
const shownBy = (refusal: StartRefusal): string =>
  [
    refusal.message,
    String(refusal.stack),
    JSON.stringify(refusal, Object.getOwnPropertyNames(refusal)),
  ].join('\n');

const fieldsOf = (
  configuration: ControllerConfiguration,
): Omit<ControllerConfiguration, 'clock' | 'logStream'> => {
  const { clock: _clock, logStream: _logStream, ...fields } = configuration;
  return fields;
};

suite('reading the configuration from an environment', () => {
  test('reads every variable into its field', () => {
    const configuration = readConfiguration(
      environmentWith({
        apiDocsClient: 'usher-ui',
        autoAccept: 'true',
        backChannelLogoutAudiences: 'portal-test, submission-test',
        baseline: 'view',
        databaseAllowUnverifiedConnection: 'true',
        databaseControlConnections: '3',
        databaseExchangeConnections: '12',
        firstUserRole: 'ims-usher-first-user',
        heartbeatMilliseconds: '500',
        noticePageLimit: '20',
        noticeRereadMilliseconds: '250',
        retentionGraceSeconds: '0',
        retentionMarginSeconds: '45',
        serviceAccountRole: 'ims-usher-service',
        signedInRule: 'count,view',
        storeTimeoutMilliseconds: '250',
        streamLimitPerAudience: '2',
        streamMaximumLifetimeSeconds: '60',
        streamQueueLimit: '10',
        submitterCategory: 'global.controlled',
        tokenLifetimeSeconds: '120',
        trustedProxies: '127.0.0.1,::1',
      }),
    );

    assert.deepEqual(fieldsOf(configuration), {
      apiDocsClient: 'usher-ui',
      autoAccept: true,
      backChannelLogoutAudiences: ['portal-test', 'submission-test'],
      baseline: ['view'],
      cursorKey: CURSOR_KEY,
      databaseAllowUnverifiedConnection: true,
      databaseControlConnections: 3,
      databaseExchangeConnections: 12,
      databasePassword: DATABASE_PASSWORD,
      databaseSchema: 'usher',
      databaseUrl: 'postgres://usher_controller@127.0.0.1:5432/usher',
      eventSource: 'https://usher.example.org/controller',
      firstUserRole: 'ims-usher-first-user',
      heartbeatMilliseconds: 500,
      host: '127.0.0.1',
      identityProviderIssuer: 'https://auth.example.org/realms/usher',
      instanceName: 'usher-1',
      issuer: 'https://usher.example.org',
      keyEncryptionKey: KEY_ENCRYPTION_KEY,
      managementAudience: 'usher-management',
      managementClients: ['usher-ui'],
      noticePageLimit: 20,
      noticeRereadMilliseconds: 250,
      port: 8443,
      retentionGraceSeconds: 0,
      retentionMarginSeconds: 45,
      serviceAccountRole: 'ims-usher-service',
      signInTokenMaximumLifetimeSeconds: 3600,
      signedInRule: ['count', 'view'],
      storeTimeoutMilliseconds: 250,
      streamLimitPerAudience: 2,
      streamMaximumLifetimeSeconds: 60,
      streamQueueLimit: 10,
      submitterCategory: 'global.controlled',
      tokenLifetimeSeconds: 120,
      trustedProxies: ['127.0.0.1', '::1'],
    });
  });

  test('takes the default named for each variable left unset', () => {
    const configuration = readConfiguration(environmentWith({}));

    assert.deepEqual(
      {
        apiDocsClient: configuration.apiDocsClient,
        autoAccept: configuration.autoAccept,
        baseline: configuration.baseline,
        databaseAllowUnverifiedConnection:
          configuration.databaseAllowUnverifiedConnection,
        databaseControlConnections: configuration.databaseControlConnections,
        databaseExchangeConnections: configuration.databaseExchangeConnections,
        firstUserRole: configuration.firstUserRole,
        heartbeatMilliseconds: configuration.heartbeatMilliseconds,
        noticePageLimit: configuration.noticePageLimit,
        noticeRereadMilliseconds: configuration.noticeRereadMilliseconds,
        retentionGraceSeconds: configuration.retentionGraceSeconds,
        retentionMarginSeconds: configuration.retentionMarginSeconds,
        serviceAccountRole: configuration.serviceAccountRole,
        signedInRule: configuration.signedInRule,
        storeTimeoutMilliseconds: configuration.storeTimeoutMilliseconds,
        streamLimitPerAudience: configuration.streamLimitPerAudience,
        streamMaximumLifetimeSeconds:
          configuration.streamMaximumLifetimeSeconds,
        streamQueueLimit: configuration.streamQueueLimit,
        submitterCategory: configuration.submitterCategory,
        tokenLifetimeSeconds: configuration.tokenLifetimeSeconds,
        trustedProxies: configuration.trustedProxies,
      },
      {
        apiDocsClient: '',
        autoAccept: false,
        baseline: ['count', 'view', 'export'],
        databaseAllowUnverifiedConnection: false,
        databaseControlConnections: 5,
        databaseExchangeConnections: 10,
        firstUserRole: 'usher-first-user',
        heartbeatMilliseconds: 10_000,
        noticePageLimit: 500,
        noticeRereadMilliseconds: 2000,
        retentionGraceSeconds: 60,
        retentionMarginSeconds: 30,
        serviceAccountRole: 'usher-service-account',
        signedInRule: ['count', 'view', 'export'],
        storeTimeoutMilliseconds: 5000,
        streamLimitPerAudience: 64,
        streamMaximumLifetimeSeconds: 900,
        streamQueueLimit: 1000,
        submitterCategory: 'global.unmarked',
        tokenLifetimeSeconds: 300,
        trustedProxies: [],
      },
    );
  });

  test('gives the system clock and the process standard output, which no variable sets', () => {
    const before = Date.now();

    const configuration = readConfiguration(environmentWith({}));

    assert.ok(configuration.clock.now() >= before);
    assert.ok(configuration.clock.now() <= Date.now());
    assert.equal(configuration.logStream, process.stdout);
  });

  test('refuses each required variable left unset, naming every one in one refusal', () => {
    const refusal = refusalOf({});

    assert.deepEqual(
      refusal.variables,
      Object.keys(REQUIRED).map(
        (field) => ENVIRONMENT_VARIABLES[field as FieldWithVariable],
      ),
    );
  });

  test('refuses a required variable set empty', () => {
    const refusal = refusalOf(environmentWith({ host: '', issuer: '' }));

    assert.deepEqual(refusal.variables, [
      ENVIRONMENT_VARIABLES.host,
      ENVIRONMENT_VARIABLES.issuer,
    ]);
    assert.match(refusal.message, /USHER_ISSUER is empty/u);
  });

  test('refuses a service-account role set empty, naming its variable', () => {
    const refusal = refusalOf(environmentWith({ serviceAccountRole: '' }));

    assert.deepEqual(refusal.variables, [
      ENVIRONMENT_VARIABLES.serviceAccountRole,
    ]);
    assert.match(refusal.message, /USHER_SERVICE_ACCOUNT_ROLE is empty/u);
  });

  test('refuses a service-account role naming the first-user role, naming its variable and the rule', () => {
    const refusal = refusalOf(
      environmentWith({
        firstUserRole: 'ims-usher',
        serviceAccountRole: 'ims-usher',
      }),
    );

    assert.deepEqual(refusal.variables, [
      ENVIRONMENT_VARIABLES.serviceAccountRole,
    ]);
    assert.match(
      refusal.message,
      /USHER_SERVICE_ACCOUNT_ROLE must name a role other than the one in USHER_FIRST_USER_ROLE/u,
    );
  });

  test('refuses a first-user role naming the default service-account role while the service-account role is unset', () => {
    const refusal = refusalOf(
      environmentWith({ firstUserRole: 'usher-service-account' }),
    );

    assert.deepEqual(refusal.variables, [
      ENVIRONMENT_VARIABLES.serviceAccountRole,
    ]);
    assert.match(
      refusal.message,
      /USHER_SERVICE_ACCOUNT_ROLE must name a role other than the one in USHER_FIRST_USER_ROLE/u,
    );
  });

  test('reads a first-user role and a service-account role differing only in letter case as two roles', () => {
    const configuration = readConfiguration(
      environmentWith({
        firstUserRole: 'Usher-Ops',
        serviceAccountRole: 'usher-ops',
      }),
    );

    assert.deepEqual(
      {
        firstUserRole: configuration.firstUserRole,
        serviceAccountRole: configuration.serviceAccountRole,
      },
      { firstUserRole: 'Usher-Ops', serviceAccountRole: 'usher-ops' },
    );
  });

  test('refuses a start with USHER_ADMINISTRATOR_ROLE set, empty or not, naming USHER_FIRST_USER_ROLE as its replacement and never its value', () => {
    const refusals = ['usher-platform-admin', ''].map((value) =>
      refusalOf({ ...environmentWith({}), USHER_ADMINISTRATOR_ROLE: value }),
    );
    const beside = refusalOf({
      ...environmentWith({ host: '' }),
      USHER_ADMINISTRATOR_ROLE: 'usher-platform-admin',
    });

    assert.deepEqual(
      refusals.map((refusal) => refusal.variables),
      [['USHER_ADMINISTRATOR_ROLE'], ['USHER_ADMINISTRATOR_ROLE']],
    );
    refusals.forEach((refusal) => {
      assert.match(
        refusal.message,
        /USHER_ADMINISTRATOR_ROLE is replaced by USHER_FIRST_USER_ROLE/u,
      );
      assert.doesNotMatch(shownBy(refusal), /usher-platform-admin/u);
    });
    assert.deepEqual(beside.variables.toSorted(), [
      'USHER_ADMINISTRATOR_ROLE',
      ENVIRONMENT_VARIABLES.host,
    ]);
  });
});

suite("reading the API documentation page's client", () => {
  test('reads the page as off, its client empty, when the variable is unset or set empty', () => {
    const unset = readConfiguration(environmentWith({}));
    const empty = readConfiguration(environmentWith({ apiDocsClient: '' }));

    assert.deepEqual([unset.apiDocsClient, empty.apiDocsClient], ['', '']);
  });

  test('reads a client listed among the management clients as given', () => {
    const configuration = readConfiguration(
      environmentWith({
        apiDocsClient: 'usher-cli',
        managementClients: 'usher-ui, usher-cli',
      }),
    );

    assert.equal(configuration.apiDocsClient, 'usher-cli');
  });

  test('refuses a client the management clients do not list exactly, naming its variable and the rule', () => {
    const unlisted = [
      'usher-docs',
      'Usher-UI',
      ' usher-ui',
      'usher-ui ',
      'usher',
      'usher-ui,usher-cli',
    ];

    const refusals = unlisted.map((client) =>
      refusalOf(
        environmentWith({
          apiDocsClient: client,
          managementClients: 'usher-ui,usher-cli',
        }),
      ),
    );

    refusals.forEach((refusal, index) => {
      assert.deepEqual(
        refusal.variables,
        [ENVIRONMENT_VARIABLES.apiDocsClient],
        `client ${index}`,
      );
      assert.match(
        refusal.message,
        /USHER_API_DOCS_CLIENT is not one of the clients in USHER_MANAGEMENT_CLIENTS/u,
      );
    });
  });

  test('refuses any client while the management clients are an empty list', () => {
    const refusal = refusalOf(
      environmentWith({ apiDocsClient: 'usher-ui', managementClients: '' }),
    );

    assert.deepEqual(refusal.variables, [ENVIRONMENT_VARIABLES.apiDocsClient]);
  });

  test('names the management clients alone when their own value is refused, leaving the client unjudged', () => {
    const refusal = refusalOf(
      environmentWith({
        apiDocsClient: 'usher-ui',
        managementClients: 'usher-ui,',
      }),
    );

    assert.deepEqual(refusal.variables, [
      ENVIRONMENT_VARIABLES.managementClients,
    ]);
  });
});

suite('reading the grant settings', () => {
  test('reads auto-accept as true or false, written in lower case', () => {
    assert.deepEqual(
      ['true', 'false'].map(
        (value) =>
          readConfiguration(environmentWith({ autoAccept: value })).autoAccept,
      ),
      [true, false],
    );
  });

  test('refuses auto-accept written any other way, naming its variable and the rule', () => {
    ['TRUE', 'False', 'yes', '1', '', ' true'].forEach((value) => {
      const refusal = refusalOf(environmentWith({ autoAccept: value }));

      assert.deepEqual(refusal.variables, [ENVIRONMENT_VARIABLES.autoAccept]);
      assert.ok(
        refusal.message.includes(
          `${ENVIRONMENT_VARIABLES.autoAccept} is neither true nor false`,
        ),
      );
    });
  });

  test('reads a submitter category scoped global, as a payload names it', () => {
    const configuration = readConfiguration(
      environmentWith({ submitterCategory: 'global.trial-cohort' }),
    );

    assert.equal(configuration.submitterCategory, 'global.trial-cohort');
  });

  test('refuses a submitter category that is not global, or not one name after its scope, naming its variable and the rule', () => {
    [
      'unmarked',
      'resource.internal',
      'global.',
      'global.a.b',
      'Global.unmarked',
      '',
    ].forEach((value) => {
      const refusal = refusalOf(environmentWith({ submitterCategory: value }));

      assert.deepEqual(refusal.variables, [
        ENVIRONMENT_VARIABLES.submitterCategory,
      ]);
      assert.ok(
        refusal.message.includes(
          `${ENVIRONMENT_VARIABLES.submitterCategory} is not global. followed by the name of a category, which holds no dot`,
        ),
      );
    });
  });
});

suite('reading the keys', () => {
  test('reads a key with whitespace around it as the key alone', () => {
    const configuration = readConfiguration(
      environmentWith({
        cursorKey: `\t${CURSOR_KEY}\r\n`,
        keyEncryptionKey: ` ${KEY_ENCRYPTION_KEY}\n`,
      }),
    );

    assert.equal(configuration.keyEncryptionKey, KEY_ENCRYPTION_KEY);
    assert.equal(configuration.cursorKey, CURSOR_KEY);
  });

  test('refuses a key in any form but 32 bytes as 43 base64url characters in canonical form, naming its variable and never the key', () => {
    const bytes = Buffer.from(KEY_ENCRYPTION_KEY, 'base64url');
    const forms = [
      bytes.toString('base64'),
      Buffer.alloc(32, 0xfb).toString('base64').replace(/=+$/u, ''),
      bytes.toString('hex'),
      KEY_ENCRYPTION_KEY.slice(0, 42),
      withTrailingBitSet(KEY_ENCRYPTION_KEY),
      `${KEY_ENCRYPTION_KEY.slice(0, 21)} ${KEY_ENCRYPTION_KEY.slice(21)}`,
      `${KEY_ENCRYPTION_KEY}${KEY_ENCRYPTION_KEY.slice(0, 1)}`,
      '',
      '   ',
    ];

    const refusals = forms.map((form) =>
      refusalOf(environmentWith({ keyEncryptionKey: form })),
    );

    refusals.forEach((refusal, index) => {
      assert.deepEqual(refusal.variables, [
        ENVIRONMENT_VARIABLES.keyEncryptionKey,
      ]);
      const shown = shownBy(refusal);
      [KEY_ENCRYPTION_KEY, forms[index] ?? '', bytes.toString('hex')]
        .filter((secret) => secret.trim().length > 0)
        .forEach((secret) =>
          assert.equal(shown.includes(secret.trim()), false, `form ${index}`),
        );
    });
  });
});

suite("reading the database's connection", () => {
  test('reads the password as given, whitespace included, from its own variable', () => {
    const configuration = readConfiguration(environmentWith({}));

    assert.equal(configuration.databasePassword, DATABASE_PASSWORD);
  });

  test('refuses a database URL carrying a password, in its user information or as a parameter, naming the variable holding the URL and never the password', () => {
    const marker = randomUUID();
    const cases: readonly FieldValues[] = [
      { databaseUrl: `postgres://usher_controller:${marker}@127.0.0.1/usher` },
      {
        databaseUrl: `postgres://usher_controller@127.0.0.1/usher?password=${marker}`,
      },
    ];

    const refusals = cases.map((values) => refusalOf(environmentWith(values)));

    refusals.forEach((refusal, index) => {
      const [field] = Object.keys(cases[index] ?? {});
      assert.deepEqual(refusal.variables, [
        ENVIRONMENT_VARIABLES[field as FieldWithVariable],
      ]);
      assert.equal(shownBy(refusal).includes(marker), false);
    });
    assert.match(refusals[0]?.message ?? '', /USHER_DATABASE_PASSWORD/u);
  });

  test("refuses a database URL that is not PostgreSQL's, or no URL at all", () => {
    const refusals = ['mysql://usher@127.0.0.1/usher', 'not a url'].map(
      (databaseUrl) => refusalOf(environmentWith({ databaseUrl })),
    );

    refusals.forEach((refusal) =>
      assert.deepEqual(refusal.variables, [ENVIRONMENT_VARIABLES.databaseUrl]),
    );
  });

  test('reads a postgresql: URL and its parameters as given', () => {
    const databaseUrl =
      'postgresql://usher_controller@db.example.org:6432/usher?sslmode=verify-full';

    assert.equal(
      readConfiguration(environmentWith({ databaseUrl })).databaseUrl,
      databaseUrl,
    );
  });

  test('reads a database URL naming its role as a user parameter, which the driver also uses', () => {
    const databaseUrl = 'postgres://127.0.0.1:5432/usher?user=usher_controller';

    assert.equal(
      readConfiguration(environmentWith({ databaseUrl })).databaseUrl,
      databaseUrl,
    );
  });

  test('refuses a database URL naming no database role, in its user information or as a user parameter, and never quotes the URL', () => {
    const urls = [
      'postgres://127.0.0.1:5432/usher',
      'postgres://@127.0.0.1:5432/usher',
      'postgres://127.0.0.1:5432/usher?user=',
    ];

    const refusals = urls.map((databaseUrl) =>
      refusalOf(environmentWith({ databaseUrl })),
    );

    refusals.forEach((refusal) => {
      assert.deepEqual(refusal.variables, [ENVIRONMENT_VARIABLES.databaseUrl]);
      assert.equal(
        refusal.message,
        `the controller refuses to start: ${ENVIRONMENT_VARIABLES.databaseUrl} names no database role; it must name the role the controller connects as`,
      );
      assert.equal(shownBy(refusal).includes('127.0.0.1'), false);
    });
  });
});

suite('verifying the database connection', () => {
  // A CA file of the test's own, standing for a database's CA certificate: its contents are never
  // parsed while the configuration is read.
  const folder = mkdtempSync(join(tmpdir(), 'usher-configuration-'));
  after(() => rmSync(folder, { force: true, recursive: true }));
  const caFile = join(folder, 'root.crt');
  writeFileSync(caFile, '-----BEGIN CERTIFICATE-----\n');
  const missingCaFile = join(folder, 'missing.crt');

  const REMOTE = 'postgres://usher_controller@db.example.org:5432/usher';

  const UNVERIFIED_RULE =
    'connects to a host other than a loopback host or a Unix socket without verifying the server: set sslmode=verify-full, or sslmode=verify-ca with sslrootcert';

  test('takes a connection to a loopback host or a Unix socket as it is, whatever its sslmode', () => {
    const urls = [
      'postgres://usher_controller@127.0.0.1:5432/usher',
      'postgres://usher_controller@localhost:5432/usher?sslmode=disable',
      'postgres://usher_controller@[::1]:5432/usher?sslmode=require',
      'postgres://usher_controller@%2Fvar%2Frun%2Fpostgresql/usher',
      `${REMOTE}?host=/var/run/postgresql`,
      `${REMOTE}?host=localhost`,
    ];

    const read = urls.map(
      (databaseUrl) =>
        readConfiguration(environmentWith({ databaseUrl })).databaseUrl,
    );

    assert.deepEqual(read, urls);
  });

  test('takes a connection to any other host verifying the server, by sslmode=verify-full, or sslmode=verify-ca beside a CA file in sslrootcert', () => {
    const urls = [
      `${REMOTE}?sslmode=verify-full`,
      `${REMOTE}?sslmode=verify-full&sslrootcert=${caFile}`,
      `${REMOTE}?sslmode=verify-ca&sslrootcert=${caFile}`,
      `${REMOTE}?sslmode=require&sslmode=verify-full`,
    ];

    const read = urls.map(
      (databaseUrl) =>
        readConfiguration(environmentWith({ databaseUrl })).databaseUrl,
    );

    assert.deepEqual(read, urls);
  });

  test('refuses a connection to any other host under every other sslmode, require included, or none, naming the variable and the rule', () => {
    const urls = [
      REMOTE,
      `${REMOTE}?sslmode=disable`,
      `${REMOTE}?sslmode=allow`,
      `${REMOTE}?sslmode=prefer`,
      `${REMOTE}?sslmode=require`,
      `${REMOTE}?sslmode=require&sslrootcert=${caFile}`,
      `${REMOTE}?sslmode=require&uselibpqcompat=true`,
      `${REMOTE}?sslmode=verify-ca`,
      `${REMOTE}?sslmode=no-verify`,
      `${REMOTE}?sslmode=VERIFY-FULL`,
      `${REMOTE}?sslmode=verify-full&sslmode=require`,
      `${REMOTE}?ssl=true`,
    ];

    const refusals = urls.map((databaseUrl) =>
      refusalOf(environmentWith({ databaseUrl })),
    );

    refusals.forEach((refusal) => {
      assert.equal(
        refusal.message,
        `the controller refuses to start: ${ENVIRONMENT_VARIABLES.databaseUrl} ${UNVERIFIED_RULE}`,
      );
      assert.equal(shownBy(refusal).includes('db.example.org'), false);
    });
  });

  test('judges the host the driver connects to, refusing a loopback hostname whose host parameter names another host', () => {
    const refusal = refusalOf(
      environmentWith({
        databaseUrl:
          'postgres://usher_controller@127.0.0.1:5432/usher?host=db.example.org',
      }),
    );

    assert.deepEqual(refusal.variables, [ENVIRONMENT_VARIABLES.databaseUrl]);
    assert.match(refusal.message, /without verifying the server/u);
  });

  test('refuses a URL naming a CA file in sslrootcert that cannot be read, naming the setting and never the path, wherever it connects and whatever is allowed', () => {
    const environments = [
      {
        databaseUrl: `${REMOTE}?sslmode=verify-full&sslrootcert=${missingCaFile}`,
      },
      {
        databaseUrl: `postgres://usher_controller@127.0.0.1:5432/usher?sslmode=verify-full&sslrootcert=${missingCaFile}`,
      },
      {
        databaseAllowUnverifiedConnection: 'true',
        databaseUrl: `${REMOTE}?sslmode=verify-ca&sslrootcert=${missingCaFile}`,
      },
    ];

    const refusals = environments.map((values) =>
      refusalOf(environmentWith(values)),
    );

    refusals.forEach((refusal) => {
      assert.equal(
        refusal.message,
        `the controller refuses to start: ${ENVIRONMENT_VARIABLES.databaseUrl} names a file in sslrootcert that cannot be read`,
      );
      assert.equal(shownBy(refusal).includes(missingCaFile), false);
    });
  });

  test('takes any connection while USHER_DATABASE_ALLOW_UNVERIFIED_CONNECTION is true, and refuses that switch written other than true or false', () => {
    const allowed = readConfiguration(
      environmentWith({
        databaseAllowUnverifiedConnection: 'true',
        databaseUrl: `${REMOTE}?sslmode=require`,
      }),
    );
    const refusals = ['TRUE', 'yes', ''].map(
      (databaseAllowUnverifiedConnection) =>
        refusalOf(
          environmentWith({
            databaseAllowUnverifiedConnection,
            databaseUrl: `${REMOTE}?sslmode=require`,
          }),
        ),
    );

    assert.equal(allowed.databaseUrl, `${REMOTE}?sslmode=require`);
    assert.equal(allowed.databaseAllowUnverifiedConnection, true);
    assert.equal(
      ENVIRONMENT_VARIABLES.databaseAllowUnverifiedConnection,
      'USHER_DATABASE_ALLOW_UNVERIFIED_CONNECTION',
    );
    refusals.forEach((refusal) => {
      assert.deepEqual(refusal.variables, [
        ENVIRONMENT_VARIABLES.databaseAllowUnverifiedConnection,
        ENVIRONMENT_VARIABLES.databaseUrl,
      ]);
    });
  });
});

suite('reading the rules conferring record actions on everyone', () => {
  test('reads a rule within read as given, an empty one conferring nothing', () => {
    const rules = ['view', 'count,view', 'export, count', ''];

    const read = rules.map((rule) =>
      readConfiguration(
        environmentWith({ baseline: rule, signedInRule: rule }),
      ),
    );

    assert.deepEqual(
      read.map(({ baseline, signedInRule }) => [baseline, signedInRule]),
      [
        [['view'], ['view']],
        [
          ['count', 'view'],
          ['count', 'view'],
        ],
        [
          ['export', 'count'],
          ['export', 'count'],
        ],
        [[], []],
      ],
    );
  });

  test('refuses a rule naming an action outside the record vocabulary, one twice, or one beyond read', () => {
    const rules = [
      { rule: 'veiw', said: /outside the record vocabulary/u },
      { rule: 'record.read', said: /outside the record vocabulary/u },
      { rule: 'read', said: /outside the record vocabulary/u },
      { rule: 'view,view', said: /twice/u },
      { rule: 'count,view,export,update', said: /more than read/u },
      { rule: 'delete', said: /more than read/u },
      { rule: 'create', said: /more than read/u },
      { rule: 'view,,count', said: /empty entry/u },
    ];

    rules.forEach(({ rule, said }) => {
      const baseline = refusalOf(environmentWith({ baseline: rule }));
      const signedIn = refusalOf(environmentWith({ signedInRule: rule }));

      assert.deepEqual(baseline.variables, [ENVIRONMENT_VARIABLES.baseline]);
      assert.deepEqual(signedIn.variables, [
        ENVIRONMENT_VARIABLES.signedInRule,
      ]);
      assert.match(baseline.message, said, rule);
    });
  });
});

suite('reading the identity provider', () => {
  test('reads an issuer over https, or over http to a loopback host', () => {
    const issuers = [
      'https://auth.example.org/realms/usher',
      'http://127.0.0.1:8080/realms/usher',
      'http://localhost:8080/realms/usher',
      'http://[::1]:8080/realms/usher',
    ];

    const read = issuers.map(
      (identityProviderIssuer) =>
        readConfiguration(environmentWith({ identityProviderIssuer }))
          .identityProviderIssuer,
    );

    assert.deepEqual(read, issuers);
  });

  test('refuses an issuer over http to any other host, or no URL at all', () => {
    const issuers = [
      'http://auth.example.org/realms/usher',
      'http://10.0.0.5/realms/usher',
      'ftp://auth.example.org/realms/usher',
      'auth.example.org/realms/usher',
    ];

    issuers.forEach((identityProviderIssuer) =>
      assert.deepEqual(
        refusalOf(environmentWith({ identityProviderIssuer })).variables,
        [ENVIRONMENT_VARIABLES.identityProviderIssuer],
      ),
    );
  });

  test('refuses an issuer carrying a password, never showing it', () => {
    const marker = randomUUID();
    const refusal = refusalOf(
      environmentWith({
        identityProviderIssuer: `https://usher:${marker}@auth.example.org/realms/usher`,
      }),
    );

    assert.deepEqual(refusal.variables, [
      ENVIRONMENT_VARIABLES.identityProviderIssuer,
    ]);
    assert.equal(shownBy(refusal).includes(marker), false);
  });
});

suite('reading numbers and lists', () => {
  test('refuses anything but a whole number written in digits', () => {
    const values = ['1.5', '-1', '1e3', ' 5', '0x10', '', 'ten'];

    values.forEach((value) =>
      assert.deepEqual(
        refusalOf(environmentWith({ streamQueueLimit: value })).variables,
        [ENVIRONMENT_VARIABLES.streamQueueLimit],
        value,
      ),
    );
  });

  test('refuses a number outside its bounds, naming them', () => {
    const cases = [
      { said: /from 0 to 65535/u, values: { port: '65536' } },
      { said: /at least 1/u, values: { tokenLifetimeSeconds: '0' } },
      { said: /at least 60/u, values: { streamMaximumLifetimeSeconds: '59' } },
      { said: /at least 1/u, values: { databaseControlConnections: '0' } },
      { said: /at least 1/u, values: { databaseExchangeConnections: '0' } },
      {
        said: /from 1 to 2147483647/u,
        values: { heartbeatMilliseconds: '2147483648' },
      },
      {
        said: /at least 1/u,
        values: { noticePageLimit: '9007199254740993' },
      },
    ];

    cases.forEach(({ said, values }) =>
      assert.match(refusalOf(environmentWith(values)).message, said),
    );
  });

  test('reads port 0, asking for any free port, and the longest timer a millisecond setting may hold', () => {
    const configuration = readConfiguration(
      environmentWith({ port: '0', storeTimeoutMilliseconds: '2147483647' }),
    );

    assert.equal(configuration.port, 0);
    assert.equal(configuration.storeTimeoutMilliseconds, 2_147_483_647);
  });

  test('reads a list empty for an empty value, and refuses an empty entry between its commas', () => {
    assert.deepEqual(
      readConfiguration(environmentWith({ managementClients: '' }))
        .managementClients,
      [],
    );
    assert.deepEqual(
      refusalOf(environmentWith({ managementClients: 'usher-ui,' })).variables,
      [ENVIRONMENT_VARIABLES.managementClients],
    );
  });

  test('reads trusted proxies as IP addresses and CIDR ranges of either version', () => {
    const configuration = readConfiguration(
      environmentWith({
        trustedProxies:
          '10.42.0.0/16, 192.0.2.7, fd00::/8, ::1, 192.0.2.7/32, ::ffff:10.0.0.0/104',
      }),
    );

    assert.deepEqual(configuration.trustedProxies, [
      '10.42.0.0/16',
      '192.0.2.7',
      'fd00::/8',
      '::1',
      '192.0.2.7/32',
      '::ffff:10.0.0.0/104',
    ]);
  });

  test('refuses a trusted proxy that is neither an IP address nor a CIDR range, and a range of every address of an IP version', () => {
    const refused = [
      '127.0.0.1,proxy.local',
      '10.0.0.0/33',
      'fd00::/129',
      '10.0.0.0/',
      '10.0.0.0/08',
      '10.0.0.0/+8',
      '10.0.0.0/8/8',
      'proxy.local/8',
      '0.0.0.0/0',
      '::/0',
      '::ffff:0:0/96',
      '::ffff:0.0.0.0/96',
      '::ffff:10.0.0.0/96',
      '::/80',
    ].map((trustedProxies) => ({
      trustedProxies,
      variables: refusalOf(environmentWith({ trustedProxies })).variables,
    }));

    refused.forEach(({ trustedProxies, variables }) =>
      assert.deepEqual(
        variables,
        [ENVIRONMENT_VARIABLES.trustedProxies],
        trustedProxies,
      ),
    );
  });
});

suite('a refusal of the configuration', () => {
  test('names each variable at fault and never the value it refused', () => {
    const marker = `refused-${randomUUID()}`;
    const fields: readonly FieldWithVariable[] = [
      'baseline',
      'cursorKey',
      'databaseUrl',
      'heartbeatMilliseconds',
      'identityProviderIssuer',
      'keyEncryptionKey',
      'port',
      'signedInRule',
      'trustedProxies',
    ];

    const refusal = refusalOf(
      environmentWith(
        Object.fromEntries(fields.map((field) => [field, marker])),
      ),
    );

    assert.deepEqual(
      refusal.variables,
      fields.map((field) => ENVIRONMENT_VARIABLES[field]),
    );
    assert.equal(shownBy(refusal).includes(marker), false);
  });
});

// The rule a refusal gives for one variable, as its message words it after the variable's name.
const ruleFor = (refusal: StartRefusal, variable: string): string | undefined =>
  refusal.message
    .slice(refusal.message.indexOf(': ') + 2)
    .split('; ')
    .find((problem) => problem.startsWith(`${variable} `))
    ?.slice(variable.length + 1);

// Every variable the schema migration command requires, and no other.
const SCHEMA_MIGRATION_REQUIRED: ConfigurationEnvironment = {
  [ENVIRONMENT_VARIABLES.databaseSchema]: 'usher',
  [SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.databasePassword]: DATABASE_PASSWORD,
  [SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.databaseUrl]:
    'postgres://usher_migration@127.0.0.1:5432/usher',
  [ENVIRONMENT_VARIABLES.databaseUrl]: REQUIRED.databaseUrl,
};

const schemaMigrationRefusalOf = (
  environment: ConfigurationEnvironment,
): StartRefusal => {
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

suite("the retention floor's durations", () => {
  test('are read as the schema migration command reads them, so the floor it stores is the sum of what the controller reads', () => {
    const cases: readonly FieldValues[] = [
      {},
      {
        retentionGraceSeconds: '10',
        retentionMarginSeconds: '0',
        tokenLifetimeSeconds: '45',
      },
    ];

    const floors = cases.map((values) => {
      const controller = readConfiguration(environmentWith(values));
      return {
        controller:
          controller.tokenLifetimeSeconds +
          controller.retentionGraceSeconds +
          controller.retentionMarginSeconds,
        migration: readSchemaMigrationConfiguration({
          ...SCHEMA_MIGRATION_REQUIRED,
          ...environmentOf(values),
        }).retentionFloorSeconds,
      };
    });

    assert.deepEqual(floors, [
      { controller: 390, migration: 390 },
      { controller: 55, migration: 55 },
    ]);
  });

  test('are refused by the schema migration command as the controller refuses them, by the same rule', () => {
    const values: FieldValues = {
      retentionGraceSeconds: '-1',
      retentionMarginSeconds: '1.5',
      tokenLifetimeSeconds: '0',
    };
    const variables = [
      ENVIRONMENT_VARIABLES.retentionGraceSeconds,
      ENVIRONMENT_VARIABLES.retentionMarginSeconds,
      ENVIRONMENT_VARIABLES.tokenLifetimeSeconds,
    ];

    const controller = refusalOf(environmentWith(values));
    const migration = schemaMigrationRefusalOf({
      ...SCHEMA_MIGRATION_REQUIRED,
      ...environmentOf(values),
    });

    assert.deepEqual(migration.variables, variables);
    assert.deepEqual(
      variables.map((variable) => ruleFor(migration, variable)),
      variables.map((variable) => ruleFor(controller, variable)),
    );
    assert.equal(
      variables.every(
        (variable) => ruleFor(controller, variable) !== undefined,
      ),
      true,
    );
  });
});

// A refusal's problems, without what opens its message.
const problemsOf = ({ message }: StartRefusal): string =>
  message.slice(message.indexOf(': ') + 2);

suite("the controller's database URL", () => {
  test('is refused by the schema migration command as the controller refuses it, when it names no database role or carries a password', () => {
    const databaseUrls = [
      'postgres://127.0.0.1:5432/usher',
      `postgres://usher_controller:${randomUUID()}@127.0.0.1:5432/usher`,
    ];

    const refusals = databaseUrls.map((databaseUrl) => ({
      controller: refusalOf(environmentWith({ databaseUrl })),
      migration: schemaMigrationRefusalOf({
        ...SCHEMA_MIGRATION_REQUIRED,
        [ENVIRONMENT_VARIABLES.databaseUrl]: databaseUrl,
      }),
    }));

    refusals.forEach(({ controller, migration }) => {
      assert.deepEqual(migration.variables, [
        ENVIRONMENT_VARIABLES.databaseUrl,
      ]);
      assert.deepEqual(migration.variables, controller.variables);
      assert.equal(problemsOf(migration), problemsOf(controller));
    });
  });
});

suite("the controller's configuration", () => {
  test("reads none of the schema migration command's own variables, so a controller never holds the schema migration role's password", () => {
    const asked = new Set<string>();
    const environment = new Proxy(
      {
        ...environmentWith({}),
        ...Object.fromEntries(
          Object.values(SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES).map(
            (variable) => [variable, 'set'],
          ),
        ),
      },
      {
        get: (target, name, receiver): unknown => {
          asked.add(String(name));
          return Reflect.get(target, name, receiver);
        },
      },
    );

    readConfiguration(environment);

    assert.equal(asked.has(ENVIRONMENT_VARIABLES.databaseUrl), true);
    assert.deepEqual(
      Object.values(SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES).filter((variable) =>
        asked.has(variable),
      ),
      [],
    );
  });
});
