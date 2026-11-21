import type pg from 'pg';

import { ENVIRONMENT_VARIABLES } from '../configuration/index.js';
import { ControllerError, type StartProblem } from '../failures/index.js';
import type { HeldFunction, HeldPrivileges, HeldRelation, HeldSchema } from './types.js';

/** What the Controller's runtime role may write in one table, beyond inserting into it and reading it. */
export interface PermittedWrites {
	/** Whether it may delete rows. */
	deletes: boolean;

	/** Whether it may insert rows. */
	inserts: boolean;

	/** The columns it may update, or every column. */
	updates: readonly string[] | 'every column';
}

/**
 * Every table the release's migrations let the Controller's runtime role write, and how: each says whether
 * it takes inserts, and a table named nowhere here is granted for reading alone. Reading is outside this list,
 * since a read rewrites nothing, and a role that may only read starts. A grant beyond this list is
 * tolerated unless it would change the schema or rewrite history.
 */
export const RUNTIME_WRITES: ReadonlyMap<string, PermittedWrites> = new Map(
	Object.entries({
		administrators: { deletes: false, inserts: true, updates: [] },
		application_keys: {
			deletes: false,
			inserts: true,
			updates: ['confirmed_at', 'revoked_at', 'revoked_by'],
		},
		application_resources: { deletes: true, inserts: true, updates: [] },
		applications: {
			deletes: false,
			inserts: true,
			updates: ['description', 'display_name'],
		},
		audit_log: { deletes: false, inserts: true, updates: [] },
		capabilities: {
			deletes: false,
			inserts: true,
			updates: ['description', 'display_name'],
		},
		categories: { deletes: true, inserts: true, updates: ['description'] },
		exchanged_sids: { deletes: true, inserts: true, updates: 'every column' },
		global_revocations: { deletes: false, inserts: true, updates: [] },
		grant_decisions: { deletes: false, inserts: true, updates: [] },
		grant_operations: { deletes: true, inserts: true, updates: [] },
		grant_requests: {
			deletes: false,
			inserts: true,
			updates: ['decided_at', 'decided_by', 'decision', 'grant_id'],
		},
		grants: {
			deletes: false,
			inserts: true,
			updates: ['ended_at', 'expires_at', 'revoked_at', 'revoked_by', 'role_id'],
		},
		identity_provider_configuration: {
			deletes: false,
			inserts: false,
			updates: ['recorded_at', 'value'],
		},
		key_fingerprints: { deletes: false, inserts: true, updates: [] },
		nomination_declines: { deletes: false, inserts: true, updates: [] },
		nomination_revocations: { deletes: false, inserts: true, updates: [] },
		nominations: { deletes: false, inserts: true, updates: [] },
		notices: { deletes: false, inserts: true, updates: [] },
		notification_outbox: {
			deletes: false,
			inserts: true,
			updates: ['delivered_at'],
		},
		principal_revocations: {
			deletes: false,
			inserts: true,
			updates: ['lifted_at', 'lifted_by'],
		},
		resource_categories: { deletes: true, inserts: true, updates: [] },
		resource_field_values: { deletes: true, inserts: true, updates: ['value'] },
		resource_fields: { deletes: true, inserts: true, updates: ['description'] },
		resources: {
			deletes: true,
			inserts: true,
			updates: ['base_tier', 'description', 'name', 'retired_at', 'retired_by', 'suppressed', 'updated_at'],
		},
		role_permissions: { deletes: true, inserts: true, updates: [] },
		roles: { deletes: false, inserts: true, updates: ['description'] },
		settings: {
			deletes: false,
			inserts: false,
			updates: ['changed_at', 'changed_by', 'value'],
		},
		sid_sign_outs: { deletes: true, inserts: true, updates: 'every column' },
		subject_sign_outs: {
			deletes: true,
			inserts: true,
			updates: 'every column',
		},
		used_channel_assertions: { deletes: true, inserts: true, updates: [] },
		user_identities: { deletes: false, inserts: true, updates: [] },
		users: { deletes: false, inserts: true, updates: [] },
	} satisfies Record<string, PermittedWrites>),
);

/**
 * The table recording the migrations applied to the schema, which the start reads before anything
 * else in it. The schema migration command creates it and grants the runtime role reading it,
 * beside the reading the migrations grant on every other table, so the start requires that reading
 * of the role, and reading is never a grant beyond use.
 */
export const MIGRATION_RECORD = 'schema_migrations';

