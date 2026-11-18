import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type pg from 'pg';

import {
  AUDIT_EVENT_TYPES,
  auditRows,
  awaitEventsOfType,
  type CloudEvent,
  emittedType,
  eventsIn,
  ofType,
  SEVERITY_ATTRIBUTE,
} from '../../test-support/auditEvents.js';
import {
  captureLog,
  type ControllerConfiguration,
  ENVIRONMENT_VARIABLES,
  type LogCapture,
} from '../../test-support/controller.js';
import { holdTable, untilBlocked } from '../../test-support/database.js';
import {
  committedQuery,
  readChangeRecords,
  selectRows,
} from '../../test-support/fixtures/database.js';
import {
  type Harness,
  startHarness,
  startInstance,
  startReadOnlyInstance,
  takeSnapshot,
} from '../../test-support/harness.js';
import {
  type Actor,
  POLICY_TABLES,
  qualified,
  SEEDED_ROLES,
  STEWARD_SUBJECT,
  storedKeyFingerprints,
} from '../../test-support/policy.js';
import { type Cleanup, cleanupFor } from '../../test-support/waiting.js';

const { capabilities, notices, rolePermissions, roles, rulesDigest } =
  POLICY_TABLES;

const { baselineChange } = AUDIT_EVENT_TYPES;

// The capability vocabulary of permissions-model.md, each entity in its plane: the data plane's four
// entities a token's category entry may carry, and the control plane's rows of Usher's own store.
const VOCABULARY: Readonly<
  Record<string, { actions: readonly string[]; plane: string }>
> = Object.freeze({
  artifact: {
    actions: ['count', 'create', 'delete', 'export', 'update', 'view'],
    plane: 'data',
  },
  category: { actions: ['create'], plane: 'control' },
  custodianship: { actions: ['assign', 'remove'], plane: 'control' },
  field: { actions: ['count', 'export', 'update', 'view'], plane: 'data' },
  grant: {
    actions: ['create', 'extend', 'reduce', 'revoke', 'view'],
    plane: 'control',
  },
  group: {
    actions: ['addMember', 'create', 'removeMember', 'update', 'view'],
    plane: 'control',
  },
  invitation: { actions: ['create'], plane: 'control' },
  ownership: { actions: ['transfer'], plane: 'control' },
  record: {
    actions: ['count', 'create', 'delete', 'export', 'update', 'view'],
    plane: 'data',
  },
  resource: {
    actions: ['register', 'restore', 'suppress', 'update', 'view'],
    plane: 'control',
  },
  revision: { actions: ['export', 'view'], plane: 'data' },
  role: { actions: ['define'], plane: 'control' },
});

const ADMINISTRATOR: Actor = Object.freeze({
  id: STEWARD_SUBJECT,
  type: 'human',
});

const REFUSED_ON_ITS_ROLE = Object.freeze({
  message: new RegExp(`\\b${ENVIRONMENT_VARIABLES.databaseUrl}\\b`, 'u'),
});

/** A store a Controller has started on once, and the log stream that Controller writes to. */
interface StartedStore {
  harness: Harness;
  log: LogCapture;
}

// A store a Controller started on once under the runtime role, with no application registered, so
// nothing but what a start writes is in it beyond what the migrations write.
const startedStore = async (scope: Cleanup): Promise<StartedStore> => {
  const log = captureLog();
  const harness = await startHarness({
    applications: [],
    configuration: { logStream: log.stream },
  });
  scope.defer(() => harness.stop());
  return { harness, log };
};

const storedVocabulary = (
  client: pg.ClientBase,
): Promise<readonly { name: string; plane: string }[]> =>
  selectRows<{ name: string; plane: string }>(
    client,
    `SELECT ${capabilities.columns.entity} || '.' || ${capabilities.columns.action} AS name, ${capabilities.columns.plane} AS plane FROM ${qualified(capabilities)} ORDER BY name`,
  );

const storedRoles = async (
  client: pg.ClientBase,
): Promise<
  Readonly<Record<string, { capabilities: readonly string[]; plane: string }>>
