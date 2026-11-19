import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type pg from 'pg';

import {
	BASE_FIXTURE,
	committedChange,
	committedInsert,
	committedQuery,
	INTEGRITY,
	isRestrictedDelete,
	openSeededDatabase,
	selectRows,
	unheldId,
	violation,
} from '../../test-support/fixtures/database.js';
import { type PolicyFixture, POLICY_TABLES, qualified, seededId } from '../../test-support/policy.js';

const { resourceFieldValues, resourceFields } = POLICY_TABLES;

const ORGANIZATION = 'Société Exemple du Nord';

const WITH_AN_ORGANIZATION: PolicyFixture = {
	...BASE_FIXTURE,
	fields: { organization: { description: 'Who holds the data' } },
	resources: {
		...BASE_FIXTURE.resources,
		'STUDY-A1': {
			baseTier: 'grant',
			fieldValues: { organization: ORGANIZATION },
			name: 'Cardiac Outcomes',
			offers: ['controlled', 'unmarked'],
		},
	},
};

const valuesOf = (client: pg.ClientBase, resourceId: string): Promise<readonly { value: string }[]> =>
	selectRows<{ value: string }>(
		client,
		`SELECT ${resourceFieldValues.columns.value} AS value FROM ${qualified(resourceFieldValues)} WHERE ${resourceFieldValues.columns.resourceId} = $1`,
		[resourceId],
	);

suite('resource details', () => {
	test("holds a resource's details only under the fields the instance defines", async (context) => {
		const { owner, seeded } = await openSeededDatabase(context, WITH_AN_ORGANIZATION);
		const studyB2 = seededId(seeded.resources, 'STUDY-B2');

		await assert.rejects(
			committedInsert(owner, resourceFieldValues, {
				[resourceFieldValues.columns.fieldId]: unheldId(),
				[resourceFieldValues.columns.resourceId]: studyB2,
				[resourceFieldValues.columns.value]: 'Institut Exemple du Sud',
			}),
			violation(INTEGRITY.foreignKey),
		);

		assert.deepEqual(await valuesOf(owner, studyB2), []);
	});

	test('defines each field once across the instance', async (context) => {
		const { owner } = await openSeededDatabase(context, WITH_AN_ORGANIZATION);

		await assert.rejects(
			committedInsert(owner, resourceFields, {
				[resourceFields.columns.description]: 'The organization, again',
				[resourceFields.columns.name]: 'organization',
			}),
			violation(INTEGRITY.unique),
		);

		assert.deepEqual(
			await selectRows(
				owner,
				`SELECT ${resourceFields.columns.description} AS description FROM ${qualified(resourceFields)} WHERE ${resourceFields.columns.name} = 'organization'`,
			),
			[{ description: 'Who holds the data' }],
		);
	});

	test('keeps a field definition while a resource holds a value for it', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context, WITH_AN_ORGANIZATION);
		const organization = seededId(seeded.fields, 'organization');

		await assert.rejects(
			committedQuery(owner, `DELETE FROM ${qualified(resourceFields)} WHERE ${resourceFields.columns.id} = $1`, [
				organization,
			]),
			isRestrictedDelete,
		);

		assert.deepEqual(await valuesOf(owner, seededId(seeded.resources, 'STUDY-A1')), [{ value: ORGANIZATION }]);
	});

	test('holds one value per resource and field', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context, WITH_AN_ORGANIZATION);
		const studyA1 = seededId(seeded.resources, 'STUDY-A1');

		await assert.rejects(
			committedInsert(owner, resourceFieldValues, {
				[resourceFieldValues.columns.fieldId]: seededId(seeded.fields, 'organization'),
				[resourceFieldValues.columns.resourceId]: studyA1,
				[resourceFieldValues.columns.value]: 'Institut Exemple du Sud',
			}),
			violation(INTEGRITY.unique),
		);

		assert.deepEqual(await valuesOf(owner, studyA1), [{ value: ORGANIZATION }]);
	});

	test("records every change to a resource's details", async (context) => {
		const { owner, seeded } = await openSeededDatabase(context, WITH_AN_ORGANIZATION);
		const revised = 'Société Exemple du Nord-Est « Québec »';

		const { changeRecords: written } = await committedChange(owner, () =>
			owner.query(
				`UPDATE ${qualified(resourceFieldValues)} SET ${resourceFieldValues.columns.value} = $1 WHERE ${resourceFieldValues.columns.resourceId} = $2 AND ${resourceFieldValues.columns.fieldId} = $3`,
				[revised, seededId(seeded.resources, 'STUDY-A1'), seededId(seeded.fields, 'organization')],
			),
		);

		assert.deepEqual(
			written.map(({ newRow, oldRow, tableName }) => ({
				after: newRow?.[resourceFieldValues.columns.value],
				before: oldRow?.[resourceFieldValues.columns.value],
				tableName,
			})),
			[
				{
					after: revised,
					before: ORGANIZATION,
					tableName: resourceFieldValues.name,
				},
			],
		);
	});
});
