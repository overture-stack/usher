import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	administratorCaller,
	assertSucceeded,
	createGrant,
	createSelfGrant,
	personCaller,
} from '../../testing/harness/admin.js';
import { AUDIT_EVENT_TYPES, auditRows, dataOf, emittedType } from '../../testing/harness/auditEvents.js';
import { selectRows } from '../../testing/fixtures/database.js';
import {
	B2_OWN_CATEGORY,
	CAST,
	CONTROLLED,
	fixtureGrant,
	grantsFixture,
	HOUR_MS,
	rowCounts,
	STUDY_A1,
	UNMARKED,
} from '../../testing/fixtures/grants.js';
import { type Harness, withHarness } from '../../testing/harness/harness.js';
import { GRANT_OPERATIONS, POLICY_TABLES, qualified } from '../../testing/harness/policy.js';
import { cleanupFor } from '../../testing/harness/waiting.js';
import { startDirectory } from '../../testing/peripherals/directory.js';

const { grantRequests, grants } = POLICY_TABLES;

const inTwoHours = (): string => new Date(Date.now() + 2 * HOUR_MS).toISOString();

// The categories each written row names, in the order written, and how many calls wrote them.
const writtenBy = async (
	harness: Harness,
	table: { name: string },
): Promise<{ calls: number; categories: readonly string[] }> => {
	const rows = await selectRows<{ category: string; creationId: string | null }>(
		harness.clients.migration,
		`SELECT category.scope || '.' || category.name AS category, written.creation_id::text AS "creationId"
		   FROM ${qualified(table)} written
		   JOIN ${qualified(POLICY_TABLES.categories)} category ON category.id = written.record_category_id
		  WHERE written.creation_id IS NOT NULL
		  ORDER BY category.name`,
	);
	return {
		calls: new Set(rows.map(({ creationId }) => creationId)).size,
		categories: rows.map(({ category }) => category),
	};
};

const operationsBy = async (harness: Harness, subject: string): Promise<number> =>
	(
		await selectRows<{ count: number }>(
			harness.clients.migration,
			`SELECT count(*)::integer AS count FROM ${qualified({ name: 'grant_operations' })}
			  WHERE ${GRANT_OPERATIONS.columns.idpSubjectId} = $1`,
			[subject],
		)
	)[0]?.count ?? 0;

const categoriesIn = (body: unknown, member: 'grants' | 'requests'): unknown =>
	(Reflect.get(body as object, member) as readonly { category: unknown }[]).map(({ category }) => category);

suite('a grant naming several categories', () => {
	test("writes one grant per category in one call, in order, each with its own event and count against the granter's rate", async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const created = await createGrant(await personCaller(harness, CAST.ownerOfA1), {
				categories: [UNMARKED, CONTROLLED],
				holder: { subject: CAST.newcomer.subject },
				resource: STUDY_A1,
				role: 'viewer',
			});

			assertSucceeded(created, 'the grant');
			assert.equal(created.status, 201);
			assert.deepEqual(categoriesIn(created.body, 'grants'), [UNMARKED, CONTROLLED]);
			assert.deepEqual(await writtenBy(harness, grants), {
				calls: 1,
				categories: [CONTROLLED, UNMARKED],
			});
			const events = (await auditRows(harness.clients.migration))
				.filter((row) => row.type === emittedType(AUDIT_EVENT_TYPES.grantCreation))
				.map((row) => dataOf(row)['category']);
			assert.deepEqual(events.toSorted(), [CONTROLLED, UNMARKED]);
			assert.equal(await operationsBy(harness, CAST.ownerOfA1.subject), 2);
		});
	});

	test('writes nothing when one category is refused, naming its place: one the resource does not offer, or one held already', async () => {
		await withHarness(
			{
				fixture: grantsFixture({
					grants: { held: fixtureGrant('recipient', 'viewer', { category: 'controlled' }) },
				}),
			},
			async (harness) => {
				const owner = await personCaller(harness, CAST.ownerOfA1);
				const before = await rowCounts(harness);

				const unoffered = await createGrant(owner, {
					categories: [UNMARKED, B2_OWN_CATEGORY],
					holder: { subject: CAST.newcomer.subject },
					resource: STUDY_A1,
					role: 'viewer',
				});
				const held = await createGrant(owner, {
					categories: [UNMARKED, CONTROLLED],
					holder: { subject: CAST.recipient.subject },
					resource: STUDY_A1,
					role: 'viewer',
				});

				assert.deepEqual(
					[unoffered, held].map(({ problem, status }) => [status, problem?.code, problem?.['categoryIndex']]),
					[
						[422, 'categoryNotOffered', 1],
						[409, 'alreadyHolds', 1],
					],
				);
				assert.deepEqual(await rowCounts(harness), before);
			},
		);
	});

	test("asks once per category for an administrator's self-grant, the requests written by one call", async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const asked = await createSelfGrant(await administratorCaller(harness), {
				categories: [CONTROLLED, UNMARKED],
				expiresAt: inTwoHours(),
				resource: STUDY_A1,
				role: 'viewer',
			});

			assert.equal(asked.status, 202);
			assert.deepEqual(categoriesIn(asked.body, 'requests'), [CONTROLLED, UNMARKED]);
			assert.deepEqual(await writtenBy(harness, grantRequests), {
				calls: 1,
				categories: [CONTROLLED, UNMARKED],
			});
		});
	});

	test("issues an owner's self-grant once per category, the grants written by one call", async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const issued = await createSelfGrant(await personCaller(harness, CAST.ownerOfA1), {
				categories: [CONTROLLED, UNMARKED],
				expiresAt: inTwoHours(),
				resource: STUDY_A1,
				role: 'viewer',
			});

			assert.equal(issued.status, 201);
			assert.deepEqual(categoriesIn(issued.body, 'grants'), [CONTROLLED, UNMARKED]);
			assert.deepEqual(await writtenBy(harness, grants), {
				calls: 1,
				categories: [CONTROLLED, UNMARKED],
			});
		});
	});

	test('answers an owner naming the holder by address with the categories as sent, naming no grant', async (context) => {
		const directory = await startDirectory({
			accounts: [{ email: CAST.newcomer.email, id: CAST.newcomer.subject }],
		});
		cleanupFor(context).defer(() => directory.stop());
		await withHarness({ configuration: directory.configuration, fixture: grantsFixture() }, async (harness) => {
			const created = await createGrant(await personCaller(harness, CAST.ownerOfA1), {
				categories: [CONTROLLED, UNMARKED],
				holder: { email: CAST.newcomer.email },
				resource: STUDY_A1,
				role: 'viewer',
			});

			assert.equal(created.status, 202);
			assert.deepEqual(created.body, {
				categories: [CONTROLLED, UNMARKED],
				email: CAST.newcomer.email,
				kind: 'grantByAddress',
				resource: STUDY_A1,
				role: 'viewer',
			});
		});
	});
});