> => {
  const rows = await selectRows<{
    capabilities: string[];
    name: string;
    plane: string;
  }>(
    client,
    `SELECT role.${roles.columns.name} AS name, role.${roles.columns.plane} AS plane,
            coalesce(array_agg(capability.${capabilities.columns.entity} || '.' || capability.${capabilities.columns.action} ORDER BY capability.${capabilities.columns.entity} || '.' || capability.${capabilities.columns.action}) FILTER (WHERE capability.${capabilities.columns.id} IS NOT NULL), '{}') AS capabilities
       FROM ${qualified(roles)} role
       LEFT JOIN ${qualified(rolePermissions)} permission ON permission.${rolePermissions.columns.roleId} = role.${roles.columns.id}
       LEFT JOIN ${qualified(capabilities)} capability ON capability.${capabilities.columns.id} = permission.${rolePermissions.columns.capabilityId}
      GROUP BY role.${roles.columns.name}, role.${roles.columns.plane}`,
  );
  return Object.fromEntries(
    rows.map(({ capabilities: held, name, plane }) => [
      name,
      { capabilities: held, plane },
    ]),
  );
};

const storedDigests = async (
  client: pg.ClientBase,
): Promise<readonly string[]> =>
  (
    await selectRows<{ digest: string }>(
      client,
      `SELECT ${rulesDigest.columns.digest} AS digest FROM ${qualified(rulesDigest)}`,
    )
  ).map(({ digest }) => digest);

const noticeCount = async (
  client: pg.ClientBase,
  kind?: string,
): Promise<number> => {
  const [row] = await selectRows<{ count: number }>(
    client,
    `SELECT count(*)::int AS count FROM ${qualified(notices)} WHERE $1::text IS NULL OR ${notices.columns.kind} = $1`,
    [kind ?? null],
  );
  return row?.count ?? 0;
};

/** A `baseline.change` event as a test compares it: its id, severity and data. */
interface RecordedChange {
  data: unknown;
  id: string;
  severity: unknown;
}

const recordedChange = ({
  data,
  id,
  severity,
}: RecordedChange): RecordedChange => ({ data, id, severity });

// The event's rows in `audit_log`, in the order they occurred.
const changeRows = async (
  client: pg.ClientBase,
): Promise<readonly RecordedChange[]> =>
  (await auditRows(client))
    .filter(({ type }) => type === emittedType(baselineChange))
    .map(recordedChange);

const lineOf = (event: CloudEvent): RecordedChange =>
  recordedChange({
    data: event.data,
    id: event.id,
    severity: event[SEVERITY_ATTRIBUTE],
  });

// The event's lines a log stream holds from a mark on.
const changeLines = (
  log: LogCapture,
  since: number = 0,
): readonly RecordedChange[] =>
  ofType(eventsIn(log, since), baselineChange).map(lineOf);

// What the event records of the rules a configuration starts under, as the system, which names nobody.
const changeData = ({
  baseline,
  instanceName,
  signedInRule,
}: Pick<
  ControllerConfiguration,
  'baseline' | 'instanceName' | 'signedInRule'
>): Readonly<Record<string, unknown>> => ({
  actorId: null,
  actorType: 'system',
  baseline: baseline.toSorted(),
  instance: instanceName,
  signedInRule: signedInRule.toSorted(),
});

const withoutPermission = (
  client: pg.ClientBase,
  role: string,
  capability: string,
): Promise<unknown> =>
  committedQuery(
    client,
    `DELETE FROM ${qualified(rolePermissions)}
      WHERE ${rolePermissions.columns.roleId} = (SELECT ${roles.columns.id} FROM ${qualified(roles)} WHERE ${roles.columns.name} = $1)
        AND ${rolePermissions.columns.capabilityId} = (SELECT ${capabilities.columns.id} FROM ${qualified(capabilities)} WHERE ${capabilities.columns.entity} || '.' || ${capabilities.columns.action} = $2)`,
    [role, capability],
    ADMINISTRATOR,
  );

// Removes a seeded role and what it carries, as the migration role, so the store lacks it.
const withoutRole = async (
  client: pg.ClientBase,
  role: string,
): Promise<void> => {
  await committedQuery(
    client,
    `DELETE FROM ${qualified(rolePermissions)} WHERE ${rolePermissions.columns.roleId} = (SELECT ${roles.columns.id} FROM ${qualified(roles)} WHERE ${roles.columns.name} = $1)`,
    [role],
  );
  await committedQuery(
    client,
    `DELETE FROM ${qualified(roles)} WHERE ${roles.columns.name} = $1`,
    [role],
  );
};

