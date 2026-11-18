import assert from 'node:assert/strict';
import { suite, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

import pg from 'pg';

import {
  ENVIRONMENT_VARIABLES,
  schemaMigrationEnvironmentFor,
  spawnSchemaMigrationCommand,
} from '../../test-support/controller.js';
import {
  DATABASE_ROLES,
  holdTable,
  TEMPLATE_RETENTION_FLOOR_SECONDS,
  untilBlocked,
  USHER_SCHEMA,
} from '../../test-support/database.js';
import {
  appliedMigrations,
  auditEntryRow,
  catalogueSnapshot,
  committedInsert,
  connectInTimeZone,
  DESIGNED_COLUMNS,
  globalCategoryRow,
  insertNotice,
  migrateDatabase,
  migrateDatabaseInProcess,
  type NamedTable,
  noticeStreamRows,
  openDatabase,
  openEmptyDatabase,
  openSeededDatabase,
  selectRows,
  shapeProblems,
  SUBJECTS,
  tableContents,
  tableExists,
} from '../../test-support/fixtures/database.js';
import { inTurn, POLICY_TABLES, qualified } from '../../test-support/policy.js';

const {
  auditLog,
  categories,
  changeRecords,
  grants,
  noticeRetention,
  schemaMigrations,
} = POLICY_TABLES;

const SCHEMA = pg.escapeIdentifier(USHER_SCHEMA);

const DESIGNED_TABLES: readonly NamedTable[] = Object.entries(POLICY_TABLES)
  .filter(([key]) => Object.hasOwn(DESIGNED_COLUMNS, key))
  .map(([, table]) => table);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

// The log stream's numbering of info, which the command's line naming what it applied is written at.
const INFO_LEVEL = 30;

// The log stream's numbering of warn, which the command's line allowing an unverified database
// connection is written at.
const WARNING_LEVEL = 40;

// The log stream's numbering of fatal, which the command's line saying why it ended is written at.
const FATAL_LEVEL = 60;

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const linesOf = (text: string): readonly unknown[] =>
  text
    .split('\n')
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line));

// The one line a run through the command writes, the time aside, once it is shown to be an instant.
const onlyLine = (lines: readonly unknown[]): unknown => {
  const [line, ...laterLines] = lines;
  assert.deepEqual(laterLines, []);
  assert.ok(typeof line === 'object' && line !== null && 'time' in line);
  const { time, ...rest } = line;
  assert.match(String(time), INSTANT);
  return rest;
};

// Whether the test's database holds no advisory lock, waited for until the deadline: the session of
// a stopped run ends within a second of its connection closing.
const advisoryLocksReleased = async (
  client: pg.ClientBase,
  deadline: number = Date.now() + 5000,
): Promise<boolean> => {
  const [{ held } = { held: 0 }] = await selectRows<{ held: number }>(
    client,
    "SELECT count(*)::int AS held FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
  );
  if (held === 0) {
    return true;
  }
  if (Date.now() > deadline) {
    return false;
  }
  await delay(50);
  return advisoryLocksReleased(client, deadline);
};

const succeeded = (attempt: Promise<unknown>): Promise<boolean> =>
  attempt.then(
    () => true,
    () => false,
  );

const migrationOrder = async (
  context: TestContext,
): Promise<readonly string[]> => {
  const reference = await openDatabase(context);
  const owner = await reference.connect('migration');
  return (await appliedMigrations(owner)).map(({ name }) => name);
};

// The earliest migration after which every given table exists, found by migrating an empty
// database to each migration in turn, so a test of an upgrade starts as early as it can.
const earliestMigrationHolding = async (
  context: TestContext,
  order: readonly string[],
  tables: readonly NamedTable[],
): Promise<string> => {
  const holding = await inTurn(order, async (target) => {
    const database = await openEmptyDatabase(context);
    await migrateDatabaseInProcess(database, { target });
    const owner = await database.connect('migration');
    const present = await inTurn(tables, (table) => tableExists(owner, table));
    await owner.end();
    return present.every(Boolean) ? [target] : [];
  });
  const [earliest] = holding.flat();
  if (earliest !== undefined) {
    return earliest;
  }
  throw new Error('no migration holds every table the test needs');
};

const relationsBeside = async (
  client: pg.ClientBase,
  kept: readonly string[],
): Promise<readonly string[]> =>
  (
    await selectRows<{ name: string }>(
      client,
      `SELECT relation.relname AS name FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1 AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') ORDER BY 1`,
      [USHER_SCHEMA],
    )
  )
    .map(({ name }) => name)
    .filter(
      (name) => !kept.includes(name) && !name.startsWith(schemaMigrations.name),
    );

