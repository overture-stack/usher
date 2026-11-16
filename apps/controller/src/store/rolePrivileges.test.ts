import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
  type GrantBeyondUse,
  grantsBeyondUse,
  privilegeProblems,
  privilegesBeyondNeed,
  RUNTIME_WRITES,
  writesUnrecorded,
} from './rolePrivileges.js';
import type { HeldFunction, HeldPrivileges, HeldRelation } from './types.js';

const ROW_COLUMNS = ['created_at', 'id', 'note'];

const table = (
  name: string,
  privileges: readonly string[] = [],
  updatable: readonly string[] = [],
): HeldRelation => ({
  columns: [...new Set([...ROW_COLUMNS, ...updatable])].toSorted(),
  grants: false,
  kind: 'table',
  name,
  owns: false,
  privileges,
  reads: true,
  updatable,
});

const callable = (name: string, executes: boolean): HeldFunction => ({
  executes,
  grants: false,
  name,
  owns: false,
});

// The runtime role exactly as its migrations and the schema migration command leave it: every table
// read, the record of applied migrations among them, each permitted write, the notice positions'
// sequence untouched, and the trimming, unbounded and bounded, its only calls.
const MIGRATED_ROLE: HeldPrivileges = {
  creatableSchemas: [],
  createsSchemas: false,
  functions: [
    callable('record_change', false),
    callable('trim_notices', true),
    callable('trim_notices', true),
  ],
  memberships: [],
  relations: [
    ...[...RUNTIME_WRITES].map(([name, { deletes, updates }]) =>
      table(
        name,
        ['INSERT', ...(deletes ? ['DELETE'] : [])],
        updates === 'every column' ? ROW_COLUMNS : updates,
      ),
    ),
    table('change_records'),
    table('notice_retention'),
    table('schema_migrations'),
    {
      ...table('notices_position_seq'),
      columns: [],
      kind: 'sequence',
      reads: false,
    },
  ],
  roleAttributes: [],
  schema: { grants: false, owns: false, uses: true },
};

// A role holding the reading of every table and nothing else.
const READ_ONLY_ROLE: HeldPrivileges = {
  ...MIGRATED_ROLE,
  functions: MIGRATED_ROLE.functions.map(({ name }) => callable(name, false)),
  relations: MIGRATED_ROLE.relations.map((relation) => ({
    ...relation,
    privileges: [],
    updatable: [],
  })),
};

const withRelation = (
  held: HeldPrivileges,
  name: string,
  change: (relation: HeldRelation) => HeldRelation,
): HeldPrivileges => ({
  ...held,
  relations: held.relations.map((relation) =>
    relation.name === name ? change(relation) : relation,
  ),
});

const granting =
  (
    name: string,
    privilege: string,
  ): ((held: HeldPrivileges) => HeldPrivileges) =>
  (held) =>
    withRelation(held, name, (relation) => ({
      ...relation,
      privileges: [...relation.privileges, privilege],
    }));

