import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type pg from 'pg';

import { committedQuery, INTEGRITY, openSeededDatabase, violation } from '../../testing/fixtures/database.js';
import { POLICY_TABLES, qualified, seededId } from '../../testing/harness/policy.js';

const { categories } = POLICY_TABLES;

// The unique index a category's name is held to, within its scope and resource, in any letter case.
const NAME_INDEX = 'categories_name_unique';

// Writes a category directly in the store: global when no resource is named, else that resource's own.
const insertCategory = (owner: pg.ClientBase, name: string, resourceId?: string) =>
	committedQuery(
		owner,
		`INSERT INTO ${qualified(categories)} (${categories.columns.scope}, ${categories.columns.resourceId}, ${categories.columns.name})
       VALUES ($1, $2, $3)`,
		[resourceId === undefined ? 'global' : 'resource', resourceId ?? null, name],
	);

suite("a category's name, from migration 0016", () => {
	test('refuses a global category whose name another holds in another letter case, by the index categories_name_unique', async (context) => {
		const { owner } = await openSeededDatabase(context);

		await assert.rejects(insertCategory(owner, 'Controlled'), violation(INTEGRITY.unique, NAME_INDEX));
		await assert.rejects(insertCategory(owner, 'UNMARKED'), violation(INTEGRITY.unique, NAME_INDEX));
	});

	test("refuses a resource's own category whose name another of that resource's holds in another letter case, and lets another resource or the global scope hold it", async (context) => {
		const { owner, seeded } = await openSeededDatabase(context);
		const first = seededId(seeded.resources, 'STUDY-A1');
		const second = seededId(seeded.resources, 'STUDY-B2');
		await insertCategory(owner, 'Pilot', first);

		await assert.rejects(insertCategory(owner, 'pilot', first), violation(INTEGRITY.unique, NAME_INDEX));
		await insertCategory(owner, 'PILOT', second);
		await insertCategory(owner, 'pilot');
	});
});
