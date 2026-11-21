import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import pg from 'pg';

import {
	BASE_FIXTURE,
	committedInsert,
	decisionRow,
	migrateDatabaseInProcess,
	openEmptyDatabase,
	type Row,
	selectRows,
} from '../../testing/fixtures/database.js';
import { POLICY_TABLES, qualified, SELF_GRANT_REQUEST, seededId, seedPolicy } from '../../testing/harness/policy.js';

const { grantDecisions, grantRequests } = POLICY_TABLES;

const HOUR_MS = 3_600_000;

interface ChangeRecord {
	actorType: string;
	idpSubjectId: string | null;
	newRow: Record<string, unknown>;
	oldRow: Record<string, unknown>;
	tableName: string;
}

suite('the declined-decisions migration on a store holding answers and requests from before it', () => {
	test('rewrites the rejected answers and refused requests to declined, records each rewrite as a system change, and keeps the guards', async (context) => {
		const database = await openEmptyDatabase(context);
		await migrateDatabaseInProcess(database, { target: '0012_used_channel_assertions' });
		const owner = await database.connect('migration');
		const schema = pg.escapeIdentifier(database.schema);
		const seeded = await seedPolicy(owner, BASE_FIXTURE);
		const bo = seededId(seeded.users, 'bo');
		const cy = seededId(seeded.users, 'cy');
		const boOwns = seededId(seeded.grants, 'boOwns');

		const rejected = await committedInsert(
			owner,
			grantDecisions,
			decisionRow({
				decidedAt: new Date('2026-10-01T12:00:00Z'),
				decision: 'rejected',
				grantId: boOwns,
				userId: bo,
			}),
		);
		const accepted = await committedInsert(
			owner,
			grantDecisions,
			decisionRow({
				decidedAt: new Date('2026-10-02T12:00:00Z'),
				decision: 'accepted',
				grantId: boOwns,
				userId: bo,
			}),
		);
		const asking: Row = {
			[grantRequests.columns.capabilities]: ['record.count', 'record.export', 'record.view'],
			[grantRequests.columns.decidedAt]: new Date('2026-10-03T12:00:00Z'),
			[grantRequests.columns.decidedBy]: bo,
			[grantRequests.columns.decision]: 'refused',
			[grantRequests.columns.expiresAt]: new Date(Date.now() + 24 * HOUR_MS),
			[grantRequests.columns.holderUserId]: cy,
			[grantRequests.columns.kind]: SELF_GRANT_REQUEST,
			[grantRequests.columns.recordCategoryId]: seededId(seeded.categories, 'controlled'),
			[grantRequests.columns.requestedAt]: new Date('2026-10-02T12:00:00Z'),
			[grantRequests.columns.requestedBy]: cy,
			[grantRequests.columns.resourceId]: seededId(seeded.resources, 'STUDY-A1'),
			[grantRequests.columns.roleId]: seededId(seeded.roles, 'viewer'),
		};
		const request = await committedInsert(owner, grantRequests, asking);
		const requestId = String(request[grantRequests.columns.id]);
		const answerId = String(rejected[grantDecisions.columns.id]);
		const acceptedId = String(accepted[grantDecisions.columns.id]);

		await migrateDatabaseInProcess(database);

		const answers = await selectRows<{ decision: string; id: string }>(
			owner,
			`SELECT decision, id::text AS id FROM ${schema}.grant_decisions WHERE id IN ($1::uuid, $2::uuid) ORDER BY decided_at`,
			[answerId, acceptedId],
		);
		const requests = await selectRows<{ decision: string }>(
			owner,
			`SELECT decision FROM ${schema}.grant_requests WHERE id = $1::uuid`,
			[requestId],
		);
		const records = await selectRows<ChangeRecord>(
			owner,
			`SELECT table_name AS "tableName", old_row AS "oldRow", new_row AS "newRow",
			        actor_type AS "actorType", idp_subject_id AS "idpSubjectId"
			   FROM ${schema}.change_records
			  WHERE operation = 'UPDATE' AND table_name IN ('grant_decisions', 'grant_requests')
			  ORDER BY table_name`,
		);

		assert.deepEqual(
			answers.map(({ decision }) => decision),
			['declined', 'accepted'],
		);
		assert.equal(answers[0]?.id, answerId);
		assert.deepEqual(
			requests.map(({ decision }) => decision),
			['declined'],
		);
		assert.deepEqual(
			records.map(({ tableName, oldRow, newRow, actorType, idpSubjectId }) => ({
				actorType,
				idpSubjectId,
				newDecision: newRow['decision'],
				oldDecision: oldRow['decision'],
				tableName,
			})),
			[
				{
					actorType: 'system',
					idpSubjectId: null,
					newDecision: 'declined',
					oldDecision: 'rejected',
					tableName: 'grant_decisions',
				},
				{
					actorType: 'system',
					idpSubjectId: null,
					newDecision: 'declined',
					oldDecision: 'refused',
					tableName: 'grant_requests',
				},
			],
		);

		await assert.rejects(
			owner.query(`UPDATE ${qualified(grantDecisions)} SET decision = 'accepted' WHERE id = $1`, [answerId]),
			{ constraint: 'grant_decisions_kept' },
		);
		await assert.rejects(
			owner.query(`UPDATE ${qualified(grantRequests)} SET decision = 'granted' WHERE id = $1`, [requestId]),
			{ constraint: 'grant_requests_decision_kept' },
		);
		await owner.end();
	});
});