suite("the privileges of the controller's database role", () => {
  test('finds nothing beyond need in the privileges the migrations and the schema migration command grant the runtime role, nor in reading alone', () => {
    assert.deepEqual(privilegesBeyondNeed(MIGRATED_ROLE), []);
    assert.deepEqual(privilegesBeyondNeed(READ_ONLY_ROLE), []);
    assert.deepEqual(grantsBeyondUse(MIGRATED_ROLE), []);
  });

  test('finds TRUNCATE or TRIGGER on any table, and any write beyond the migrations on an append-only one, an insert included, naming the privilege and the table', () => {
    const cases: readonly {
      change: (held: HeldPrivileges) => HeldPrivileges;
      found: string;
    }[] = [
      { change: granting('grants', 'TRUNCATE'), found: 'TRUNCATE on grants' },
      {
        change: granting('change_records', 'INSERT'),
        found: 'INSERT on change_records',
      },
      {
        change: granting('audit_log', 'TRIGGER'),
        found: 'TRIGGER on audit_log',
      },
      {
        change: granting('grant_decisions', 'DELETE'),
        found: 'DELETE on grant_decisions',
      },
      {
        change: granting('key_encryption_key_check', 'DELETE'),
        found: 'DELETE on key_encryption_key_check',
      },
      {
        change: (held) =>
          withRelation(held, 'audit_log', (relation) => ({
            ...relation,
            updatable: relation.columns,
          })),
        found: 'UPDATE on audit_log',
      },
      {
        change: (held) =>
          withRelation(held, 'notices', (relation) => ({
            ...relation,
            updatable: ['note'],
          })),
        found: 'UPDATE (note) on notices',
      },
    ];

    cases.forEach(({ change, found }) => {
      const held = change(MIGRATED_ROLE);
      assert.deepEqual(privilegesBeyondNeed(held), [found]);
      assert.deepEqual(grantsBeyondUse(held), []);
    });
  });

  test('tolerates any other write, call or reading of every table the migrations grant the runtime role none of, finding it beyond use alone as its privilege and its object', () => {
    const cases: readonly {
      change: (held: HeldPrivileges) => HeldPrivileges;
      found: GrantBeyondUse;
    }[] = [
      {
        change: (held) => ({ ...held, memberships: ['pg_read_all_data'] }),
        found: { object: 'pg_read_all_data', privilege: 'membership' },
      },
      {
        change: granting('users', 'DELETE'),
        found: { object: 'users', privilege: 'DELETE' },
      },
      {
        change: granting('users', 'REFERENCES'),
        found: { object: 'users', privilege: 'REFERENCES' },
      },
      {
        change: granting('notices', 'MAINTAIN'),
        found: { object: 'notices', privilege: 'MAINTAIN' },
      },
      {
        change: granting('notices_position_seq', 'UPDATE'),
        found: { object: 'notices_position_seq', privilege: 'UPDATE' },
      },
      {
        change: (held) =>
          withRelation(held, 'grants', (relation) => ({
            ...relation,
            updatable: [...relation.updatable, 'note'],
          })),
        found: { column: 'note', object: 'grants', privilege: 'UPDATE' },
      },
      {
        change: (held) => ({
          ...held,
          functions: [
            callable('record_change', true),
            ...held.functions.slice(1),
          ],
        }),
        found: { object: 'record_change()', privilege: 'EXECUTE' },
      },
    ];

    cases.forEach(({ change, found }) => {
      const held = change(MIGRATED_ROLE);
      assert.deepEqual(privilegesBeyondNeed(held), []);
      assert.deepEqual(grantsBeyondUse(held), [found]);
      assert.deepEqual(privilegeProblems(held), []);
    });
  });

  test('finds an update of several columns as one grant for each column, its privilege bare', () => {
    const held = withRelation(MIGRATED_ROLE, 'users', (relation) => ({
      ...relation,
      updatable: ['created_at', 'note'],
    }));

    assert.deepEqual(grantsBeyondUse(held), [
      { column: 'created_at', object: 'users', privilege: 'UPDATE' },
      { column: 'note', object: 'users', privilege: 'UPDATE' },
    ]);
  });

  test('lets a table the migrations grant whole updates take an update of every column', () => {
    const held = withRelation(MIGRATED_ROLE, 'sid_sign_outs', (relation) => ({
      ...relation,
      updatable: relation.columns,
    }));

    assert.deepEqual(privilegesBeyondNeed(held), []);
  });

  test('finds ownership, the right to grant, creating anywhere, powers over the server and writing every table', () => {
    const held: HeldPrivileges = {
      ...withRelation(MIGRATED_ROLE, 'audit_log', (relation) => ({
        ...relation,
        grants: true,
        owns: true,
      })),
      creatableSchemas: ['public', 'usher'],
      createsSchemas: true,
      functions: [
        { executes: true, grants: true, name: 'record_change', owns: true },
        callable('trim_notices', true),
      ],
      memberships: ['pg_execute_server_program', 'pg_write_all_data'],
      roleAttributes: ['SUPERUSER', 'BYPASSRLS'],
      schema: { grants: true, owns: true, uses: true },
    };

    assert.deepEqual(privilegesBeyondNeed(held), [
      'the SUPERUSER attribute',
      'the BYPASSRLS attribute',
      'membership in pg_execute_server_program',
      'membership in pg_write_all_data',
      'CREATE on the database',
      'CREATE on the schema public',
      'CREATE on the schema usher',
      'ownership of the schema',
      'the right to grant on the schema',
      'ownership of audit_log',
      'the right to grant on audit_log',
      'ownership of record_change()',
      'the right to grant on record_change()',
    ]);
  });

  test('finds a role writing while it may not insert into the audit log, and none that may only read', () => {
    const unrecorded = withRelation(MIGRATED_ROLE, 'audit_log', (relation) => ({
      ...relation,
      privileges: [],
    }));
    const readOnlyButUpdating = withRelation(
      READ_ONLY_ROLE,
      'grants',
      (relation) => ({ ...relation, updatable: ['revoked_at'] }),
    );

    assert.equal(writesUnrecorded(MIGRATED_ROLE), false);
    assert.equal(writesUnrecorded(READ_ONLY_ROLE), false);
    assert.equal(writesUnrecorded(unrecorded), true);
    assert.equal(writesUnrecorded(readOnlyButUpdating), true);
  });
});

