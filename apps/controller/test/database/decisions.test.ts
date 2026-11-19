import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type pg from 'pg';

import {
	committedInsert,
	decisionRow,
	grantRow,
	INTEGRITY,
	openSeededDatabase,
	selectRows,
	stewardOf,
	violation,
	writeOutcome,
} from '../../test-support/fixtures/database.js';
import {
	inTransactionAs,
	inTurn,
	POLICY_CONSTRAINTS,
	POLICY_TABLES,
	qualified,
	seededId,
	SYSTEM_ACTOR,
} from '../../test-support/policy.js';

const { grantDecisions, grants } = POLICY_TABLES;

const answersAbout = (
	client: pg.ClientBase,
	grantId: string,
): Promise<readonly { capabilities: string[]; decision: string }[]> =>
	selectRows<{ capabilities: string[]; decision: string }>(
		client,
		`SELECT ${grantDecisions.columns.capabilities} AS capabilities, ${grantDecisions.columns.decision} AS decision FROM ${qualified(grantDecisions)} WHERE ${grantDecisions.columns.grantId} = $1 ORDER BY ${grantDecisions.columns.decidedAt}`,
		[grantId],
	);

suite('acceptance decisions', () => {
	test('records only an acceptance or a rejection', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context);
		const userId = seededId(seeded.users, 'cy');
		const grantId = String(
			(
				await committedInsert(
					owner,
					grants,
					grantRow({
						grantedBy: stewardOf(seeded),
						holderUserId: userId,
						recordCategoryId: seededId(seeded.categories, 'unmarked'),
						resourceId: seededId(seeded.resources, 'STUDY-B2'),
						roleId: seededId(seeded.roles, 'viewer'),
					}),
				)
			)[grants.columns.id],
		);
		const decisions = ['accepted', 'rejected', 'declined', 'pending', 'Accepted', ''];

		const outcomes = await inTurn(
			decisions.map((decision, index) => ({ decision, index })),
			({ decision, index }) =>
				writeOutcome(
					committedInsert(
						owner,
						grantDecisions,
						decisionRow({
							decidedAt: new Date(Date.UTC(2026, 9, 1, 12, index)),
							decision,
							grantId,
							userId,
						}),
					),
				),
		);

		assert.deepEqual(outcomes, [
			'accepted',
			'accepted',
			INTEGRITY.check,
			INTEGRITY.check,
			INTEGRITY.check,
			INTEGRITY.check,
		]);
		assert.deepEqual(
			(await answersAbout(owner, grantId)).map(({ decision }) => decision),
			['accepted', 'rejected'],
		);
	});

	test('keeps every answer a person gives about a grant', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context);
		const grantId = seededId(seeded.grants, 'boOwns');
		const userId = seededId(seeded.users, 'bo');
		await committedInsert(
			owner,
			grantDecisions,
			decisionRow({
				decidedAt: new Date('2026-10-01T12:00:00Z'),
				decision: 'rejected',
				grantId,
				userId,
			}),
		);

		await committedInsert(
			owner,
			grantDecisions,
			decisionRow({
				decidedAt: new Date('2026-10-02T12:00:00Z'),
				decision: 'accepted',
				grantId,
				userId,
			}),
		);

		assert.deepEqual(
			(await answersAbout(owner, grantId)).map(({ decision }) => decision),
			['rejected', 'accepted'],
		);
	});

	test('records the capabilities shown with every answer', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context);
		const grantId = seededId(seeded.grants, 'boOwns');
		const userId = seededId(seeded.users, 'bo');

		await assert.rejects(
			committedInsert(owner, grantDecisions, {
				...decisionRow({ decision: 'accepted', grantId, userId }),
				[grantDecisions.columns.capabilities]: null,
			}),
			violation(INTEGRITY.notNull),
		);
		await committedInsert(
			owner,
			grantDecisions,
			decisionRow({
				capabilities: ['record.view', 'record.export'],
				decision: 'accepted',
				grantId,
				userId,
			}),
		);

		assert.deepEqual(await answersAbout(owner, grantId), [
			{ capabilities: ['record.view', 'record.export'], decision: 'accepted' },
		]);
	});

	test("orders a person's answers about one grant without a tie", async (context) => {
		const { owner, seeded } = await openSeededDatabase(context);
		const grantId = seededId(seeded.grants, 'boOwns');
		const userId = seededId(seeded.users, 'bo');
		const { columns } = grantDecisions;
		const answerNow = (decision: string): Promise<unknown> =>
			owner.query(
				`INSERT INTO ${qualified(grantDecisions)} (${columns.capabilities}, ${columns.decidedAt}, ${columns.decision}, ${columns.grantId}, ${columns.userId}) VALUES ('{grant.create,grant.revoke,resource.view}', now(), $1, $2, $3)`,
				[decision, grantId, userId],
			);

		await assert.rejects(
			inTransactionAs(owner, SYSTEM_ACTOR, async () => {
				await answerNow('rejected');
				await answerNow('accepted');
			}),
			violation(INTEGRITY.unique, POLICY_CONSTRAINTS.decisionOrder),
		);

		assert.deepEqual(await answersAbout(owner, grantId), []);
	});
});