const auditTrail = async (client: pg.ClientBase): Promise<readonly string[]> =>
  [
    ...(await selectRows<{ text: string }>(
      client,
      `SELECT row_to_json(entry)::text AS text FROM ${qualified(auditLog)} entry`,
    )),
    ...(await selectRows<{ text: string }>(
      client,
      `SELECT row_to_json(record)::text AS text FROM ${qualified(changeRecords)} record`,
    )),
  ]
    .map(({ text }) => text)
    .sort();

interface StoreState {
  applied: Awaited<ReturnType<typeof appliedMigrations>>;
  catalogue: Awaited<ReturnType<typeof catalogueSnapshot>>;
  rows: Awaited<ReturnType<typeof tableContents>>;
}

const storeState = async (client: pg.ClientBase): Promise<StoreState> => ({
  applied: await appliedMigrations(client),
  catalogue: await catalogueSnapshot(client),
  rows: await tableContents(client),
});

// Whether the runtime role may read the record of applied migrations, as the catalogue reports it.
const runtimeReadsRecord = async (client: pg.ClientBase): Promise<boolean> =>
  (
    await selectRows<{ reads: boolean }>(
      client,
      "SELECT has_table_privilege($1, $2, 'SELECT') AS reads",
      [DATABASE_ROLES.runtime, qualified(schemaMigrations)],
    )
  )[0]?.reads ?? false;

