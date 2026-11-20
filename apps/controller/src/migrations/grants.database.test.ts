import assert from 'node:assert/strict';
import { suite, test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import type pg from 'pg';

import { untilBlocked } from '../../testing/harness/database.js';
import {
	BASE_FIXTURE,
	committedInsert,
	committedQuery,
	type GrantParts,
	grantRow,
	insertRow,
	INSUFFICIENT_PRIVILEGE,
	INTEGRITY,
	markStore,
	openSeededDatabase,
	readPolicyGeneration,
	refusedByStore,
	type Row,
	run,
	selectRows,
	type Statement,
	stewardOf,
	SUBJECTS,
	violation,
	writeOutcome,
	writtenSince,
} from '../../testing/fixtures/database.js';
import {
	type Actor,
	addAcceptedOwner,
	declareActor,
	type FixtureDecision,
	type FixtureGrant,
	type FixtureResource,
	inTransactionAs,
	inTurn,
	OWNER_ROLE,
	POLICY_CONSTRAINTS,
	type PolicyFixture,
	POLICY_TABLES,
	qualified,
	seededId,
	type SeededPolicy,
	STEWARD_SUBJECT,
	SYSTEM_ACTOR,
} from '../../testing/harness/policy.js';

const { grantDecisions, grants, resources } = POLICY_TABLES;

const BO_ACTING: Actor = Object.freeze({ id: SUBJECTS.bo, type: 'human' });

const WITH_GROUP_AND_REVOCATION: PolicyFixture = {
	...BASE_FIXTURE,
	grants: {
		...BASE_FIXTURE.grants,
		cyViewed: {
			category: 'unmarked',
			holder: { user: 'cy' },
			resource: 'STUDY-B2',
			revoked: { at: new Date('2026-09-15T12:00:00Z'), by: 'bo' },
			role: 'viewer',
		},
	},
	groups: { readers: { members: ['cy'], resource: 'STUDY-A1' } },
};

const grantById = async (client: pg.ClientBase, grantId: string): Promise<Row | undefined> =>
	(await selectRows<Row>(client, `SELECT * FROM ${qualified(grants)} WHERE ${grants.columns.id} = $1`, [grantId]))[0];

const liveGrantsMatching = async (
	client: pg.ClientBase,
	{ holderUserId, recordCategoryId, resourceId, roleId }: Omit<GrantParts, 'grantedBy'>,
): Promise<number> => {
	const [row] = await selectRows<{ count: number }>(
		client,
		`SELECT count(*)::int AS count FROM ${qualified(grants)}
      WHERE ${grants.columns.holderUserId} IS NOT DISTINCT FROM $1 AND ${grants.columns.recordCategoryId} IS NOT DISTINCT FROM $2
        AND ${grants.columns.resourceId} = $3 AND ${grants.columns.roleId} = $4 AND ${grants.columns.revokedAt} IS NULL`,
		[holderUserId ?? null, recordCategoryId ?? null, resourceId, roleId],
	);
	return row?.count ?? 0;
};

const grantParts = (seeded: SeededPolicy, holder: string, category: string | null, role: string): GrantParts => ({
	grantedBy: stewardOf(seeded),
	holderUserId: seededId(seeded.users, holder),
	...(category === null ? {} : { recordCategoryId: seededId(seeded.categories, category) }),
	resourceId: seededId(seeded.resources, 'STUDY-A1'),
	roleId: seededId(seeded.roles, role),
});

suite('grants', () => {
	test('names exactly one holder on every grant', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context, WITH_GROUP_AND_REVOCATION);
		const onStudyA1 = {
			grantedBy: stewardOf(seeded),
			recordCategoryId: seededId(seeded.categories, 'unmarked'),
			resourceId: seededId(seeded.resources, 'STUDY-A1'),
			roleId: seededId(seeded.roles, 'viewer'),
		};
		const group = seededId(seeded.groups, 'readers');
		const ana = seededId(seeded.users, 'ana');

		const outcomes = await inTurn(
			[
				grantRow(onStudyA1),
				grantRow({ ...onStudyA1, holderGroupId: group, holderUserId: ana }),
				grantRow({ ...onStudyA1, holderUserId: ana }),
				grantRow({ ...onStudyA1, holderGroupId: group }),
			],
			(row) => writeOutcome(committedInsert(owner, grants, row)),
		);

		assert.deepEqual(outcomes, [INTEGRITY.check, INTEGRITY.check, 'accepted', 'accepted']);
	});

	test('records who revoked a grant whenever it records when', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context);
		const steward = stewardOf(seeded);
		const base = (holder: string): Row => grantRow(grantParts(seeded, holder, 'unmarked', 'viewer'));

		const outcomes = await inTurn(
			[
				{ ...base('ana'), [grants.columns.revokedAt]: new Date() },
				{ ...base('bo'), [grants.columns.revokedBy]: steward },
				{
					...base('cy'),
					[grants.columns.revokedAt]: new Date(),
					[grants.columns.revokedBy]: steward,
				},
			],
			(row) => writeOutcome(committedInsert(owner, grants, row)),
		);

		assert.deepEqual(outcomes, [INTEGRITY.check, INTEGRITY.check, 'accepted']);
	});

	test('scopes a field category only beneath a record category', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context);
		const field = seededId(seeded.categories, 'controlled');
		const record = seededId(seeded.categories, 'unmarked');
		const parts = (holder: string): GrantParts => grantParts(seeded, holder, null, 'viewer');

		const outcomes = await inTurn(
			[
				grantRow({ ...parts('ana'), fieldCategoryId: field }),
				grantRow({ ...parts('bo'), recordCategoryId: record }),
				grantRow({
					...parts('cy'),
					fieldCategoryId: field,
					recordCategoryId: record,
				}),
			],
			(row) => writeOutcome(committedInsert(owner, grants, row)),
		);

		assert.deepEqual(outcomes, [INTEGRITY.check, 'accepted', 'accepted']);
	});

	test("holds an owner's grant on a whole resource as a null record category", async (context) => {
		const { owner, seeded } = await openSeededDatabase(context);

		const stored = await committedInsert(owner, grants, grantRow(grantParts(seeded, 'cy', null, 'owner')));

		assert.equal(stored[grants.columns.recordCategoryId], null);
		assert.equal(stored[grants.columns.fieldCategoryId], null);
	});

	test("keeps a grant's revocation once recorded", async (context) => {
		const { database, owner, seeded } = await openSeededDatabase(context, WITH_GROUP_AND_REVOCATION);
		const revokedGrant = seededId(seeded.grants, 'cyViewed');
		const before = await grantById(owner, revokedGrant);
		const controller = await database.connect('runtime');
		const rewrites = [
			{
				parameters: [revokedGrant],
				text: `UPDATE ${qualified(grants)} SET ${grants.columns.revokedAt} = NULL, ${grants.columns.revokedBy} = NULL WHERE ${grants.columns.id} = $1`,
			},
			{
				parameters: [new Date('2026-10-01T12:00:00Z'), revokedGrant],
				text: `UPDATE ${qualified(grants)} SET ${grants.columns.revokedAt} = $1 WHERE ${grants.columns.id} = $2`,
			},
			{
				parameters: [seededId(seeded.users, 'ana'), revokedGrant],
				text: `UPDATE ${qualified(grants)} SET ${grants.columns.revokedBy} = $1 WHERE ${grants.columns.id} = $2`,
			},
		];
		const attempts = [owner, controller].flatMap((client) => rewrites.map((rewrite) => ({ client, rewrite })));

		const outcomes = await inTurn(attempts, ({ client, rewrite }) =>
			refusedByStore(committedQuery(client, rewrite.text, rewrite.parameters, BO_ACTING)),
		);

		assert.deepEqual(
			outcomes,
			attempts.map(() => true),
		);
		assert.deepEqual(await grantById(owner, revokedGrant), before);
	});

	test('keeps what a grant names once written', async (context) => {
		const { database, owner, seeded } = await openSeededDatabase(context, WITH_GROUP_AND_REVOCATION);
		const grant = seededId(seeded.grants, 'anaViews');
		const controller = await database.connect('runtime');
		const before = await grantById(owner, grant);
		const named = [
			[grants.columns.fieldCategoryId, seededId(seeded.categories, 'unmarked')],
			[grants.columns.grantedAt, new Date('2026-01-01T00:00:00Z')],
			[grants.columns.grantedBy, seededId(seeded.users, 'cy')],
			[grants.columns.holderGroupId, seededId(seeded.groups, 'readers')],
			[grants.columns.holderUserId, seededId(seeded.users, 'cy')],
			[grants.columns.id, '00000000-0000-4000-8000-000000000001'],
			[grants.columns.recordCategoryId, seededId(seeded.categories, 'unmarked')],
			[grants.columns.resourceId, seededId(seeded.resources, 'STUDY-B2')],
		] as const;

		const outcomes = await inTurn(named, ([column, value]) =>
			writeOutcome(
				committedQuery(
					controller,
					`UPDATE ${qualified(grants)} SET ${column} = $1 WHERE ${grants.columns.id} = $2`,
					[value, grant],
					BO_ACTING,
				),
			),
		);
		const unchanged = await grantById(owner, grant);
		const changes = await inTurn(
			[
				[grants.columns.roleId, seededId(seeded.roles, 'submitter')],
				[grants.columns.expiresAt, new Date('2027-06-30T00:00:00Z')],
			] as const,
			([column, value]) =>
				writeOutcome(
					committedQuery(
						controller,
						`UPDATE ${qualified(grants)} SET ${column} = $1 WHERE ${grants.columns.id} = $2`,
						[value, grant],
						BO_ACTING,
					),
				),
		);
		const revocation = await writeOutcome(
			committedQuery(
				controller,
				`UPDATE ${qualified(grants)} SET ${grants.columns.revokedAt} = now(), ${grants.columns.revokedBy} = $1 WHERE ${grants.columns.id} = $2`,
				[seededId(seeded.users, 'bo'), grant],
				BO_ACTING,
			),
		);

		assert.deepEqual(
			outcomes,
			named.map(() => INSUFFICIENT_PRIVILEGE),
		);
		assert.deepEqual(unchanged, before);
		assert.deepEqual([...changes, revocation], ['accepted', 'accepted', 'accepted']);
		const after = await grantById(owner, grant);
		assert.equal(after?.[grants.columns.roleId], seededId(seeded.roles, 'submitter'));
		assert.notEqual(after?.[grants.columns.revokedAt], null);
	});

	test('holds at most one live grant per holder, resource, category and role', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context);
		const anaViewing = grantParts(seeded, 'ana', 'controlled', 'viewer');
		const boOwning = grantParts(seeded, 'bo', null, 'owner');

		await assert.rejects(
			committedInsert(owner, grants, grantRow(anaViewing)),
			violation(INTEGRITY.unique, POLICY_CONSTRAINTS.liveGrant),
		);
		await assert.rejects(
			committedInsert(owner, grants, grantRow(boOwning)),
			violation(INTEGRITY.unique, POLICY_CONSTRAINTS.liveGrant),
		);
		await committedInsert(owner, grants, grantRow(grantParts(seeded, 'ana', 'controlled', 'submitter')));
		await committedInsert(owner, grants, grantRow(grantParts(seeded, 'ana', 'unmarked', 'viewer')));
		await committedQuery(
			owner,
			`UPDATE ${qualified(grants)} SET ${grants.columns.revokedAt} = now(), ${grants.columns.revokedBy} = $1 WHERE ${grants.columns.id} = $2`,
			[stewardOf(seeded), seededId(seeded.grants, 'anaViews')],
		);
		await committedInsert(owner, grants, grantRow(anaViewing));

		assert.equal(await liveGrantsMatching(owner, anaViewing), 1);
		assert.equal(await liveGrantsMatching(owner, boOwning), 1);
	});

	test('holds one live grant when two creations of it race', async (context) => {
		const { database, owner, seeded } = await openSeededDatabase(context);
		const cyViewing = grantParts(seeded, 'cy', 'controlled', 'viewer');
		const first = await database.connect('migration');
		const second = await database.connect('migration');

		await first.query('BEGIN');
		await declareActor(first, SYSTEM_ACTOR);
		await insertRow(first, grants, grantRow(cyViewing));
		await second.query('BEGIN');
		await declareActor(second, SYSTEM_ACTOR);
		const racing = writeOutcome(insertRow(second, grants, grantRow(cyViewing)));
		await untilBlocked(owner, racing);
		await first.query('COMMIT');
		const raced = await racing;
		await second.query('ROLLBACK');

		assert.equal(raced, INTEGRITY.unique);
		assert.equal(await liveGrantsMatching(owner, cyViewing), 1);
	});
});

