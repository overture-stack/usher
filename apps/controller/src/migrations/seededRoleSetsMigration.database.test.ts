import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import pg from 'pg';

import {
	committedQuery,
	migrateDatabaseInProcess,
	openEmptyDatabase,
	selectRows,
} from '../../testing/fixtures/database.js';
import type { TestDatabase } from '../../testing/harness/database.js';

// The last migration before the seeded roles that read gain set creation.
const BEFORE = '0017_revocation_reasons_and_sign_outs';

const READ = ['record.count', 'record.export', 'record.view'];

// What an earlier start seeded: each role by its plane and capabilities, none of them making sets, and
// a role defined beside them, by a name no seeded role carries.
const EARLIER_ROLES: Readonly<Record<string, { capabilities: readonly string[]; plane: string }>> = {
	auditor: { capabilities: READ, plane: 'data' },
	curator: { capabilities: [...READ, 'record.create', 'record.delete', 'record.update'], plane: 'data' },
	editor: { capabilities: [...READ, 'record.create', 'record.update'], plane: 'data' },
	owner: { capabilities: ['grant.view', 'resource.view'], plane: 'control' },
	submitter: { capabilities: ['record.create', 'record.update'], plane: 'data' },
	viewer: { capabilities: READ, plane: 'data' },
};

const CAPABILITIES: readonly { name: string; plane: string }[] = [
	{ name: 'artifact.create', plane: 'data' },
	{ name: 'grant.view', plane: 'control' },
	{ name: 'record.count', plane: 'data' },
	{ name: 'record.create', plane: 'data' },
	{ name: 'record.delete', plane: 'data' },
	{ name: 'record.export', plane: 'data' },
	{ name: 'record.update', plane: 'data' },
	{ name: 'record.view', plane: 'data' },
	{ name: 'resource.view', plane: 'control' },
];

// Writes the capabilities and roles an earlier start wrote, as the system actor, as that start did.
const seedAsEarlierStart = async (owner: pg.ClientBase, schema: string): Promise<void> => {
	await committedQuery(
		owner,
		`INSERT INTO ${schema}.capabilities (entity, action, display_name, plane)
		 SELECT split_part(name, '.', 1), split_part(name, '.', 2), split_part(name, '.', 2), plane
		   FROM unnest($1::text[], $2::text[]) AS capability (name, plane)`,
		[CAPABILITIES.map(({ name }) => name), CAPABILITIES.map(({ plane }) => plane)],
	);
	await committedQuery(
		owner,
		`INSERT INTO ${schema}.roles (name, plane) SELECT * FROM unnest($1::text[], $2::text[])`,
		[Object.keys(EARLIER_ROLES), Object.values(EARLIER_ROLES).map(({ plane }) => plane)],
	);
	const permissions = Object.entries(EARLIER_ROLES).flatMap(([role, { capabilities }]) =>
		capabilities.map((capability) => ({ capability, role })),
	);
	await committedQuery(
		owner,
		`INSERT INTO ${schema}.role_permissions (role_id, capability_id)
		 SELECT role.id, capability.id
		   FROM unnest($1::text[], $2::text[]) AS permission (role, capability)
		   JOIN ${schema}.roles role ON role.name = permission.role
		   JOIN ${schema}.capabilities capability ON capability.entity || '.' || capability.action = permission.capability`,
		[permissions.map(({ role }) => role), permissions.map(({ capability }) => capability)],
	);
};

// Each role's capabilities as the store holds them, sorted.
const storedRoles = async (owner: pg.ClientBase, schema: string): Promise<Record<string, readonly string[]>> => {
	const rows = await selectRows<{ capabilities: string[]; name: string }>(
		owner,
		`SELECT role.name, coalesce(array_agg(capability.entity || '.' || capability.action ORDER BY capability.entity, capability.action)
		          FILTER (WHERE capability.id IS NOT NULL), '{}') AS capabilities
		   FROM ${schema}.roles role
		   LEFT JOIN ${schema}.role_permissions permission ON permission.role_id = role.id
		   LEFT JOIN ${schema}.capabilities capability ON capability.id = permission.capability_id
		  GROUP BY role.name
		  ORDER BY role.name`,
	);
	return Object.fromEntries(rows.map(({ capabilities, name }) => [name, capabilities]));
};