suite('what the controller writes at its start', () => {
  test('writes the capability vocabulary, each capability in the plane of its entity, at its first start', async (context) => {
    const { harness } = await startedStore(cleanupFor(context));

    const stored = await storedVocabulary(harness.clients.migration);

    assert.deepEqual(
      stored,
      Object.entries(VOCABULARY)
        .flatMap(([entity, { actions, plane }]) =>
          actions.map((action) => ({ name: `${entity}.${action}`, plane })),
        )
        .toSorted((first, second) => first.name.localeCompare(second.name)),
    );
  });

  test('writes each seeded role with the capabilities the seeded matrix gives it at its first start', async (context) => {
    const { harness } = await startedStore(cleanupFor(context));

    const stored = await storedRoles(harness.clients.migration);

    assert.deepEqual(
      stored,
      Object.fromEntries(
        Object.entries(SEEDED_ROLES).map(
          ([name, { capabilities: held, plane }]) => [
            name,
            { capabilities: [...held], plane },
          ],
        ),
      ),
    );
  });

  test('records the digest of its rules at its first start, and writes no notice', async (context) => {
    const { harness } = await startedStore(cleanupFor(context));
    const migration = harness.clients.migration;

    const digests = await storedDigests(migration);

    assert.equal(digests.length, 1);
    assert.equal(await noticeCount(migration), 0);
  });

  test('records one fingerprint at its first start, of 32 bytes, under the name keyEncryptionKey', async (context) => {
    const { harness } = await startedStore(cleanupFor(context));

    const stored = await storedKeyFingerprints(harness.clients.migration);

    assert.deepEqual(
      stored.map(({ fingerprint, keyName }) => ({
        keyName,
        thirtyTwoBytes: /^[\da-f]{64}$/u.test(fingerprint),
      })),
      [{ keyName: 'keyEncryptionKey', thirtyTwoBytes: true }],
    );
  });

  test("records one baseline.change at info at the store's first start, its row and its line alike, naming the rules it starts under", async (context) => {
    const { harness, log } = await startedStore(cleanupFor(context));

    const lines = (await awaitEventsOfType(log, baselineChange)).map(lineOf);
    const rows = await changeRows(harness.clients.migration);

    assert.deepEqual(rows, lines);
    assert.deepEqual(
      rows.map(({ data, severity }) => ({ data, severity })),
      [{ data: changeData(harness.configuration), severity: 'info' }],
    );
  });

  test('writes its capabilities, roles and their permissions as the system, which names nobody', async (context) => {
    const { harness } = await startedStore(cleanupFor(context));
    const written = new Set<string>([
      capabilities.name,
      rolePermissions.name,
      roles.name,
    ]);

    const records = (await readChangeRecords(harness.clients.migration)).filter(
      ({ tableName }) => written.has(tableName),
    );

    assert.deepEqual(
      [...new Set(records.map(({ tableName }) => tableName))].toSorted(),
      [...written].toSorted(),
    );
    assert.deepEqual(
      [
        ...new Set(
          records.map(
            ({ actorId, actorType }) => `${actorType} ${String(actorId)}`,
          ),
        ),
      ],
      ['system null'],
    );
  });

  test('writes nothing, and records no event, when it restarts under the same rules', async (context) => {
    const { harness, log } = await startedStore(cleanupFor(context));
    const before = await takeSnapshot(harness);
    const mark = log.lines().length;

    await harness.restart();

    assert.deepEqual(await takeSnapshot(harness), before);
    assert.deepEqual(changeLines(log, mark), []);
  });

  test('records the new digest, one baseline notice and one baseline.change at warning when it starts under a changed baseline', async (context) => {
    const { harness, log } = await startedStore(cleanupFor(context));
    const migration = harness.clients.migration;
    const recorded = await storedDigests(migration);
    const [first] = await changeRows(migration);
    const mark = log.lines().length;

    await harness.restart({ baseline: ['view', 'count'] });

    const lines = (
      await awaitEventsOfType(log, baselineChange, { since: mark })
    ).map(lineOf);
    const digests = await storedDigests(migration);
    assert.equal(digests.length, 1);
    assert.notDeepEqual(digests, recorded);
    assert.equal(await noticeCount(migration, 'baseline'), 1);
    assert.deepEqual(await changeRows(migration), [first, ...lines]);
    assert.deepEqual(
      lines.map(({ data, severity }) => ({ data, severity })),
      [{ data: changeData(harness.configuration), severity: 'warning' }],
    );
  });

  test('writes nothing, and records no event, when it starts under a baseline naming the same actions in another order', async (context) => {
    const { harness, log } = await startedStore(cleanupFor(context));
    const before = await takeSnapshot(harness);
    const mark = log.lines().length;

    await harness.restart({
      baseline: harness.configuration.baseline.toReversed(),
    });

    assert.deepEqual(await takeSnapshot(harness), before);
    assert.deepEqual(changeLines(log, mark), []);
  });

  test('writes one baseline notice and records one baseline.change between instances started together under a changed signed-in rule', async (context) => {
    const scope = cleanupFor(context);
    const { harness } = await startedStore(scope);
    const migration = harness.clients.migration;
    const [first] = await changeRows(migration);
    const logs = Array.from({ length: 3 }, () => captureLog());
    const held = await holdTable(harness.database, rulesDigest);
    const starting = Promise.all(
      logs.map((log) =>
        startInstance(scope, harness, {
          logStream: log.stream,
          signedInRule: ['count'],
        }),
      ),
    );

    const overlapping = await untilBlocked(migration, starting, {
      count: logs.length,
      deadline: Date.now() + 10_000,
    }).finally(() => held.release());
    await starting;

    const lines = logs.flatMap((log) => changeLines(log));
    assert.equal(overlapping, true);
    assert.equal(await noticeCount(migration, 'baseline'), 1);
    assert.equal(lines.length, 1);
    assert.deepEqual(await changeRows(migration), [first, ...lines]);
    assert.equal(lines[0]?.severity, 'warning');
  });

  test('starts on a role that may only read under the rules the store recorded, writing nothing and recording no event', async (context) => {
    const scope = cleanupFor(context);
    const { harness } = await startedStore(scope);
    const before = await takeSnapshot(harness);
    const log = captureLog();

    const reading = await startReadOnlyInstance(scope, harness, {
      logStream: log.stream,
    });
    await reading.stop();

    assert.deepEqual(await takeSnapshot(harness), before);
    assert.deepEqual(changeLines(log), []);
  });

  test('refuses a start on a role that may only read under rules the store has not recorded, naming the database URL, writing nothing and recording no event', async (context) => {
    const scope = cleanupFor(context);
    const { harness } = await startedStore(scope);
    const before = await takeSnapshot(harness);
    const log = captureLog();

    await assert.rejects(
      startReadOnlyInstance(scope, harness, {
        logStream: log.stream,
        signedInRule: [],
      }),
      REFUSED_ON_ITS_ROLE,
    );

    assert.deepEqual(await takeSnapshot(harness), before);
    assert.deepEqual(changeLines(log), []);
  });

  test('refuses a start on a role that may only read while the store lacks a seeded role, naming the database URL and writing nothing', async (context) => {
    const scope = cleanupFor(context);
    const { harness } = await startedStore(scope);
    await withoutRole(harness.clients.migration, 'curator');
    const before = await takeSnapshot(harness);

    await assert.rejects(
      startReadOnlyInstance(scope, harness),
      REFUSED_ON_ITS_ROLE,
    );

    assert.deepEqual(await takeSnapshot(harness), before);
  });

  test('writes a seeded role the store lacks, with every capability the seeded matrix gives it', async (context) => {
    const { harness } = await startedStore(cleanupFor(context));
    await withoutRole(harness.clients.migration, 'curator');

    await harness.restart();

    assert.deepEqual(
      (await storedRoles(harness.clients.migration))['curator'],
      {
        capabilities: [...SEEDED_ROLES.curator.capabilities],
        plane: SEEDED_ROLES.curator.plane,
      },
    );
  });

  test("keeps an administrator's change to a seeded role at a later start", async (context) => {
    const { harness } = await startedStore(cleanupFor(context));
    await withoutPermission(
      harness.clients.migration,
      'viewer',
      'record.export',
    );
    const before = await takeSnapshot(harness);

    await harness.restart();

    assert.deepEqual(
      (await storedRoles(harness.clients.migration))['viewer']?.capabilities,
      SEEDED_ROLES.viewer.capabilities.filter(
        (capability) => capability !== 'record.export',
      ),
    );
    assert.deepEqual(await takeSnapshot(harness), before);
  });
});
