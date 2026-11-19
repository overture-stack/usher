import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type pg from 'pg';

import {
	BASE_FIXTURE,
	committedInsert,
	committedQuery,
	type GrantParts,
	grantRow,
	INSUFFICIENT_PRIVILEGE,
	INTEGRITY,
	openSeededDatabase,
	type Row,
	selectRows,
	stewardOf,
	writeOutcome,
} from '../../test-support/fixtures/database.js';
import {
	inTurn,
	POLICY_CONSTRAINTS,
	POLICY_TABLES,
	qualified,
	seededId,
	type SeededPolicy,
} from '../../test-support/policy.js';

const { grants } = POLICY_TABLES;

const HOUR_MS = 3_600_000;

// Cy's viewer grant on STUDY-A1 under `unmarked`, on the terms each test grants again.
const cyViewing = (seeded: SeededPolicy, over: Partial<GrantParts> = {}): Row =>
	grantRow({
		grantedBy: stewardOf(seeded),
		holderUserId: seededId(seeded.users, 'cy'),
		recordCategoryId: seededId(seeded.categories, 'unmarked'),
		resourceId: seededId(seeded.resources, 'STUDY-A1'),
		roleId: seededId(seeded.roles, 'viewer'),
		...over,
	});

const insertedId = async (client: pg.ClientBase, row: Row): Promise<string> =>
	String((await committedInsert(client, grants, row))[grants.columns.id]);

const ending = (client: pg.ClientBase, grantId: string, endedAt: Date): Promise<string> =>
	writeOutcome(
		committedQuery(
			client,
			`UPDATE ${qualified(grants)} SET ${grants.columns.endedAt} = $1 WHERE ${grants.columns.id} = $2`,
			[endedAt, grantId],
		),
	);

const endedAtOf = async (client: pg.ClientBase, grantId: string): Promise<Date | null> => {
	const [row] = await selectRows<{ endedAt: Date | null }>(
		client,
		`SELECT ${grants.columns.endedAt} AS "endedAt" FROM ${qualified(grants)} WHERE ${grants.columns.id} = $1`,
		[grantId],
	);
	return row?.endedAt ?? null;
};

const constraintOf = async (attempt: Promise<unknown>): Promise<unknown> =>
	attempt.then(
		() => 'accepted',
		(error: unknown) =>
			typeof error === 'object' && error !== null ? Reflect.get(error, 'constraint') : undefined,
	);

suite("a grant's end, once a grant on its terms replaced it", () => {
	test('ends only a grant that has expired, no earlier than its expiry, for the controller role and the owner alike', async (context) => {
		const { database, owner, seeded } = await openSeededDatabase(context, BASE_FIXTURE);
		const controller = await database.connect('runtime');
		const now = Date.now();
		const expiry = new Date(now - HOUR_MS);
		const openEnded = await insertedId(owner, cyViewing(seeded));
		const expired = await insertedId(
			owner,
			cyViewing(seeded, {
				expiresAt: expiry,
				recordCategoryId: seededId(seeded.categories, 'controlled'),
			}),
		);

		const refused = await inTurn(
			[
				{ client: owner, endedAt: new Date(now), grantId: openEnded },
				{ client: controller, endedAt: new Date(now), grantId: openEnded },
				{
					client: controller,
					endedAt: new Date(expiry.getTime() - 1000),
					grantId: expired,
				},
			],
			({ client, endedAt, grantId }) =>
				constraintOf(
					committedQuery(
						client,
						`UPDATE ${qualified(grants)} SET ${grants.columns.endedAt} = $1 WHERE ${grants.columns.id} = $2`,
						[endedAt, grantId],
					),
				),
		);
		const atExpiry = await ending(controller, expired, expiry);

		assert.deepEqual(
			refused,
			refused.map(() => POLICY_CONSTRAINTS.grantEndedAfterExpiry),
		);
		assert.equal(await endedAtOf(owner, openEnded), null);
		assert.equal(atExpiry, 'accepted');
		assert.equal((await endedAtOf(owner, expired))?.getTime(), expiry.getTime());
	});

	test("keeps an ended grant's end, expiry and role as written, and still lets it be revoked", async (context) => {
		const { database, owner, seeded } = await openSeededDatabase(context, BASE_FIXTURE);
		const controller = await database.connect('runtime');
		const now = Date.now();
		const grantId = await insertedId(owner, cyViewing(seeded, { expiresAt: new Date(now - HOUR_MS) }));
		assert.equal(await ending(controller, grantId, new Date(now)), 'accepted');
		const rewrites: readonly (readonly [string, unknown])[] = [
			[grants.columns.endedAt, new Date(now + HOUR_MS)],
			[grants.columns.endedAt, null],
			[grants.columns.expiresAt, new Date(now + HOUR_MS)],
			[grants.columns.roleId, seededId(seeded.roles, 'submitter')],
		];

		const refused = await inTurn(
			[owner, controller].flatMap((client) => rewrites.map(([column, value]) => ({ client, column, value }))),
			({ client, column, value }) =>
				constraintOf(
					committedQuery(
						client,
						`UPDATE ${qualified(grants)} SET ${column} = $1 WHERE ${grants.columns.id} = $2`,
						[value, grantId],
					),
				),
		);
		const revoked = await writeOutcome(
			committedQuery(
				controller,
				`UPDATE ${qualified(grants)} SET ${grants.columns.revokedAt} = now(), ${grants.columns.revokedBy} = $1 WHERE ${grants.columns.id} = $2`,
				[stewardOf(seeded), grantId],
			),
		);

		assert.deepEqual(
			refused,
			refused.map(() => POLICY_CONSTRAINTS.grantEndKept),
		);
		assert.equal(revoked, 'accepted');
		assert.equal((await endedAtOf(owner, grantId))?.getTime(), now);
	});

	test('holds a grant on the same terms beside an ended one, and refuses one beside an expired grant not yet ended', async (context) => {
		const { database, owner, seeded } = await openSeededDatabase(context, BASE_FIXTURE);
		const controller = await database.connect('runtime');
		const now = Date.now();
		const expired = await insertedId(owner, cyViewing(seeded, { expiresAt: new Date(now - HOUR_MS) }));

		const beforeEnding = await writeOutcome(committedInsert(controller, grants, cyViewing(seeded)));
		await ending(controller, expired, new Date(now));
		const afterEnding = await writeOutcome(committedInsert(controller, grants, cyViewing(seeded)));
		const again = await constraintOf(committedInsert(controller, grants, cyViewing(seeded)));

		assert.equal(beforeEnding, INTEGRITY.unique);
		assert.equal(afterEnding, 'accepted');
		assert.equal(again, POLICY_CONSTRAINTS.liveGrant);
	});

	test("lets the controller's role write a grant's end and no other column it was refused before", async (context) => {
		const { database, owner, seeded } = await openSeededDatabase(context, BASE_FIXTURE);
		const controller = await database.connect('runtime');
		const grantId = await insertedId(owner, cyViewing(seeded, { expiresAt: new Date(Date.now() - HOUR_MS) }));

		const granted = await ending(controller, grantId, new Date());
		const grantedAt = await writeOutcome(
			committedQuery(
				controller,
				`UPDATE ${qualified(grants)} SET ${grants.columns.grantedAt} = now() WHERE ${grants.columns.id} = $1`,
				[grantId],
			),
		);

		assert.equal(granted, 'accepted');
		assert.equal(grantedAt, INSUFFICIENT_PRIVILEGE);
	});
});