suite('the problems refusing a start on a database role', () => {
  test('finds none in the role the migrations leave, nor in one that may only read', () => {
    assert.deepEqual(privilegeProblems(MIGRATED_ROLE), []);
    assert.deepEqual(privilegeProblems(READ_ONLY_ROLE), []);
  });

  test("names the database URL's variable for a role holding more than it needs, listing every privilege beyond", () => {
    const held = granting(
      'grants',
      'TRUNCATE',
    )({
      ...MIGRATED_ROLE,
      creatableSchemas: ['usher'],
    });

    assert.deepEqual(privilegeProblems(held), [
      {
        rule: 'names a database role holding more than the controller needs: CREATE on the schema usher, TRUNCATE on grants',
        variable: 'USHER_DATABASE_URL',
      },
    ]);
  });

  test("names the database URL's variable and the audit log for a role writing without recording", () => {
    const held = withRelation(MIGRATED_ROLE, 'audit_log', (relation) => ({
      ...relation,
      privileges: [],
    }));

    const [problem] = privilegeProblems(held);

    assert.equal(problem?.variable, 'USHER_DATABASE_URL');
    assert.match(problem?.rule ?? '', /may not insert into audit_log/u);
  });

  test("names the schema's variable and the schema migration command when the schema holds no record of applied migrations, and names the schema's absence alone when there is no schema", () => {
    const withoutRecord: HeldPrivileges = {
      ...MIGRATED_ROLE,
      relations: MIGRATED_ROLE.relations.filter(
        ({ name }) => name !== 'schema_migrations',
      ),
    };
    const withoutSchema: HeldPrivileges = {
      ...MIGRATED_ROLE,
      relations: [],
      schema: undefined,
    };

    assert.deepEqual(privilegeProblems(withoutRecord), [
      {
        rule: 'names a schema holding no record of applied migrations, schema_migrations: run the schema migration command, which creates it',
        variable: 'USHER_DATABASE_SCHEMA',
      },
    ]);
    assert.deepEqual(privilegeProblems(withoutSchema), [
      {
        rule: 'names no schema of the database',
        variable: 'USHER_DATABASE_SCHEMA',
      },
    ]);
  });

  test("names the schema's variable and the schema migration command when the database role may not read the record of applied migrations, whose reading is neither beyond need nor beyond use", () => {
    const unread = withRelation(
      MIGRATED_ROLE,
      'schema_migrations',
      (relation) => ({
        ...relation,
        reads: false,
      }),
    );

    assert.deepEqual(privilegeProblems(unread), [
      {
        rule: 'names a schema whose record of applied migrations, schema_migrations, the database role may not read: run the schema migration command, which grants the runtime role reading it',
        variable: 'USHER_DATABASE_SCHEMA',
      },
    ]);
    assert.deepEqual(
      [privilegesBeyondNeed(MIGRATED_ROLE), grantsBeyondUse(MIGRATED_ROLE)],
      [[], []],
    );
  });

  test("names the schema's variable when the database holds no such schema, or the role may not use it", () => {
    const absent = privilegeProblems({ ...MIGRATED_ROLE, schema: undefined });
    const unusable = privilegeProblems({
      ...MIGRATED_ROLE,
      schema: { grants: false, owns: false, uses: false },
    });

    assert.deepEqual(
      [...absent, ...unusable].map(({ variable }) => variable),
      ['USHER_DATABASE_SCHEMA', 'USHER_DATABASE_SCHEMA'],
    );
    assert.notEqual(absent[0]?.rule, unusable[0]?.rule);
  });
});