const OWNER_ANSWERED_AT = new Date('2026-09-01T12:00:00Z');

/** An owner grant on one resource, as the owner-guard tests write it. */
interface OwnerGrant {
	/** Its holder's answers in order, the last deciding: one acceptance by default, none while pending. */
	answers?: readonly ('accepted' | 'rejected')[];

	holder: string;

	/** Whether it was revoked before now. */
	revoked?: boolean;
}

const ownerGrantName = (externalId: string, holder: string): string => `${externalId}:${holder}`;

/**
 * The base fixture with resources of the tests' own, each holding the owner grants given and
 * nothing else. An owner grant takes no expiry.
 */
const withOwners = (owned: Readonly<Record<string, readonly OwnerGrant[]>>): PolicyFixture => {
	const entries = Object.entries(owned);
	return {
		...BASE_FIXTURE,
		decisions: [
			...(BASE_FIXTURE.decisions ?? []),
			...entries.flatMap(([externalId, ownerGrants]) =>
				ownerGrants.flatMap(({ answers = ['accepted'], holder }) =>
					answers.map((decision, index): FixtureDecision => ({
						decidedAt: new Date(OWNER_ANSWERED_AT.getTime() + index * 60_000),
						decision,
						grant: ownerGrantName(externalId, holder),
					})),
				),
			),
		],
		grants: {
			...BASE_FIXTURE.grants,
			...Object.fromEntries(
				entries.flatMap(([externalId, ownerGrants]) =>
					ownerGrants.map(({ holder, revoked = false }): [string, FixtureGrant] => [
						ownerGrantName(externalId, holder),
						{
							category: null,
							holder: { user: holder },
							resource: externalId,
							...(revoked ? { revoked: { at: new Date('2026-09-15T12:00:00Z') } } : {}),
							role: OWNER_ROLE,
						},
					]),
				),
			),
		},
		resources: {
			...BASE_FIXTURE.resources,
			...Object.fromEntries(
				entries.map(([externalId]): [string, FixtureResource] => [
					externalId,
					{ baseTier: 'grant', name: `Study ${externalId}` },
				]),
			),
		},
	};
};