/**
 * The functions of the Controller's schema the release's migrations let its runtime role call, by
 * name, each name standing for every function of the schema so named: `trim_notices` for the trim
 * taking no argument and for the one taking the most notices it deletes.
 */
export const RUNTIME_CALLS: ReadonlySet<string> = new Set(['trim_notices']);

// Where every change the Controller makes is recorded, so a role writing anywhere must insert here.
const AUDIT_LOG = 'audit_log';

// The tables whose rows are history, written as the migrations grant and in no other way, so any
// write beyond those grants, an insert included, is refused: a change record inserted by anything but
// its trigger would be forged. The key fingerprints are among them, since rewriting the
// key-encryption key's would let a start under another key pass.
const APPEND_ONLY_TABLES: ReadonlySet<string> = new Set([
	AUDIT_LOG,
	'change_records',
	'grant_decisions',
	'key_fingerprints',
	'nomination_declines',
	'nomination_revocations',
	'nominations',
	'notices',
]);

const HISTORY_WRITES: ReadonlySet<string> = new Set(['DELETE', 'INSERT', 'UPDATE']);

// The tables whose rows are kept as the migrations write them: no row is deleted, though some may be updated.
const KEPT_TABLES: ReadonlySet<string> = new Set(['identity_provider_configuration', 'settings']);

// Privileges refused on any table: emptying it at once, and attaching behaviour to its writes.
const REFUSED_ON_ANY_TABLE: ReadonlySet<string> = new Set(['TRIGGER', 'TRUNCATE']);

// The predefined roles refused to the Controller's role: reaching the server's own files and
// programs, or writing every table without one grant naming it.
const REFUSED_ROLES: ReadonlySet<string> = new Set([
	'pg_execute_server_program',
	'pg_read_server_files',
	'pg_write_all_data',
	'pg_write_server_files',
]);

// The predefined roles a start tolerates, as reading rewrites nothing.
const TOLERATED_ROLES: ReadonlySet<string> = new Set(['pg_read_all_data']);

// MAINTAIN, which lets a role lock, vacuum or reindex a table, exists from PostgreSQL 17.
const MAINTAIN_SINCE_VERSION = 170_000;

const WRITES: ReadonlySet<string> = new Set(['DELETE', 'INSERT', 'TRUNCATE']);

interface PrivilegeCheck {
	/** A catalogue function call on `relation`, true when the role holds the privilege. */
	check: string;

	privilege: string;
}

const SEQUENCE_CHECKS: readonly PrivilegeCheck[] = [
	{
		check: "has_sequence_privilege(relation.oid, 'USAGE')",
		privilege: 'USAGE',
	},
	{
		check: "has_sequence_privilege(relation.oid, 'UPDATE')",
		privilege: 'UPDATE',
	},
];

// INSERT and REFERENCES may be granted column by column, and either counts on any column.
const tableChecks = (maintains: boolean): readonly PrivilegeCheck[] => [
	{
		check: "has_any_column_privilege(relation.oid, 'INSERT')",
		privilege: 'INSERT',
	},
	...['DELETE', 'TRUNCATE', 'TRIGGER', ...(maintains ? ['MAINTAIN'] : [])].map((privilege) => ({
		check: `has_table_privilege(relation.oid, '${privilege}')`,
		privilege,
	})),
	{
		check: "has_any_column_privilege(relation.oid, 'REFERENCES')",
		privilege: 'REFERENCES',
	},
];

const heldAmong = (checks: readonly PrivilegeCheck[]): string =>
	`array_remove(ARRAY[${checks.map(({ check, privilege }) => `CASE WHEN ${check} THEN '${privilege}' END`).join(', ')}], NULL)`;

const withGrantOption = (privileges: readonly string[]): string =>
	privileges.map((privilege) => `${privilege} WITH GRANT OPTION`).join(', ');

const ROLE_QUERY = `
  SELECT ARRAY(
           SELECT namespace.nspname::text FROM pg_namespace namespace
            WHERE namespace.nspname !~ '^pg_' AND namespace.nspname <> 'information_schema'
              AND has_schema_privilege(namespace.oid, 'CREATE')
            ORDER BY namespace.nspname
         ) AS "creatableSchemas",
         has_database_privilege(current_database(), 'CREATE') AS "createsSchemas",
         ARRAY(SELECT name FROM unnest($1::text[]) AS name WHERE pg_has_role(name, 'MEMBER') ORDER BY name) AS memberships,
         array_remove(ARRAY[
           CASE WHEN role.rolsuper THEN 'SUPERUSER' END,
           CASE WHEN role.rolcreaterole THEN 'CREATEROLE' END,
           CASE WHEN role.rolcreatedb THEN 'CREATEDB' END,
           CASE WHEN role.rolreplication THEN 'REPLICATION' END,
           CASE WHEN role.rolbypassrls THEN 'BYPASSRLS' END
         ], NULL) AS "roleAttributes",
         current_setting('server_version_num')::int AS version
    FROM pg_roles role
   WHERE role.rolname = current_user`;

