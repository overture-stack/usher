import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import pg from 'pg';

import { DATABASE_ROLES, USHER_SCHEMA } from '../../test-support/database.js';
import {
  ANA_ACTING,
  auditEntryRow,
  BASE_FIXTURE,
  committedChange,
  committedInsert,
  committedQuery,
  decisionRow,
  INSUFFICIENT_PRIVILEGE,
  noticeRow,
  openSeededDatabase,
  CHANGE_RECORDED_TABLES,
  selectRows,
  stewardOf,
  tableNames,
  writeOutcome,
} from '../../test-support/fixtures/database.js';
import {
  inTurn,
  type PolicyFixture,
  POLICY_TABLES,
  qualified,
  seededId,
} from '../../test-support/policy.js';

const {
  auditLog,
  changeRecords,
  grantDecisions,
  grants,
  notices,
  principalRevocations,
  resources,
} = POLICY_TABLES;

const WITH_A_STANDING_REVOCATION: PolicyFixture = {
  ...BASE_FIXTURE,
  revocations: [{ reason: 'account reported compromised', user: 'cy' }],
};

const privilegesOfEveryTable = (
  client: pg.ClientBase,
): Promise<readonly { acl: string | null; name: string }[]> =>
  selectRows<{ acl: string | null; name: string }>(
    client,
    `SELECT relation.relname AS name, relation.relacl::text AS acl FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1 ORDER BY relation.relname COLLATE "C"`,
    [USHER_SCHEMA],
  );

const triggersOn = (
  client: pg.ClientBase,
  table: { name: string },
): Promise<readonly { enabled: string; name: string }[]> =>
  selectRows<{ enabled: string; name: string }>(
    client,
    `SELECT trigger_.tgname AS name, trigger_.tgenabled::text AS enabled
       FROM pg_trigger trigger_
       JOIN pg_class relation ON relation.oid = trigger_.tgrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1 AND relation.relname = $2 AND NOT trigger_.tgisinternal
      ORDER BY trigger_.tgname COLLATE "C"`,
    [USHER_SCHEMA, table.name],
  );