const revocationOf = (grantId: string, revokedBy: string): Statement => ({
	parameters: [revokedBy, grantId],
	text: `UPDATE ${qualified(grants)} SET ${grants.columns.revokedAt} = now(), ${grants.columns.revokedBy} = $1 WHERE ${grants.columns.id} = $2`,
});

const retirementOf = (externalId: string, retiredBy: string): Statement => ({
	parameters: [retiredBy, externalId],
	text: `UPDATE ${qualified(resources)} SET ${resources.columns.retiredAt} = now(), ${resources.columns.retiredBy} = $1 WHERE ${resources.columns.externalId} = $2`,
});

const declining = (grantId: string, userId: string): Statement => ({
	parameters: [grantId, userId],
	text: `INSERT INTO ${qualified(grantDecisions)} (${grantDecisions.columns.capabilities}, ${grantDecisions.columns.decidedAt}, ${grantDecisions.columns.decision}, ${grantDecisions.columns.grantId}, ${grantDecisions.columns.userId}) VALUES ('{grant.create,grant.revoke,resource.view}', now(), 'rejected', $1, $2)`,
});

const committedOutcome = (
	client: pg.ClientBase,
	statements: readonly Statement[],
	actor: Actor = SYSTEM_ACTOR,
): Promise<string> =>
	writeOutcome(inTransactionAs(client, actor, () => inTurn(statements, (statement) => run(client, statement))));