const SCHEMA_QUERY = `
  SELECT has_schema_privilege(namespace.oid, '${withGrantOption(['CREATE', 'USAGE'])}') AS grants,
         pg_has_role(namespace.nspowner, 'MEMBER') AS owns,
         has_schema_privilege(namespace.oid, 'USAGE') AS uses
    FROM pg_namespace namespace
   WHERE namespace.nspname = $1`;

const relationsQuery = (maintains: boolean): string => `
  SELECT ARRAY(
           SELECT attribute.attname::text FROM pg_attribute attribute
            WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped
            ORDER BY attribute.attname
         ) AS columns,
         CASE WHEN relation.relkind = 'S'
              THEN has_sequence_privilege(relation.oid, '${withGrantOption(['SELECT', 'UPDATE', 'USAGE'])}')
              ELSE has_any_column_privilege(relation.oid, '${withGrantOption(['INSERT', 'REFERENCES', 'SELECT', 'UPDATE'])}')
                OR has_table_privilege(relation.oid, '${withGrantOption(['DELETE', 'TRIGGER', 'TRUNCATE', ...(maintains ? ['MAINTAIN'] : [])])}')
         END AS grants,
         CASE WHEN relation.relkind = 'S' THEN 'sequence' ELSE 'table' END AS kind,
         relation.relname::text AS name,
         pg_has_role(relation.relowner, 'MEMBER') AS owns,
         has_table_privilege(relation.oid, 'SELECT') AS reads,
         CASE WHEN relation.relkind = 'S'
              THEN ${heldAmong(SEQUENCE_CHECKS)}
              ELSE ${heldAmong(tableChecks(maintains))}
         END AS privileges,
         ARRAY(
           SELECT attribute.attname::text FROM pg_attribute attribute
            WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped
              AND relation.relkind <> 'S' AND has_column_privilege(relation.oid, attribute.attnum, 'UPDATE')
            ORDER BY attribute.attname
         ) AS updatable
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = $1 AND relation.relkind IN ('f', 'm', 'p', 'r', 'S', 'v')
   ORDER BY relation.relname`;

const FUNCTIONS_QUERY = `
  SELECT has_function_privilege(function_.oid, 'EXECUTE') AS executes,
         has_function_privilege(function_.oid, 'EXECUTE WITH GRANT OPTION') AS grants,
         function_.proname::text AS name,
         pg_has_role(function_.proowner, 'MEMBER') AS owns
    FROM pg_proc function_
    JOIN pg_namespace namespace ON namespace.oid = function_.pronamespace
   WHERE namespace.nspname = $1
   ORDER BY function_.proname`;

interface RoleRow {
	creatableSchemas: string[];
	createsSchemas: boolean;
	memberships: string[];
	roleAttributes: string[];
	version: number;
}

/**
 * Reads, from the catalogue, everything the role a connection runs as holds over the database, the
 * Controller's schema and each of its relations and functions, whether granted to the role itself,
 * to a role it inherits from, or to everyone. It reads no table of the schema, so it waits on no
 * table's lock.
 *
 * @param client a connection under the role, as the Controller connects.
 * @param schema the Controller's schema.
 * @throws when the catalogue holds no row for the connected role.
 */
export const readHeldPrivileges = async (client: pg.ClientBase, schema: string): Promise<HeldPrivileges> => {
	const [role] = (await client.query<RoleRow>(ROLE_QUERY, [[...REFUSED_ROLES, ...TOLERATED_ROLES]])).rows;
	if (role !== undefined) {
		const schemas = await client.query<HeldSchema>(SCHEMA_QUERY, [schema]);
		const relations = await client.query<HeldRelation>(relationsQuery(role.version >= MAINTAIN_SINCE_VERSION), [
			schema,
		]);
		const functions = await client.query<HeldFunction>(FUNCTIONS_QUERY, [schema]);
		return {
			creatableSchemas: role.creatableSchemas,
			createsSchemas: role.createsSchemas,
			functions: functions.rows,
			memberships: role.memberships,
			relations: relations.rows,
			roleAttributes: role.roleAttributes,
			schema: schemas.rows[0],
		};
	}
	throw new ControllerError('the catalogue holds no row for the connected role');
};

