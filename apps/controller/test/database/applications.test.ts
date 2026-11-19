import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import type pg from 'pg';

import {
	BASE_FIXTURE,
	committedInsert,
	insertRow,
	INTEGRITY,
	openSeededDatabase,
	type Row,
	selectRows,
	stewardOf,
	violation,
} from '../../test-support/fixtures/database.js';
import {
	fixtureApplicationId,
	inTransactionAs,
	inTurn,
	type PolicyFixture,
	POLICY_TABLES,
	qualified,
	seededId,
	SYSTEM_ACTOR,
} from '../../test-support/policy.js';

const { applicationResources, applications, resources } = POLICY_TABLES;

const SERVING_NOTHING: PolicyFixture = {
	...BASE_FIXTURE,
	applications: {
		'ims-arranger': { serves: [] },
		'ims-lyric': { serves: [] },
	},
};

// Each application's served resources by externalId, sorted, by the application's id.
const servedSets = async (client: pg.ClientBase): Promise<Readonly<Record<string, readonly string[]>>> => {
	const rows = await selectRows<{ application: string; served: string[] }>(
		client,
		`SELECT application.${applications.columns.id}::text AS application,
            coalesce(array_agg(resource.${resources.columns.externalId} ORDER BY resource.${resources.columns.externalId}) FILTER (WHERE resource.${resources.columns.id} IS NOT NULL), '{}') AS served
       FROM ${qualified(applications)} application
       LEFT JOIN ${qualified(applicationResources)} served ON served.${applicationResources.columns.applicationId} = application.${applications.columns.id}
       LEFT JOIN ${qualified(resources)} resource ON resource.${resources.columns.id} = served.${applicationResources.columns.resourceId}
      GROUP BY application.${applications.columns.id}`,
	);
	return Object.fromEntries(rows.map(({ application, served }) => [application, served]));
};

const serving = (applicationId: string, resourceId: string): Row => ({
	[applicationResources.columns.applicationId]: applicationId,
	[applicationResources.columns.resourceId]: resourceId,
});

suite('applications and the resources they serve', () => {
	test('holds each fixture application under the uuid derived from its label, its label as its display name', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context);

		const rows = await selectRows<{ display_name: string; id: string }>(
			owner,
			`SELECT ${applications.columns.displayName} AS display_name, ${applications.columns.id}::text AS id FROM ${qualified(applications)} ORDER BY 1`,
		);

		assert.deepEqual(
			rows,
			['ims-arranger', 'ims-lyric'].map((label) => ({
				display_name: label,
				id: fixtureApplicationId(label),
			})),
		);
		assert.deepEqual(seeded.applications, {
			'ims-arranger': fixtureApplicationId('ims-arranger'),
			'ims-lyric': fixtureApplicationId('ims-lyric'),
		});
	});

	test('serves a resource from several applications, and several resources from one', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context, SERVING_NOTHING);
		const arranger = seededId(seeded.applications, 'ims-arranger');
		const lyric = seededId(seeded.applications, 'ims-lyric');
		const studyA1 = seededId(seeded.resources, 'STUDY-A1');
		const studyB2 = seededId(seeded.resources, 'STUDY-B2');

		await inTransactionAs(owner, SYSTEM_ACTOR, () =>
			inTurn(
				[
					serving(arranger, studyA1),
					serving(arranger, studyB2),
					serving(lyric, studyA1),
					serving(lyric, studyB2),
				],
				(row) => insertRow(owner, applicationResources, row),
			),
		);
		await assert.rejects(
			committedInsert(owner, applicationResources, serving(lyric, studyB2)),
			violation(INTEGRITY.unique),
		);

		assert.deepEqual(await servedSets(owner), {
			[arranger]: ['STUDY-A1', 'STUDY-B2'],
			[lyric]: ['STUDY-A1', 'STUDY-B2'],
		});
	});

	test('keeps two applications of one display name apart, by their ids', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context);
		const steward = stewardOf(seeded);
		const [first, second] = [randomUUID(), randomUUID()];
		const register = (id: string): Promise<unknown> =>
			committedInsert(owner, applications, {
				[applications.columns.displayName]: 'Search portal',
				[applications.columns.id]: id,
				[applications.columns.registeredAt]: new Date(),
				[applications.columns.registeredBy]: steward,
			});

		await register(first);
		await register(second);
		await committedInsert(owner, applicationResources, serving(first, seededId(seeded.resources, 'study.c_3')));
		await committedInsert(owner, applicationResources, serving(second, seededId(seeded.resources, 'STUDY-B2')));

		assert.deepEqual(await servedSets(owner), {
			[first]: ['study.c_3'],
			[second]: ['STUDY-B2'],
			[seededId(seeded.applications, 'ims-arranger')]: ['STUDY-A1', 'STUDY-B2'],
			[seededId(seeded.applications, 'ims-lyric')]: ['STUDY-A1'],
		});
	});
});