const storeState = async (client: pg.ClientBase): Promise<Readonly<Record<string, unknown>>> => ({
	decisions: await selectRows(
		client,
		`SELECT * FROM ${qualified(grantDecisions)} ORDER BY ${grantDecisions.columns.id}`,
	),
	generation: await readPolicyGeneration(client),
	grants: await selectRows(client, `SELECT * FROM ${qualified(grants)} ORDER BY ${grants.columns.id}`),
	resources: await selectRows(client, `SELECT * FROM ${qualified(resources)} ORDER BY ${resources.columns.id}`),
});

/** What an attempt came to: refused or not, and whether the store changed at all. */
interface Refusal {
	changed: boolean;
	refused: boolean;
}

const REFUSED_UNCHANGED: Refusal = Object.freeze({
	changed: false,
	refused: true,
});

const observedAttempt = async (observer: pg.ClientBase, attempt: () => Promise<unknown>): Promise<Refusal> => {
	const marker = await markStore(observer);
	const before = await storeState(observer);
	const refused = await refusedByStore(attempt());
	const written = await writtenSince(observer, marker);
	return {
		changed:
			!isDeepStrictEqual(await storeState(observer), before) ||
			written.changeRecords.length > 0 ||
			written.notices.length > 0,
		refused,
	};
};