const permittedPrivileges = (permitted: PermittedWrites | undefined): readonly string[] => [
	...(permitted?.inserts === true ? ['INSERT'] : []),
	...(permitted?.deletes === true ? ['DELETE'] : []),
];

const updatesBeyond = ({ updatable }: HeldRelation, permitted: PermittedWrites | undefined): readonly string[] => {
	const updates = permitted?.updates ?? [];
	return updates === 'every column' ? [] : updatable.filter((column) => !updates.includes(column));
};

/**
 * A grant a start tolerates, as fields a reader can match without parsing a sentence: a rule matching
 * every UPDATE matches `privilege` alone, whichever columns the grant names.
 */
export interface GrantBeyondUse {
	/** The column, for a grant on one column of a table; absent for a grant on the whole object. */
	column?: string;

	/** What it is held on: a table, a sequence, a function with its parentheses, or a predefined role. */
	object: string;

	/** The privilege, bare, such as `DELETE` or `UPDATE`; `membership` for a predefined role. */
	privilege: string;
}

// What a role holds on a relation beyond the writes the release's migrations grant there: each
// privilege, and UPDATE on each column beyond those it may update, or on the whole table when every
// column is.
const beyondRelease = (relation: HeldRelation): readonly GrantBeyondUse[] => {
	const permitted = relation.kind === 'table' ? RUNTIME_WRITES.get(relation.name) : undefined;
	const allowed = permittedPrivileges(permitted);
	const updates = updatesBeyond(relation, permitted);
	const object = relation.name;
	return [
		...relation.privileges
			.filter((privilege) => !allowed.includes(privilege))
			.map((privilege) => ({ object, privilege })),
		...(updates.length > 0 && updates.length === relation.columns.length
			? [{ object, privilege: 'UPDATE' }]
			: updates.map((column) => ({ column, object, privilege: 'UPDATE' }))),
	];
};

const wordingOf = ({ column, object, privilege }: GrantBeyondUse): string =>
	column === undefined ? `${privilege} on ${object}` : `${privilege} (${column}) on ${object}`;

// Whether a privilege beyond the release's would let the role rewrite history or change how a table
// behaves: TRUNCATE or TRIGGER on any table, any write on an append-only one, and a delete from a table
// whose settings are kept.
const rewrites = (relation: HeldRelation, { privilege }: GrantBeyondUse): boolean =>
	REFUSED_ON_ANY_TABLE.has(privilege) ||
	(relation.kind === 'table' && APPEND_ONLY_TABLES.has(relation.name) && HISTORY_WRITES.has(privilege)) ||
	(relation.kind === 'table' && KEPT_TABLES.has(relation.name) && privilege === 'DELETE');

const relationFindings = (relation: HeldRelation): readonly string[] => [
	...(relation.owns ? [`ownership of ${relation.name}`] : []),
	...(relation.grants ? [`the right to grant on ${relation.name}`] : []),
	...beyondRelease(relation)
		.filter((grant) => rewrites(relation, grant))
		.map(wordingOf),
];

const functionFindings = (held: HeldFunction): readonly string[] => [
	...(held.owns ? [`ownership of ${held.name}()`] : []),
	...(held.grants ? [`the right to grant on ${held.name}()`] : []),
];

/**
 * Every write, call or predefined role a role holds that the release's migrations don't grant the
 * runtime role and that changes neither the schema nor history, each as its privilege and what it is
 * held on: reading every table through `pg_read_all_data` among them. A start tolerates them, so an
 * instance of one release keeps running once a later release's migration grants more.
 *
 * @param held what the role holds.
 */
export const grantsBeyondUse = (held: HeldPrivileges): readonly GrantBeyondUse[] => [
	...held.memberships
		.filter((role) => TOLERATED_ROLES.has(role))
		.map((role) => ({ object: role, privilege: 'membership' })),
	...held.relations.flatMap((relation) => beyondRelease(relation).filter((grant) => !rewrites(relation, grant))),
	...held.functions
		.filter(({ executes, name }) => executes && !RUNTIME_CALLS.has(name))
		.map(({ name }) => ({ object: `${name}()`, privilege: 'EXECUTE' })),
];

const schemaFindings = (schema: HeldSchema | undefined): readonly string[] => [
	...(schema?.owns === true ? ['ownership of the schema'] : []),
	...(schema?.grants === true ? ['the right to grant on the schema'] : []),
];