suite('migrations', () => {
  test('builds the whole schema on an empty database, writing one line at info naming each migration it applied and the retention floor, and no URL, role or password', async (context) => {
    const database = await openEmptyDatabase(context);

    const lines = await migrateDatabase(database);

    const owner = await database.connect('migration');
    const applied = await appliedMigrations(owner);
    assert.deepEqual(await shapeProblems(owner), []);
    assert.equal(applied.length > 0, true);
    assert.equal(new Set(applied.map(({ name }) => name)).size, applied.length);
    assert.deepEqual(onlyLine(lines), {
      level: INFO_LEVEL,
      applied: applied.map(({ name }) => name),
      retentionFloorSeconds: TEMPLATE_RETENTION_FLOOR_SECONDS,
      message: 'schemaMigrations.applied',
    });
    const migrationUrl = database.urlFor('migration');
    assert.deepEqual(
      [
        migrationUrl,
        decodeURIComponent(new URL(migrationUrl).password),
        DATABASE_ROLES.migration,
        DATABASE_ROLES.runtime,
      ].filter((shown) => JSON.stringify(lines).includes(shown)),
      [],
    );
  });

  test('writes one line at warning naming USHER_DATABASE_ALLOW_UNVERIFIED_CONNECTION before its other lines on a run allowing an unverified connection, and none on a run not allowing one', async (context) => {
    const database = await openEmptyDatabase(context);
    const environment = schemaMigrationEnvironmentFor({
      databaseUrl: database.urlFor('migration'),
      retentionFloorSeconds: TEMPLATE_RETENTION_FLOOR_SECONDS,
      runtimeRole: DATABASE_ROLES.runtime,
      schema: database.schema,
    });

    const runs = await Promise.all(
      ['true', 'false'].map(async (allowed) => {
        const exit = await spawnSchemaMigrationCommand({
          ...environment,
          [ENVIRONMENT_VARIABLES.databaseAllowUnverifiedConnection]: allowed,
        });
        return linesOf(exit.stdout).map((line) => {
          assert.ok(typeof line === 'object' && line !== null);
          return {
            level: Reflect.get(line, 'level'),
            message: Reflect.get(line, 'message'),
            variable: Reflect.get(line, 'variable'),
          };
        });
      }),
    );

    assert.deepEqual(runs[0]?.[0], {
      level: WARNING_LEVEL,
      message: 'store.unverifiedConnectionAllowed',
      variable: ENVIRONMENT_VARIABLES.databaseAllowUnverifiedConnection,
    });
    assert.deepEqual(
      runs.map((lines) => lines.at(-1)?.message),
      ['schemaMigrations.applied', 'schemaMigrations.applied'],
    );
    assert.equal(runs[1]?.length, 1);
  });

  test('changes nothing when run on an up-to-date database, its line naming no migration applied', async (context) => {
    const { database, owner } = await openSeededDatabase(context);
    await insertNotice(owner, { kind: 'baseline' });
    await committedInsert(
      owner,
      auditLog,
      auditEntryRow({ actorId: SUBJECTS.ana }),
    );
    const before = await storeState(owner);

    const lines = await migrateDatabase(database);

    assert.deepEqual(await storeState(owner), before);
    assert.deepEqual(onlyLine(lines), {
      level: INFO_LEVEL,
      applied: [],
      retentionFloorSeconds: TEMPLATE_RETENTION_FLOOR_SECONDS,
      message: 'schemaMigrations.applied',
    });
  });

  test('grants the runtime role reading the record of applied migrations on every run, one on an up-to-date database included', async (context) => {
    const { database, owner } = await openSeededDatabase(context);
    await owner.query(
      `REVOKE SELECT ON ${qualified(schemaMigrations)} FROM ${pg.escapeIdentifier(DATABASE_ROLES.runtime)}`,
    );
    const revoked = await runtimeReadsRecord(owner);

    await migrateDatabase(database);

    assert.deepEqual([revoked, await runtimeReadsRecord(owner)], [false, true]);
  });

  test('applies each migration whole or not at all', async (context) => {
    const reference = await openDatabase(context);
    const referenceOwner = await reference.connect('migration');
    const clean = await catalogueSnapshot(referenceOwner);
    const order = (await appliedMigrations(referenceOwner)).map(
      ({ name }) => name,
    );
    const builtThrough: readonly (readonly string[])[] = [
      [],
      ...(await inTurn(order, async (target) => {
        const partial = await openEmptyDatabase(context);
        await migrateDatabaseInProcess(partial, { target });
        const partialOwner = await partial.connect('migration');
        const built = await relationsBeside(partialOwner, []);
        await partialOwner.end();
        return built;
      })),
    ];

    const outcomes = await inTurn(DESIGNED_TABLES, async (table) => {
      const database = await openEmptyDatabase(context);
      const owner = await database.connect('migration');
      await owner.query(`CREATE SCHEMA ${SCHEMA}`);
      await owner.query(
        `CREATE TABLE ${qualified(table)} (conflicting integer)`,
      );

      const failed = !(await succeeded(migrateDatabase(database)));
      const applied = (await appliedMigrations(owner)).map(({ name }) => name);
      const halfBuilt = await relationsBeside(owner, [
        table.name,
        ...(builtThrough[applied.length] ?? []),
      ]);
      await owner.query(
        applied.length === 0
          ? `DROP SCHEMA ${SCHEMA} CASCADE`
          : `DROP TABLE ${qualified(table)}`,
      );
      const retried = await succeeded(migrateDatabase(database));
      const rebuilt = await catalogueSnapshot(owner);
      await owner.end();
      return {
        failed,
        failingOneUnrecorded:
          applied.length < order.length &&
          applied.every((name, index) => order[index] === name),
        halfBuilt,
        rebuiltAsClean: isDeepStrictEqual(rebuilt, clean),
        retried,
        table: table.name,
      };
    });

    assert.deepEqual(
      outcomes,
      DESIGNED_TABLES.map(({ name }) => ({
        failed: true,
        failingOneUnrecorded: true,
        halfBuilt: [],
        rebuiltAsClean: true,
        retried: true,
        table: name,
      })),
    );
  });

  test("refuses to migrate for a runtime role the deployment has not created, naming the variable of the controller's URL, which names it, and never the role, and applies none of it", async (context) => {
    const reference = await openDatabase(context);
    const clean = await catalogueSnapshot(await reference.connect('migration'));
    const database = await openEmptyDatabase(context);
    const absentRole = 'usher_absent_runtime_role';

    const refusal = await migrateDatabase(database, {
      runtimeRole: absentRole,
    }).then(
      () => undefined,
      (failure: unknown) => String(failure),
    );
    const owner = await database.connect('migration');
    const applied = await appliedMigrations(owner);
    const built = await relationsBeside(owner, []);
    const functions = await selectRows<{ name: string }>(
      owner,
      'SELECT function_.proname AS name FROM pg_proc function_ JOIN pg_namespace namespace ON namespace.oid = function_.pronamespace WHERE namespace.nspname = $1',
      [USHER_SCHEMA],
    );
    const retried = await succeeded(migrateDatabase(database));
    const rebuilt = await catalogueSnapshot(owner);

    assert.deepEqual(
      {
        applied,
        built,
        functions,
        namesTheVariable:
          refusal?.includes(
            `${ENVIRONMENT_VARIABLES.databaseUrl} names a role that does not exist`,
          ) ?? false,
        quotesTheRole: refusal?.includes(absentRole) ?? false,
        rebuiltAsClean: isDeepStrictEqual(rebuilt, clean),
        retried,
      },
      {
        applied: [],
        built: [],
        functions: [],
        namesTheVariable: true,
        quotesTheRole: false,
        rebuiltAsClean: true,
        retried: true,
      },
    );
  });

  test('leaves every object owned by the schema migration role', async (context) => {
    const database = await openEmptyDatabase(context);
    await migrateDatabase(database);
    const owner = await database.connect('migration');

    const owned = await selectRows<{ object: string; owner: string }>(
      owner,
      `SELECT 'relation ' || relation.relname AS object, pg_get_userbyid(relation.relowner) AS owner
         FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1
       UNION ALL
       SELECT 'function ' || function_.proname, pg_get_userbyid(function_.proowner)
         FROM pg_proc function_ JOIN pg_namespace namespace ON namespace.oid = function_.pronamespace WHERE namespace.nspname = $1
       UNION ALL
       SELECT 'type ' || type.typname, pg_get_userbyid(type.typowner)
         FROM pg_type type JOIN pg_namespace namespace ON namespace.oid = type.typnamespace WHERE namespace.nspname = $1
       UNION ALL
       SELECT 'schema ' || nspname, pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = $1`,
      [USHER_SCHEMA],
    );

    assert.equal(
      owned.some(({ object }) => object.startsWith('function ')),
      true,
    );
    assert.deepEqual(
      owned.filter(({ owner: holder }) => holder !== DATABASE_ROLES.migration),
      [],
    );
  });

  test('keeps every audit entry unchanged across an upgrade', async (context) => {
    const order = await migrationOrder(context);
    const earliest = await earliestMigrationHolding(context, order, [
      auditLog,
      categories,
      changeRecords,
    ]);
    const database = await openEmptyDatabase(context);
    await migrateDatabaseInProcess(database, { target: earliest });
    const owner = await connectInTimeZone(database, 'migration', 'UTC');
    await committedInsert(
      owner,
      auditLog,
      auditEntryRow({
        actorId: SUBJECTS.ana,
        nested: { count: 12_345_678_901_234, quote: "l'accès « contrôlé »" },
      }),
    );
    await committedInsert(owner, categories, globalCategoryRow('restricted'));
    const before = await auditTrail(owner);

    await migrateDatabase(database);

    assert.equal(before.length >= 2, true);
    assert.deepEqual(await auditTrail(owner), before);
  });

  test('refuses to run when an applied migration has changed or gone', async (context) => {
    const order = await migrationOrder(context);
    const [earliest] = order;
    const { columns } = schemaMigrations;
    const tamperings = [
      {
        label: 'changed',
        text: `UPDATE ${qualified(schemaMigrations)} SET ${columns.checksum} = 'tampered' WHERE ${columns.name} = $1`,
      },
      {
        label: 'gone',
        text: `INSERT INTO ${qualified(schemaMigrations)} (${columns.appliedAt}, ${columns.checksum}, ${columns.name}) VALUES (now(), 'absent', 'absent_from_the_set_' || $1)`,
      },
    ];

    const outcomes = await inTurn(tamperings, async ({ label, text }) => {
      const database = await openEmptyDatabase(context);
      await migrateDatabaseInProcess(
        database,
        earliest === undefined ? {} : { target: earliest },
      );
      const owner = await database.connect('migration');
      await owner.query(text, [earliest ?? '']);
      const before = await storeState(owner);

      const refused = !(await succeeded(migrateDatabase(database)));

      const unchanged = isDeepStrictEqual(await storeState(owner), before);
      await owner.end();
      return { label, refused, unchanged };
    });

    assert.deepEqual(outcomes, [
      { label: 'changed', refused: true, unchanged: true },
      { label: 'gone', refused: true, unchanged: true },
    ]);
  });

  test('moves only forward, even when given a target already passed', async (context) => {
    const { database, owner } = await openSeededDatabase(context);
    const [earliest] = (await appliedMigrations(owner)).map(({ name }) => name);
    const before = await storeState(owner);

    await succeeded(
      migrateDatabaseInProcess(
        database,
        earliest === undefined ? {} : { target: earliest },
      ),
    );

    assert.notEqual(earliest, undefined);
    assert.deepEqual(await storeState(owner), before);
  });

  test('sets the retention floor alone when run again with another', async (context) => {
    const { database, owner } = await openSeededDatabase(context);
    const before = await storeState(owner);
    const otherTables = ({
      rows,
    }: StoreState): Readonly<Record<string, readonly string[]>> =>
      Object.fromEntries(
        Object.entries(rows).filter(([name]) => name !== noticeRetention.name),
      );

    await migrateDatabase(database, { retentionFloorSeconds: 1_800 });

    const after = await storeState(owner);
    assert.deepEqual(after.catalogue, before.catalogue);
    assert.deepEqual(after.applied, before.applied);
    assert.deepEqual(otherTables(after), otherTables(before));
    assert.deepEqual(
      await selectRows<{ floorSeconds: number }>(
        owner,
        `SELECT ${noticeRetention.columns.floorSeconds}::int AS "floorSeconds" FROM ${qualified(noticeRetention)}`,
      ),
      [{ floorSeconds: 1_800 }],
    );
  });

  test('stops on SIGTERM while a migration waits on a lock, rolling it back and releasing its lock, and exits as the signal does with one line saying so', async (context) => {
    const order = await migrationOrder(context);
    const earliest = await earliestMigrationHolding(context, order, [grants]);
    const database = await openEmptyDatabase(context);
    await migrateDatabaseInProcess(database, { target: earliest });
    const observer = await database.connect('migration');
    const before = await storeState(observer);
    const held = await holdTable(database, grants);
    const stop = Promise.withResolvers<NodeJS.Signals>();

    const exiting = spawnSchemaMigrationCommand(
      schemaMigrationEnvironmentFor({
        databaseUrl: database.urlFor('migration'),
        retentionFloorSeconds: TEMPLATE_RETENTION_FLOOR_SECONDS,
        runtimeRole: DATABASE_ROLES.runtime,
        schema: database.schema,
      }),
      { stopWith: stop.promise },
    );
    const waited = await untilBlocked(observer, exiting);
    stop.resolve('SIGTERM');
    const exit = await exiting;
    const releasedWhileHeld = await advisoryLocksReleased(observer);
    await held.release();
    const after = await storeState(observer);
    const laterLines = await migrateDatabase(database);

    assert.equal(waited, true);
    assert.deepEqual(
      {
        exitCode: exit.exitCode,
        signal: exit.signal,
        stdout: exit.stdout,
        timedOut: exit.timedOut,
      },
      { exitCode: 143, signal: null, stdout: '', timedOut: false },
    );
    assert.deepEqual(onlyLine(linesOf(exit.stderr)), {
      level: FATAL_LEVEL,
      error: 'ControllerError',
      message:
        'the schema migration command failed: the run was stopped, and every migration it committed before the stop stays applied',
    });
    assert.equal(releasedWhileHeld, true);
    assert.deepEqual(after, before);
    assert.deepEqual(onlyLine(laterLines), {
      level: INFO_LEVEL,
      applied: order.slice(order.indexOf(earliest) + 1),
      retentionFloorSeconds: TEMPLATE_RETENTION_FLOOR_SECONDS,
      message: 'schemaMigrations.applied',
    });
  });
});