const attemptedAs = (
	client: pg.ClientBase,
	statements: readonly Statement[],
	actor: Actor = SYSTEM_ACTOR,
): Promise<unknown> => inTransactionAs(client, actor, () => inTurn(statements, (statement) => run(client, statement)));

const isLive = async (client: pg.ClientBase, grantId: string): Promise<boolean> =>
	(
		await selectRows<{ live: boolean }>(
			client,
			`SELECT ${grants.columns.revokedAt} IS NULL AS live FROM ${qualified(grants)} WHERE ${grants.columns.id} = $1`,
			[grantId],
		)
	)[0]?.live === true;

const isRetired = async (client: pg.ClientBase, externalId: string): Promise<boolean> =>
	(
		await selectRows<{ retired: boolean }>(
			client,
			`SELECT ${resources.columns.retiredAt} IS NOT NULL AS retired FROM ${qualified(resources)} WHERE ${resources.columns.externalId} = $1`,
			[externalId],
		)
	)[0]?.retired === true;

suite('the owners a resource keeps', () => {
	test('refuses revoking the only owner grant of a resource, changing nothing', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context, withOwners({ 'OWNED-ONE': [{ holder: 'bo' }] }));
		const steward = stewardOf(seeded);
		const boOwning = seededId(seeded.grants, ownerGrantName('OWNED-ONE', 'bo'));
		const revoking = revocationOf(boOwning, steward);

		const alone = await observedAttempt(owner, () => attemptedAs(owner, [revoking]));
		await addAcceptedOwner(owner, {
			grantedBy: steward,
			holderUserId: seededId(seeded.users, 'cy'),
			resourceId: seededId(seeded.resources, 'OWNED-ONE'),
		});
		const beside = await committedOutcome(owner, [revoking]);

		assert.deepEqual(alone, REFUSED_UNCHANGED);
		assert.equal(beside, 'accepted');
	});

	test('lets one of two owner grants be revoked, and keeps the other as the last', async (context) => {
		const { owner, seeded } = await openSeededDatabase(
			context,
			withOwners({ 'OWNED-TWO': [{ holder: 'bo' }, { holder: 'cy' }] }),
		);
		const steward = stewardOf(seeded);
		const boOwning = seededId(seeded.grants, ownerGrantName('OWNED-TWO', 'bo'));
		const cyOwning = seededId(seeded.grants, ownerGrantName('OWNED-TWO', 'cy'));

		const first = await committedOutcome(owner, [revocationOf(boOwning, steward)]);
		const last = await observedAttempt(owner, () => attemptedAs(owner, [revocationOf(cyOwning, steward)]));

		assert.equal(first, 'accepted');
		assert.deepEqual(last, REFUSED_UNCHANGED);
		assert.deepEqual([await isLive(owner, boOwning), await isLive(owner, cyOwning)], [false, true]);
	});

	test('lets the last owner grant be revoked in the transaction that retires its resource, both changes standing', async (context) => {
		const { owner, seeded } = await openSeededDatabase(
			context,
			withOwners({ 'OWNED-RETIRING': [{ holder: 'bo' }] }),
		);
		const steward = stewardOf(seeded);
		const boOwning = seededId(seeded.grants, ownerGrantName('OWNED-RETIRING', 'bo'));

		const outcome = await committedOutcome(owner, [
			retirementOf('OWNED-RETIRING', steward),
			revocationOf(boOwning, steward),
		]);

		assert.equal(outcome, 'accepted');
		assert.deepEqual([await isRetired(owner, 'OWNED-RETIRING'), await isLive(owner, boOwning)], [true, false]);
	});

	test('refuses retiring a resource that still holds a live grant, owner or not, changing nothing', async (context) => {
		const { owner, seeded } = await openSeededDatabase(
			context,
			withOwners({ 'OWNED-KEPT': [{ holder: 'bo' }], 'VIEWED-KEPT': [] }),
		);
		const steward = stewardOf(seeded);
		const boOwning = seededId(seeded.grants, ownerGrantName('OWNED-KEPT', 'bo'));
		const anaViewing = String(
			(
				await committedInsert(
					owner,
					grants,
					grantRow({
						grantedBy: steward,
						holderUserId: seededId(seeded.users, 'ana'),
						recordCategoryId: seededId(seeded.categories, 'unmarked'),
						resourceId: seededId(seeded.resources, 'VIEWED-KEPT'),
						roleId: seededId(seeded.roles, 'viewer'),
					}),
				)
			)[grants.columns.id],
		);

		const keepingTheOwner = await observedAttempt(owner, () =>
			attemptedAs(owner, [retirementOf('OWNED-KEPT', steward)]),
		);
		const keepingTheViewer = await observedAttempt(owner, () =>
			attemptedAs(owner, [retirementOf('VIEWED-KEPT', steward)]),
		);
		const endingEach = [
			await committedOutcome(owner, [retirementOf('OWNED-KEPT', steward), revocationOf(boOwning, steward)]),
			await committedOutcome(owner, [retirementOf('VIEWED-KEPT', steward), revocationOf(anaViewing, steward)]),
		];

		assert.deepEqual(keepingTheOwner, REFUSED_UNCHANGED);
		assert.deepEqual(keepingTheViewer, REFUSED_UNCHANGED);
		assert.deepEqual(endingEach, ['accepted', 'accepted']);
		assert.deepEqual([await isRetired(owner, 'OWNED-KEPT'), await isRetired(owner, 'VIEWED-KEPT')], [true, true]);
	});

	test('counts only an accepted, unrevoked owner grant as an owner', async (context) => {
		const secondOwners: Readonly<Record<string, OwnerGrant>> = {
			'OWNED-ACCEPTED': { holder: 'cy' },
			'OWNED-PENDING': { answers: [], holder: 'cy' },
			'OWNED-RECONSIDERED': { answers: ['rejected', 'accepted'], holder: 'cy' },
			'OWNED-REJECTED': { answers: ['rejected'], holder: 'cy' },
			'OWNED-REVOKED': { holder: 'cy', revoked: true },
			'OWNED-WITHDRAWN': { answers: ['accepted', 'rejected'], holder: 'cy' },
		};
		const { owner, seeded } = await openSeededDatabase(
			context,
			withOwners(
				Object.fromEntries(
					Object.entries(secondOwners).map(([externalId, second]) => [
						externalId,
						[{ holder: 'bo' }, second],
					]),
				),
			),
		);
		const steward = stewardOf(seeded);

		const outcomes = await inTurn(Object.keys(secondOwners), async (externalId) => ({
			externalId,
			...(await observedAttempt(owner, () =>
				attemptedAs(owner, [revocationOf(seededId(seeded.grants, ownerGrantName(externalId, 'bo')), steward)]),
			)),
		}));

		const counted = { changed: true, refused: false };
		assert.deepEqual(outcomes, [
			{ externalId: 'OWNED-ACCEPTED', ...counted },
			{ externalId: 'OWNED-PENDING', ...REFUSED_UNCHANGED },
			{ externalId: 'OWNED-RECONSIDERED', ...counted },
			{ externalId: 'OWNED-REJECTED', ...REFUSED_UNCHANGED },
			{ externalId: 'OWNED-REVOKED', ...REFUSED_UNCHANGED },
			{ externalId: 'OWNED-WITHDRAWN', ...REFUSED_UNCHANGED },
		]);
	});

	test("holds the owner guard for the migration role, a manual fix as the schema's owner, and the controller's runtime role", async (context) => {
		const { database, owner, seeded } = await openSeededDatabase(
			context,
			withOwners({
				'OWNED-BY-FIX': [{ holder: 'bo' }],
				'OWNED-BY-MIGRATION': [{ holder: 'bo' }],
				'OWNED-BY-RUNTIME': [{ holder: 'bo' }],
			}),
		);
		const steward = stewardOf(seeded);
		const operator: Actor = { id: STEWARD_SUBJECT, type: 'human' };
		const controller = await database.connect('runtime');
		const writers: readonly {
			actor: Actor;
			client: pg.ClientBase;
			externalId: string;
		}[] = [
			{ actor: SYSTEM_ACTOR, client: owner, externalId: 'OWNED-BY-MIGRATION' },
			{ actor: operator, client: owner, externalId: 'OWNED-BY-FIX' },
			{ actor: operator, client: controller, externalId: 'OWNED-BY-RUNTIME' },
		];
		const revokingFor = (externalId: string): Statement =>
			revocationOf(seededId(seeded.grants, ownerGrantName(externalId, 'bo')), steward);

		const alone = await inTurn(writers, ({ actor, client, externalId }) =>
			observedAttempt(owner, () => attemptedAs(client, [revokingFor(externalId)], actor)),
		);
		await inTurn(writers, ({ externalId }) =>
			addAcceptedOwner(owner, {
				grantedBy: steward,
				holderUserId: seededId(seeded.users, 'cy'),
				resourceId: seededId(seeded.resources, externalId),
			}),
		);
		const beside = await inTurn(writers, ({ actor, client, externalId }) =>
			committedOutcome(client, [revokingFor(externalId)], actor),
		);

		assert.deepEqual(
			alone,
			writers.map(() => REFUSED_UNCHANGED),
		);
		assert.deepEqual(
			beside,
			writers.map(() => 'accepted'),
		);
	});

	test('leaves a resource that never had an owner unaffected', async (context) => {
		const { owner, seeded } = await openSeededDatabase(
			context,
			withOwners({ 'NEVER-OWNED': [{ answers: [], holder: 'cy' }] }),
		);
		const steward = stewardOf(seeded);
		const viewing = await committedInsert(
			owner,
			grants,
			grantRow({
				grantedBy: steward,
				holderUserId: seededId(seeded.users, 'ana'),
				recordCategoryId: seededId(seeded.categories, 'unmarked'),
				resourceId: seededId(seeded.resources, 'NEVER-OWNED'),
				roleId: seededId(seeded.roles, 'viewer'),
			}),
		);

		const outcomes = [
			await committedOutcome(owner, [
				revocationOf(seededId(seeded.grants, ownerGrantName('NEVER-OWNED', 'cy')), steward),
			]),
			await committedOutcome(owner, [revocationOf(String(viewing[grants.columns.id]), steward)]),
			await committedOutcome(owner, [retirementOf('NEVER-OWNED', steward)]),
			await committedOutcome(owner, [retirementOf('study.c_3', steward)]),
		];

		assert.deepEqual(outcomes, ['accepted', 'accepted', 'accepted', 'accepted']);
	});

	test('keeps the last owner grant from losing its role', async (context) => {
		const { owner, seeded } = await openSeededDatabase(
			context,
			withOwners({
				'OWNED-ALONE': [{ holder: 'bo' }],
				'OWNED-SHARED': [{ holder: 'bo' }, { holder: 'cy' }],
			}),
		);
		const demoting = (externalId: string): Statement => ({
			parameters: [seededId(seeded.roles, 'viewer'), seededId(seeded.grants, ownerGrantName(externalId, 'bo'))],
			text: `UPDATE ${qualified(grants)} SET ${grants.columns.roleId} = $1 WHERE ${grants.columns.id} = $2`,
		});

		const alone = await observedAttempt(owner, () => attemptedAs(owner, [demoting('OWNED-ALONE')]));
		const beside = await committedOutcome(owner, [demoting('OWNED-SHARED')]);

		assert.deepEqual(alone, REFUSED_UNCHANGED);
		assert.equal(beside, 'accepted');
	});

	test('keeps the last owner from declining their own accepted grant, changing nothing', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context, withOwners({ 'OWNED-ONE': [{ holder: 'bo' }] }));
		const steward = stewardOf(seeded);
		const bo = seededId(seeded.users, 'bo');
		const decliningOwnership = declining(seededId(seeded.grants, ownerGrantName('OWNED-ONE', 'bo')), bo);
		const boActing: Actor = { id: SUBJECTS.bo, type: 'human' };

		const alone = await observedAttempt(owner, () => attemptedAs(owner, [decliningOwnership], boActing));
		await addAcceptedOwner(owner, {
			grantedBy: steward,
			holderUserId: seededId(seeded.users, 'cy'),
			resourceId: seededId(seeded.resources, 'OWNED-ONE'),
		});
		const beside = await committedOutcome(owner, [decliningOwnership], boActing);

		assert.deepEqual(alone, REFUSED_UNCHANGED);
		assert.equal(beside, 'accepted');
	});

	test('refuses an expiry on an owner grant, written with one or given one later', async (context) => {
		const { owner, seeded } = await openSeededDatabase(
			context,
			withOwners({ 'OWNED-TWO': [{ holder: 'bo' }, { holder: 'cy' }] }),
		);
		const steward = stewardOf(seeded);
		const expiresAt = new Date('2027-06-30T00:00:00Z');
		const grantOn = (role: string, holder: string): Row =>
			grantRow({
				expiresAt,
				grantedBy: steward,
				holderUserId: seededId(seeded.users, holder),
				resourceId: seededId(seeded.resources, 'OWNED-TWO'),
				roleId: seededId(seeded.roles, role),
				...(role === OWNER_ROLE ? {} : { recordCategoryId: seededId(seeded.categories, 'unmarked') }),
			});
		const expiring = (grantId: string): Statement => ({
			parameters: [expiresAt, grantId],
			text: `UPDATE ${qualified(grants)} SET ${grants.columns.expiresAt} = $1 WHERE ${grants.columns.id} = $2`,
		});
		const viewing = String(
			(
				await committedInsert(
					owner,
					grants,
					grantRow({
						grantedBy: steward,
						holderUserId: seededId(seeded.users, 'cy'),
						recordCategoryId: seededId(seeded.categories, 'controlled'),
						resourceId: seededId(seeded.resources, 'OWNED-TWO'),
						roleId: seededId(seeded.roles, 'viewer'),
					}),
				)
			)[grants.columns.id],
		);

		const refused = [
			await observedAttempt(owner, () =>
				inTransactionAs(owner, SYSTEM_ACTOR, () => insertRow(owner, grants, grantOn(OWNER_ROLE, 'ana'))),
			),
			await observedAttempt(owner, () =>
				attemptedAs(owner, [expiring(seededId(seeded.grants, ownerGrantName('OWNED-TWO', 'bo')))]),
			),
		];
		const accepted = [
			await writeOutcome(committedInsert(owner, grants, grantOn('viewer', 'ana'))),
			await committedOutcome(owner, [expiring(viewing)]),
		];

		assert.deepEqual(refused, [REFUSED_UNCHANGED, REFUSED_UNCHANGED]);
		assert.deepEqual(accepted, ['accepted', 'accepted']);
	});
});
