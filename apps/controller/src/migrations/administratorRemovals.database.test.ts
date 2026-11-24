import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import type pg from 'pg';

import {
	ANA_ACTING,
	committedQuery,
	INSUFFICIENT_PRIVILEGE,
	INTEGRITY,
	openSeededDatabase,
	selectRows,
	stewardOf,
	violation,
} from '../../testing/fixtures/database.js';
import { USHER_SCHEMA } from '../../testing/harness/database.js';
import { POLICY_TABLES, qualified, seededId } from '../../testing/harness/policy.js';

const { administrators, administratorRemovals, nominations } = POLICY_TABLES;

// The SQLSTATE of an integrity constraint violation, which a trigger raises a named rule with.
const HELD_ONCE_CODE = '23000';

// The rule a removal's history is kept by, and the rule one live administrator per person holds.
const KEPT_CONSTRAINT = 'administrator_removals_kept';
const HELD_ONCE_CONSTRAINT = 'administrator_held_once';

interface ColumnShape {
	column: string;
	nullable: string;
	type: string;
}

// A table's columns, in order, as the catalogue of the Controller's schema gives them.
const columnsOf = (client: pg.ClientBase, table: string): Promise<readonly ColumnShape[]> =>
	selectRows<ColumnShape>(
		client,
		`SELECT column_name AS column, data_type AS type, is_nullable AS nullable
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position`,
		[USHER_SCHEMA, table],
	);

// Nominates a person by the steward, and returns the nomination's id.
const nominate = async (owner: pg.ClientBase, nominee: string, steward: string): Promise<string> => {
	const nominated = randomUUID();
	await committedQuery(
		owner,
		`INSERT INTO ${qualified(nominations)} (${nominations.columns.id}, ${nominations.columns.nominatedAt}, ${nominations.columns.nominatedBy}, ${nominations.columns.nomineeId})
       VALUES ($1, clock_timestamp(), $2, $3)`,
		[nominated, steward, nominee],
	);
	return nominated;
};

// Makes the nominee an administrator by their acceptance of the nomination.
const accept = (owner: pg.ClientBase, nominationId: string, nominee: string) =>
	committedQuery(
		owner,
		`INSERT INTO ${qualified(administrators)} (${administrators.columns.userId}, ${administrators.columns.nominationId}, ${administrators.columns.acceptedAt}) VALUES ($1, $2, now())`,
		[nominee, nominationId],
	);

// Removes the administrator a nomination made, by a row of its own.
const remove = (client: pg.ClientBase, nominationId: string, removedBy: string) =>
	committedQuery(
		client,
		`INSERT INTO ${qualified(administratorRemovals)} (${administratorRemovals.columns.nominationId}, ${administratorRemovals.columns.removedAt}, ${administratorRemovals.columns.removedBy}) VALUES ($1, now(), $2)`,
		[nominationId, removedBy],
		ANA_ACTING,
	);

suite("the administrator removals' table, from migration 0015", () => {
	test('shapes a removal as a row keyed by the administrator it removes, holding when and by whom', async (context) => {
		const { owner } = await openSeededDatabase(context);

		assert.deepEqual(await columnsOf(owner, administratorRemovals.name), [
			{ column: 'nomination_id', nullable: 'NO', type: 'uuid' },
			{ column: 'removed_at', nullable: 'NO', type: 'timestamp with time zone' },
			{ column: 'removed_by', nullable: 'NO', type: 'uuid' },
		]);
	});

	test('keys an administrator by the nomination accepted, so one person may hold a row again after a removal', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context);
		const cy = seededId(seeded.users, 'cy');
		const first = await nominate(owner, cy, stewardOf(seeded));
		await accept(owner, first, cy);
		await remove(owner, first, seededId(seeded.users, 'ana'));

		const second = await nominate(owner, cy, stewardOf(seeded));
		await accept(owner, second, cy);

		const rows = await selectRows<{ nominationId: string }>(
			owner,
			`SELECT ${administrators.columns.nominationId} AS "nominationId" FROM ${qualified(administrators)}
        WHERE ${administrators.columns.userId} = $1 ORDER BY ${administrators.columns.acceptedAt}`,
			[cy],
		);
		assert.deepEqual(
			rows.map(({ nominationId }) => nominationId),
			[first, second],
		);
	});

	test('refuses a second live administrator row for one person, by the constraint administrator_held_once', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context);
		const cy = seededId(seeded.users, 'cy');
		await accept(owner, await nominate(owner, cy, stewardOf(seeded)), cy);

		await assert.rejects(
			accept(owner, await nominate(owner, cy, stewardOf(seeded)), cy),
			violation(HELD_ONCE_CODE, HELD_ONCE_CONSTRAINT),
		);
	});

	test("keeps every removal as written, for the schema's owner too", async (context) => {
		const { owner, seeded } = await openSeededDatabase(context);
		const cy = seededId(seeded.users, 'cy');
		const nominated = await nominate(owner, cy, stewardOf(seeded));
		await accept(owner, nominated, cy);
		await committedQuery(
			owner,
			`INSERT INTO ${qualified(administratorRemovals)} (${administratorRemovals.columns.nominationId}, ${administratorRemovals.columns.removedAt}, ${administratorRemovals.columns.removedBy}) VALUES ($1, now(), $2)`,
			[nominated, seededId(seeded.users, 'ana')],
		);

		await assert.rejects(
			committedQuery(
				owner,
				`UPDATE ${qualified(administratorRemovals)} SET ${administratorRemovals.columns.removedAt} = now()`,
			),
			violation(HELD_ONCE_CODE, KEPT_CONSTRAINT),
		);
		await assert.rejects(
			committedQuery(owner, `DELETE FROM ${qualified(administratorRemovals)}`),
			violation(HELD_ONCE_CODE, KEPT_CONSTRAINT),
		);
	});

	test("lets the controller's role insert and read a removal, and neither change nor delete it", async (context) => {
		const { database, owner, seeded } = await openSeededDatabase(context);
		const controller = await database.connect('runtime');
		const cy = seededId(seeded.users, 'cy');
		const nominated = await nominate(owner, cy, stewardOf(seeded));
		await accept(owner, nominated, cy);

		await remove(controller, nominated, seededId(seeded.users, 'ana'));
		const read = await selectRows(controller, `SELECT * FROM ${qualified(administratorRemovals)}`);

		await assert.rejects(
			committedQuery(
				controller,
				`UPDATE ${qualified(administratorRemovals)} SET ${administratorRemovals.columns.removedAt} = now()`,
				[],
				ANA_ACTING,
			),
			{ code: INSUFFICIENT_PRIVILEGE },
		);
		await assert.rejects(
			committedQuery(controller, `DELETE FROM ${qualified(administratorRemovals)}`, [], ANA_ACTING),
			{ code: INSUFFICIENT_PRIVILEGE },
		);
		assert.equal(read.length, 1);
	});

	test('refuses a removal naming an administrator who is not one, by the foreign key', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context);
		const pending = await nominate(owner, seededId(seeded.users, 'cy'), stewardOf(seeded));

		await assert.rejects(
			committedQuery(
				owner,
				`INSERT INTO ${qualified(administratorRemovals)} (${administratorRemovals.columns.nominationId}, ${administratorRemovals.columns.removedAt}, ${administratorRemovals.columns.removedBy}) VALUES ($1, now(), $2)`,
				[pending, seededId(seeded.users, 'ana')],
			),
			violation(INTEGRITY.foreignKey, 'administrator_removals_nomination_id_fkey'),
		);
	});
});