suite('a freshly migrated store', () => {
  test('starts the notice stream with one row, an epoch and nothing trimmed', async (context) => {
    const database = await openEmptyDatabase(context);
    await migrateDatabase(database);
    const owner = await database.connect('migration');

    const stream = await noticeStreamRows(owner);
    const firstPosition = await insertNotice(owner, { kind: 'baseline' });

    assert.equal(stream.length, 1);
    assert.match(stream[0]?.epoch ?? '', UUID);
    assert.equal(
      stream[0] !== undefined && stream[0].trimmedThrough < firstPosition,
      true,
    );
  });

  test('holds the global category unmarked from the start', async (context) => {
    const database = await openEmptyDatabase(context);
    await migrateDatabase(database);
    const owner = await database.connect('migration');

    const held = await selectRows<{ name: string; scope: string }>(
      owner,
      `SELECT ${categories.columns.name} AS name, ${categories.columns.scope} AS scope FROM ${qualified(categories)}`,
    );

    assert.deepEqual(held, [{ name: 'unmarked', scope: 'global' }]);
  });

  test('holds the retention floor the deployment set', async (context) => {
    const database = await openEmptyDatabase(context);
    await migrateDatabase(database, { retentionFloorSeconds: 777 });
    const owner = await database.connect('migration');

    const floors = await selectRows<{ floorSeconds: number }>(
      owner,
      `SELECT ${noticeRetention.columns.floorSeconds}::int AS "floorSeconds" FROM ${qualified(noticeRetention)}`,
    );

    assert.deepEqual(floors, [{ floorSeconds: 777 }]);
  });
});