const migratedFrom = async (database: TestDatabase, seedEarlier: boolean): Promise<pg.Client> => {
	await migrateDatabaseInProcess(database, { target: BEFORE });
	const owner = await database.connect('migration');
	if (seedEarlier) {
		await seedAsEarlierStart(owner, pg.escapeIdentifier(database.schema));
	}
	await migrateDatabaseInProcess(database);
	return owner;
};

suite('the migration letting the seeded roles that read make sets', () => {
	test('gives viewer, editor and curator artifact.create on a store an earlier start seeded, and changes no other role', async (context) => {
		const database = await openEmptyDatabase(context);
		const schema = pg.escapeIdentifier(database.schema);

		const owner = await migratedFrom(database, true);

		assert.deepEqual(await storedRoles(owner, schema), {
			auditor: READ,
			curator: [
				'artifact.create',
				'record.count',
				'record.create',
				'record.delete',
				'record.export',
				'record.update',
				'record.view',
			],
			editor: [
				'artifact.create',
				'record.count',
				'record.create',
				'record.export',
				'record.update',
				'record.view',
			],
			owner: ['grant.view', 'resource.view'],
			submitter: ['record.create', 'record.update'],
			viewer: ['artifact.create', ...READ],
		});
		await owner.end();
	});

	test('records each permission it adds as a change by the system actor', async (context) => {
		const database = await openEmptyDatabase(context);
		const schema = pg.escapeIdentifier(database.schema);

		const owner = await migratedFrom(database, true);
		const added = await selectRows<{ actorType: string; idpSubjectId: string | null; role: string }>(
			owner,
			`SELECT record.actor_type AS "actorType", record.idp_subject_id AS "idpSubjectId", role.name AS role
			   FROM ${schema}.change_records record
			   JOIN ${schema}.roles role ON role.id = (record.new_row ->> 'role_id')::uuid
			   JOIN ${schema}.capabilities capability ON capability.id = (record.new_row ->> 'capability_id')::uuid
			  WHERE record.table_name = 'role_permissions' AND record.operation = 'INSERT'
			    AND capability.entity = 'artifact' AND capability.action = 'create'
			  ORDER BY role.name`,
		);

		assert.deepEqual(added, [
			{ actorType: 'system', idpSubjectId: null, role: 'curator' },
			{ actorType: 'system', idpSubjectId: null, role: 'editor' },
			{ actorType: 'system', idpSubjectId: null, role: 'viewer' },
		]);
		await owner.end();
	});

	test('writes nothing on a store no start has seeded, leaving the seeded roles to the first start', async (context) => {
		const database = await openEmptyDatabase(context);
		const schema = pg.escapeIdentifier(database.schema);

		const owner = await migratedFrom(database, false);

		assert.deepEqual(await storedRoles(owner, schema), {});
		assert.deepEqual(await selectRows(owner, `SELECT 1 FROM ${schema}.role_permissions`), []);
		await owner.end();
	});

	test('adds nothing a role already carries', async (context) => {
		const database = await openEmptyDatabase(context);
		const schema = pg.escapeIdentifier(database.schema);
		await migrateDatabaseInProcess(database, { target: BEFORE });
		const owner = await database.connect('migration');
		await seedAsEarlierStart(owner, schema);
		await committedQuery(
			owner,
			`INSERT INTO ${schema}.role_permissions (role_id, capability_id)
			 SELECT role.id, capability.id FROM ${schema}.roles role, ${schema}.capabilities capability
			  WHERE role.name = 'viewer' AND capability.entity = 'artifact' AND capability.action = 'create'`,
		);

		await migrateDatabaseInProcess(database);

		assert.deepEqual((await storedRoles(owner, schema))['viewer'], ['artifact.create', ...READ]);
		await owner.end();
	});
});