/**
 * Everything a role holds that would let it change the schema or rewrite history, each worded as the
 * privilege and what it is held on: a role attribute beyond logging in, a predefined role reaching
 * the server or writing every table, creating in the database or in any of its schemas, owning or
 * granting on the schema or anything in it, TRUNCATE or TRIGGER on any table, and any write on an
 * append-only table beyond what the migrations grant. Any other grant beyond the release's is
 * tolerated ({@link grantsBeyondUse}).
 *
 * @param held what the role holds.
 */
export const privilegesBeyondNeed = (held: HeldPrivileges): readonly string[] => [
	...held.roleAttributes.map((attribute) => `the ${attribute} attribute`),
	...held.memberships.filter((role) => REFUSED_ROLES.has(role)).map((role) => `membership in ${role}`),
	...(held.createsSchemas ? ['CREATE on the database'] : []),
	...held.creatableSchemas.map((schema) => `CREATE on the schema ${schema}`),
	...schemaFindings(held.schema),
	...held.relations.flatMap(relationFindings),
	...held.functions.flatMap(functionFindings),
];

const writes = (relation: HeldRelation): boolean =>
	relation.kind === 'table' &&
	(relation.updatable.length > 0 || relation.privileges.some((privilege) => WRITES.has(privilege)));

/**
 * Whether a role may write to some table of the Controller's schema, so an instance under it serves
 * writes; one that may only read serves none.
 *
 * @param held what the role holds.
 */
export const writesTables = ({ relations }: HeldPrivileges): boolean => relations.some(writes);

const recordsChanges = ({ kind, name, privileges }: HeldRelation): boolean =>
	kind === 'table' && name === AUDIT_LOG && privileges.includes('INSERT');

/**
 * Whether a role may write to some table yet may not insert into the audit log, so a change it made
 * could go unrecorded. A role that may only read writes nothing to record.
 *
 * @param held what the role holds.
 */
export const writesUnrecorded = (held: HeldPrivileges): boolean =>
	writesTables(held) && !held.relations.some(recordsChanges);

const schemaProblems = (schema: HeldSchema | undefined): readonly StartProblem[] => {
	if (schema?.uses === true) {
		return [];
	}
	return [
		{
			rule:
				schema === undefined
					? 'names no schema of the database'
					: 'names a schema the database role may not use',
			variable: ENVIRONMENT_VARIABLES.databaseSchema,
		},
	];
};

// The record is the schema migration command's, which creates it and grants reading it, so its
// absence and a role that may not read it both send the operator to that command.
const recordReadingProblems = (relations: readonly HeldRelation[]): readonly StartProblem[] => {
	const record = relations.find(({ kind, name }) => kind === 'table' && name === MIGRATION_RECORD);
	if (record?.reads === true) {
		return [];
	}
	return [
		{
			rule:
				record === undefined
					? `names a schema holding no record of applied migrations, ${MIGRATION_RECORD}: run the schema migration command, which creates it`
					: `names a schema whose record of applied migrations, ${MIGRATION_RECORD}, the database role may not read: run the schema migration command, which grants the runtime role reading it`,
			variable: ENVIRONMENT_VARIABLES.databaseSchema,
		},
	];
};

// A schema the role may not use is named as that alone, its record unreachable whatever it holds.
const recordProblems = ({ relations, schema }: HeldPrivileges): readonly StartProblem[] =>
	schema?.uses === true ? recordReadingProblems(relations) : [];

/**
 * The rules a role breaks as the Controller's database role, each naming the variable at fault and
 * each refusing the start: a schema it cannot use, a record of applied migrations the schema lacks
 * or the role may not read, anything it holds beyond what the Controller needs, and writing without
 * recording.
 *
 * @param held what the role holds.
 */
export const privilegeProblems = (held: HeldPrivileges): readonly StartProblem[] => {
	const beyond = privilegesBeyondNeed(held);
	return [
		...schemaProblems(held.schema),
		...recordProblems(held),
		...(beyond.length === 0
			? []
			: [
					{
						rule: `names a database role holding more than the controller needs: ${beyond.join(', ')}`,
						variable: ENVIRONMENT_VARIABLES.databaseUrl,
					},
				]),
		...(writesUnrecorded(held)
			? [
					{
						rule: `names a database role that may write but may not insert into ${AUDIT_LOG}, so a change could go unrecorded`,
						variable: ENVIRONMENT_VARIABLES.databaseUrl,
					},
				]
			: []),
	];
};