suite("the controller's database role", () => {
  test("keeps grant decisions, notices, change records and the audit log append-only for the controller's role", async (context) => {
    const { database, seeded } = await openSeededDatabase(context);
    const controller = await database.connect('runtime');
    const ana = seededId(seeded.users, 'ana');
    const anaViews = seededId(seeded.grants, 'anaViews');

    const inserted = [
      await writeOutcome(
        committedInsert(
          controller,
          grantDecisions,
          decisionRow({ decision: 'rejected', grantId: anaViews, userId: ana }),
          ANA_ACTING,
        ),
      ),
      await writeOutcome(
        committedInsert(controller, notices, noticeRow({ kind: 'baseline' })),
      ),
      await writeOutcome(
        committedInsert(
          controller,
          auditLog,
          auditEntryRow({ grantId: anaViews }),
        ),
      ),
    ];
    const selected = await inTurn(
      [grantDecisions, notices, auditLog, changeRecords],
      (table) =>
        writeOutcome(controller.query(`SELECT * FROM ${qualified(table)}`)),
    );
    const rewrites = await inTurn(
      [
        `UPDATE ${qualified(grantDecisions)} SET ${grantDecisions.columns.decision} = 'accepted'`,
        `DELETE FROM ${qualified(grantDecisions)}`,
        `UPDATE ${qualified(notices)} SET ${notices.columns.kind} = 'global'`,
        `DELETE FROM ${qualified(notices)}`,
        `UPDATE ${qualified(auditLog)} SET ${auditLog.columns.type} = 'org.overture.usher.grant.revoke'`,
        `DELETE FROM ${qualified(auditLog)}`,
        `UPDATE ${qualified(changeRecords)} SET ${changeRecords.columns.operation} = ${changeRecords.columns.operation}`,
        `DELETE FROM ${qualified(changeRecords)}`,
      ],
      (text) => writeOutcome(committedQuery(controller, text, [], ANA_ACTING)),
    );

    assert.deepEqual(inserted, ['accepted', 'accepted', 'accepted']);
    assert.deepEqual(selected, [
      'accepted',
      'accepted',
      'accepted',
      'accepted',
    ]);
    assert.deepEqual(
      rewrites,
      rewrites.map(() => INSUFFICIENT_PRIVILEGE),
    );
  });

  test("keeps every grant in place for the controller's role", async (context) => {
    const { database, owner } = await openSeededDatabase(context);
    const controller = await database.connect('runtime');
    const grantsBefore = await selectRows(
      owner,
      `SELECT * FROM ${qualified(grants)} ORDER BY ${grants.columns.id}`,
    );

    const outcome = await writeOutcome(
      committedQuery(
        controller,
        `DELETE FROM ${qualified(grants)}`,
        [],
        ANA_ACTING,
      ),
    );

    assert.equal(outcome, INSUFFICIENT_PRIVILEGE);
    assert.deepEqual(
      await selectRows(
        owner,
        `SELECT * FROM ${qualified(grants)} ORDER BY ${grants.columns.id}`,
      ),
      grantsBefore,
    );
  });

  test("lets the controller's role lift a revocation and change nothing else of it", async (context) => {
    const { database, owner, seeded } = await openSeededDatabase(
      context,
      WITH_A_STANDING_REVOCATION,
    );
    const controller = await database.connect('runtime');
    const revocation = seeded.revocations[0] ?? '';
    const { columns } = principalRevocations;
    const byId = `WHERE ${columns.id} = $2`;

    const refused = await inTurn(
      [
        {
          parameters: [seededId(seeded.users, 'ana'), revocation],
          text: `UPDATE ${qualified(principalRevocations)} SET ${columns.userId} = $1 ${byId}`,
        },
        {
          parameters: [seededId(seeded.users, 'bo'), revocation],
          text: `UPDATE ${qualified(principalRevocations)} SET ${columns.revokedBy} = $1 ${byId}`,
        },
        {
          parameters: [new Date('2026-01-01T00:00:00Z'), revocation],
          text: `UPDATE ${qualified(principalRevocations)} SET ${columns.revokedAt} = $1 ${byId}`,
        },
        {
          parameters: ['a different reason', revocation],
          text: `UPDATE ${qualified(principalRevocations)} SET ${columns.reason} = $1 ${byId}`,
        },
        {
          parameters: [revocation],
          text: `DELETE FROM ${qualified(principalRevocations)} WHERE ${columns.id} = $1`,
        },
      ],
      ({ parameters, text }) =>
        writeOutcome(committedQuery(controller, text, parameters, ANA_ACTING)),
    );
    const lifted = await writeOutcome(
      committedQuery(
        controller,
        `UPDATE ${qualified(principalRevocations)} SET ${columns.liftedAt} = now(), ${columns.liftedBy} = $1 ${byId}`,
        [stewardOf(seeded), revocation],
        ANA_ACTING,
      ),
    );

    assert.deepEqual(
      refused,
      refused.map(() => INSUFFICIENT_PRIVILEGE),
    );
    assert.equal(lifted, 'accepted');
    assert.deepEqual(
      await selectRows<{ liftedBy: string; reason: string; userId: string }>(
        owner,
        `SELECT ${columns.liftedBy}::text AS "liftedBy", ${columns.reason} AS reason, ${columns.userId}::text AS "userId" FROM ${qualified(principalRevocations)}`,
      ),
      [
        {
          liftedBy: stewardOf(seeded),
          reason: 'account reported compromised',
          userId: seededId(seeded.users, 'cy'),
        },
      ],
    );
  });

  test("keeps the schema out of the controller's reach", async (context) => {
    const { database, owner } = await openSeededDatabase(context);
    const controller = await database.connect('runtime');
    const [existingTrigger] = await triggersOn(owner, grants);
    const [triggerFunction] = await selectRows<{ name: string }>(
      owner,
      `SELECT function_.proname AS name FROM pg_proc function_ JOIN pg_namespace namespace ON namespace.oid = function_.pronamespace WHERE namespace.nspname = $1 AND function_.prorettype = 'trigger'::regtype LIMIT 1`,
      [USHER_SCHEMA],
    );
    const tablesBefore = await tableNames(owner);

    const outcomes = await inTurn(
      [
        `CREATE TABLE ${qualified({ name: 'intruder' })} (note text)`,
        'CREATE TABLE public.intruder (note text)',
        'CREATE SCHEMA intruder',
        `ALTER TABLE ${qualified(grants)} ADD COLUMN intruder text`,
        `DROP TABLE ${qualified(auditLog)}`,
        `CREATE FUNCTION ${qualified({ name: 'intruder' })}() RETURNS integer LANGUAGE sql AS 'SELECT 1'`,
        `CREATE TRIGGER intruder BEFORE INSERT ON ${qualified(grants)} FOR EACH ROW EXECUTE FUNCTION ${qualified(
          {
            name: triggerFunction?.name ?? 'missing_trigger_function',
          },
        )}()`,
        `DROP TRIGGER ${pg.escapeIdentifier(existingTrigger?.name ?? 'missing_trigger')} ON ${qualified(grants)}`,
      ],
      (text) => writeOutcome(controller.query(text)),
    );

    assert.notEqual(existingTrigger, undefined);
    assert.notEqual(triggerFunction, undefined);
    assert.deepEqual(
      outcomes,
      outcomes.map(() => INSUFFICIENT_PRIVILEGE),
    );
    assert.deepEqual(await tableNames(owner), tablesBefore);
  });

  test("keeps every trigger in force for the controller's role", async (context) => {
    const { database, owner } = await openSeededDatabase(context);
    const controller = await database.connect('runtime');
    const triggersBefore = await inTurn(CHANGE_RECORDED_TABLES, (table) =>
      triggersOn(owner, table),
    );

    const disabling = await inTurn(CHANGE_RECORDED_TABLES, (table) =>
      writeOutcome(
        controller.query(`ALTER TABLE ${qualified(table)} DISABLE TRIGGER ALL`),
      ),
    );
    const disablingUserTriggers = await writeOutcome(
      controller.query(`ALTER TABLE ${qualified(grants)} DISABLE TRIGGER USER`),
    );
    const replicating = await writeOutcome(
      controller.query("SET session_replication_role = 'replica'"),
    );
    const { changeRecords: recorded } = await committedChange(
      controller,
      () =>
        controller.query(
          `UPDATE ${qualified(resources)} SET ${resources.columns.name} = 'Cardiac Outcomes Registry' WHERE ${resources.columns.externalId} = 'STUDY-A1'`,
        ),
      ANA_ACTING,
    );

    assert.deepEqual(
      disabling,
      CHANGE_RECORDED_TABLES.map(() => INSUFFICIENT_PRIVILEGE),
    );
    assert.equal(disablingUserTriggers, INSUFFICIENT_PRIVILEGE);
    assert.equal(replicating, INSUFFICIENT_PRIVILEGE);
    assert.deepEqual(
      await inTurn(CHANGE_RECORDED_TABLES, (table) => triggersOn(owner, table)),
      triggersBefore,
    );
    assert.equal(
      triggersBefore.every((triggers) => triggers.length > 0),
      true,
    );
    assert.deepEqual(
      recorded.map(({ tableName }) => tableName),
      [resources.name],
    );
  });

  test("keeps truncation out of the controller's reach on every table", async (context) => {
    const { database, owner } = await openSeededDatabase(context);
    const controller = await database.connect('runtime');
    const tables = await tableNames(owner);

    const outcomes = await inTurn(tables, (name) =>
      writeOutcome(controller.query(`TRUNCATE ${qualified({ name })}`)),
    );

    assert.equal(tables.length > 0, true);
    assert.deepEqual(
      outcomes,
      tables.map(() => INSUFFICIENT_PRIVILEGE),
    );
  });

  test("keeps a function the migration role creates later out of the controller's reach until it is granted", async (context) => {
    const { database, owner } = await openSeededDatabase(context);
    const controller = await database.connect('runtime');
    const later = qualified({ name: 'function_of_a_later_migration' });
    await committedQuery(
      owner,
      `CREATE FUNCTION ${later}() RETURNS integer LANGUAGE sql AS 'SELECT 1'`,
    );

    const outcome = await writeOutcome(controller.query(`SELECT ${later}()`));

    assert.equal(outcome, INSUFFICIENT_PRIVILEGE);
  });

  test("keeps the controller's role from widening its own privileges", async (context) => {
    const { database, owner } = await openSeededDatabase(context);
    const controller = await database.connect('runtime');
    const tables = await tableNames(owner);
    const privilegesBefore = await privilegesOfEveryTable(owner);
    const runtime = pg.escapeIdentifier(DATABASE_ROLES.runtime);
    const migration = pg.escapeIdentifier(DATABASE_ROLES.migration);

    await inTurn(tables, async (name) => {
      await writeOutcome(
        controller.query(`GRANT ALL ON ${qualified({ name })} TO ${runtime}`),
      );
      await writeOutcome(
        controller.query(`GRANT ALL ON ${qualified({ name })} TO PUBLIC`),
      );
    });
    const roleChanges = await inTurn(
      [
        `ALTER ROLE ${runtime} SUPERUSER`,
        `ALTER ROLE ${runtime} CREATEROLE`,
        `ALTER ROLE ${runtime} BYPASSRLS`,
        `GRANT ${migration} TO ${runtime}`,
        `SET ROLE ${migration}`,
        `ALTER TABLE ${qualified(auditLog)} OWNER TO ${runtime}`,
      ],
      (text) => writeOutcome(controller.query(text)),
    );
    const [identity] = await selectRows<{ role: string; superuser: boolean }>(
      controller,
      'SELECT current_user AS role, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user',
    );

    assert.deepEqual(await privilegesOfEveryTable(owner), privilegesBefore);
    assert.deepEqual(
      roleChanges,
      roleChanges.map(() => INSUFFICIENT_PRIVILEGE),
    );
    assert.deepEqual(identity, {
      role: DATABASE_ROLES.runtime,
      superuser: false,
    });
  });
});

suite('the settings the runtime role holds', () => {
	test("updates each setting's value, change time and actor alone, and neither inserts into nor deletes from the settings", async (context) => {
		const { owner } = await openSeededDatabase(context);
		const settingsTable = qualified(POLICY_TABLES.settings);
		const [held] = await selectRows<Record<string, boolean>>(
			owner,
			`SELECT has_table_privilege($1, $2, 'INSERT') AS inserts,
			        has_table_privilege($1, $2, 'DELETE') AS deletes,
			        has_column_privilege($1, $2, 'value', 'UPDATE') AS updates_value,
			        has_column_privilege($1, $2, 'changed_at', 'UPDATE') AS updates_changed_at,
			        has_column_privilege($1, $2, 'changed_by', 'UPDATE') AS updates_changed_by,
			        has_column_privilege($1, $2, 'name', 'UPDATE') AS updates_name`,
			[DATABASE_ROLES.runtime, settingsTable],
		);
		assert.deepEqual(held, {
			deletes: false,
			inserts: false,
			updates_changed_at: true,
			updates_changed_by: true,
			updates_name: false,
			updates_value: true,
		});
	});
});
