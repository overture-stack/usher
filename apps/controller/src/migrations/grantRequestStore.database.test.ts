import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type pg from 'pg';

import { GRANT_BEYOND_USE_LOG_LINE, jsonObjectOf } from '../../testing/harness/auditEvents.js';
import { captureLog } from '../../testing/harness/controller.js';
import {
	BASE_FIXTURE,
	committedChange,
	committedInsert,
	committedQuery,
	grantRow,
	INSUFFICIENT_PRIVILEGE,
	openSeededDatabase,
	type Row,
	selectRows,
	stewardOf,
	writeOutcome,
} from '../../testing/fixtures/database.js';
import { withHarness } from '../../testing/harness/harness.js';
import {
	GRANT_REQUEST_NOTIFICATION,
	inTurn,
	ORPHANED_RESOURCE_REQUEST,
	POLICY_CONSTRAINTS,
	POLICY_TABLES,
	qualified,
	seededId,
	type SeededPolicy,
	SELF_GRANT_NOTIFICATION,
	SELF_GRANT_REQUEST,
} from '../../testing/harness/policy.js';

const { grantRequests, grants, notificationOutbox } = POLICY_TABLES;

const HOUR_MS = 3_600_000;

// Cy's request for Cy's own viewer grant on STUDY-A1 under `controlled`, ending in a day.
const cyAsking = (seeded: SeededPolicy, over: Row = {}): Row => ({
	[grantRequests.columns.capabilities]: ['record.count', 'record.export', 'record.view'],
	[grantRequests.columns.expiresAt]: new Date(Date.now() + 24 * HOUR_MS),
	[grantRequests.columns.holderUserId]: seededId(seeded.users, 'cy'),
	[grantRequests.columns.kind]: SELF_GRANT_REQUEST,
	[grantRequests.columns.recordCategoryId]: seededId(seeded.categories, 'controlled'),
	[grantRequests.columns.requestedAt]: new Date(),
	[grantRequests.columns.requestedBy]: seededId(seeded.users, 'cy'),
	[grantRequests.columns.resourceId]: seededId(seeded.resources, 'STUDY-A1'),
	[grantRequests.columns.roleId]: seededId(seeded.roles, 'viewer'),
	...over,
});

// The grant written by granting Cy's request: granted by Bo, asked for by Cy.
const cyGranted = (seeded: SeededPolicy): Row => ({
	...grantRow({
		grantedBy: seededId(seeded.users, 'bo'),
		holderUserId: seededId(seeded.users, 'cy'),
		recordCategoryId: seededId(seeded.categories, 'controlled'),
		resourceId: seededId(seeded.resources, 'STUDY-A1'),
		roleId: seededId(seeded.roles, 'viewer'),
	}),
	[grants.columns.requestedBy]: seededId(seeded.users, 'cy'),
});

const insertedId = async (
	client: pg.ClientBase,
	table: { columns: { id: string }; name: string },
	row: Row,
): Promise<string> => String((await committedInsert(client, table, row))[table.columns.id]);

// The constraint a refused write names, or `accepted`.
const constraintOf = (attempt: Promise<unknown>): Promise<unknown> =>
	attempt.then(
		() => 'accepted',
		(error: unknown) =>
			typeof error === 'object' && error !== null ? Reflect.get(error, 'constraint') : undefined,
	);

const requestById = async (client: pg.ClientBase, requestId: string): Promise<Row | undefined> =>
	(
		await selectRows<Row>(
			client,
			`SELECT * FROM ${qualified(grantRequests)} WHERE ${grantRequests.columns.id} = $1`,
			[requestId],
		)
	)[0];

// A decision's columns, as an update sets them.
const decided = (decision: string | null, decidedBy: string | null, grantId: string | null = null): Row => ({
	[grantRequests.columns.decidedAt]: decision === null ? null : new Date(),
	[grantRequests.columns.decidedBy]: decidedBy,
	[grantRequests.columns.decision]: decision,
	[grantRequests.columns.grantId]: grantId,
});

const updating = (client: pg.ClientBase, requestId: string, values: Row): Promise<unknown> => {
	const entries = Object.entries(values);
	return committedQuery(
		client,
		`UPDATE ${qualified(grantRequests)}
        SET ${entries.map(([column], index) => `${column} = $${index + 2}`).join(', ')}
      WHERE ${grantRequests.columns.id} = $1`,
		[requestId, ...entries.map(([, value]) => value)],
	);
};

suite('grant requests in the store', () => {
	test('holds a request of a kind the store knows, a self-grant held by the principal who asked for it alone', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context, BASE_FIXTURE);

		const refused = await inTurn(
			[
				cyAsking(seeded, { [grantRequests.columns.kind]: 'grant' }),
				cyAsking(seeded, {
					[grantRequests.columns.holderUserId]: seededId(seeded.users, 'ana'),
				}),
			],
			(row) => constraintOf(committedInsert(owner, grantRequests, row)),
		);
		const held = await writeOutcome(committedInsert(owner, grantRequests, cyAsking(seeded)));

		assert.deepEqual(refused, [POLICY_CONSTRAINTS.grantRequestKind, POLICY_CONSTRAINTS.grantRequestSelfHeld]);
		assert.equal(held, 'accepted');
	});

	test("holds an orphaned resource's request for a holder other than the principal who asked alone", async (context) => {
		const { owner, seeded } = await openSeededDatabase(context, BASE_FIXTURE);
		const orphaned = (requestedBy: string): Row =>
			cyAsking(seeded, {
				[grantRequests.columns.kind]: ORPHANED_RESOURCE_REQUEST,
				[grantRequests.columns.requestedBy]: seededId(seeded.users, requestedBy),
			});

		const forThemself = await constraintOf(committedInsert(owner, grantRequests, orphaned('cy')));
		const forAnother = await writeOutcome(committedInsert(owner, grantRequests, orphaned('bo')));

		assert.equal(forThemself, POLICY_CONSTRAINTS.grantRequestOrphanedHeldByAnother);
		assert.equal(forAnother, 'accepted');
	});

	test('records a decision whole, granted with its grant or refused without one, by someone other than the principal who asked', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context, BASE_FIXTURE);
		const bo = seededId(seeded.users, 'bo');
		const cy = seededId(seeded.users, 'cy');
		const grantId = await insertedId(owner, grants, cyGranted(seeded));
		const fresh = (): Promise<string> => insertedId(owner, grantRequests, cyAsking(seeded));

		const refused = await inTurn(
			[
				{ values: { [grantRequests.columns.decision]: 'refused' } },
				{ values: decided('granted', bo) },
				{ values: decided('refused', bo, grantId) },
				{ values: decided('declined', bo) },
				{ values: decided('refused', cy) },
			],
			async ({ values }) => constraintOf(updating(owner, await fresh(), values)),
		);
		const granted = await fresh();
		const granting = await writeOutcome(updating(owner, granted, decided('granted', bo, grantId)));
		const refusal = await writeOutcome(updating(owner, await fresh(), decided('refused', bo)));

		assert.deepEqual(refused, [
			POLICY_CONSTRAINTS.grantRequestDecisionWhole,
			POLICY_CONSTRAINTS.grantRequestGrantWhenGranted,
			POLICY_CONSTRAINTS.grantRequestGrantWhenGranted,
			POLICY_CONSTRAINTS.grantRequestDecision,
			POLICY_CONSTRAINTS.grantRequestDecidedByAnother,
		]);
		assert.equal(granting, 'accepted');
		assert.equal(refusal, 'accepted');
		assert.equal((await requestById(owner, granted))?.[grantRequests.columns.grantId], grantId);
	});

	test("keeps a request's decision once recorded and never deletes a request, for the controller role and the owner alike", async (context) => {
		const { database, owner, seeded } = await openSeededDatabase(context, BASE_FIXTURE);
		const controller = await database.connect('runtime');
		const bo = seededId(seeded.users, 'bo');
		const requestId = await insertedId(owner, grantRequests, cyAsking(seeded));
		await updating(owner, requestId, decided('refused', bo));
		const before = await requestById(owner, requestId);
		const undecided = await insertedId(owner, grantRequests, cyAsking(seeded));

		const rewrites = await inTurn([owner, controller], (client) =>
			inTurn(
				[
					decided(null, null),
					{ [grantRequests.columns.decision]: 'granted' },
					{ [grantRequests.columns.decidedAt]: new Date(0) },
					{ [grantRequests.columns.decidedBy]: seededId(seeded.users, 'ana') },
				],
				(values) => constraintOf(updating(client, requestId, values)),
			),
		);
		const deleting = (client: pg.ClientBase, id: string): Promise<unknown> =>
			committedQuery(client, `DELETE FROM ${qualified(grantRequests)} WHERE ${grantRequests.columns.id} = $1`, [
				id,
			]);
		const byOwner = await inTurn([requestId, undecided], (id) => constraintOf(deleting(owner, id)));
		const byController = await inTurn([requestId, undecided], (id) => writeOutcome(deleting(controller, id)));

		assert.deepEqual(
			rewrites,
			rewrites.map((attempts) => attempts.map(() => POLICY_CONSTRAINTS.grantRequestDecisionKept)),
		);
		assert.deepEqual(byOwner, [POLICY_CONSTRAINTS.grantRequestKept, POLICY_CONSTRAINTS.grantRequestKept]);
		assert.deepEqual(byController, [INSUFFICIENT_PRIVILEGE, INSUFFICIENT_PRIVILEGE]);
		assert.deepEqual(await requestById(owner, requestId), before);
		assert.ok(await requestById(owner, undecided));
	});

	test("lets the controller's role record a request and its decision, and change nothing else of it", async (context) => {
		const { database, owner, seeded } = await openSeededDatabase(context, BASE_FIXTURE);
		const controller = await database.connect('runtime');

		const requestId = await insertedId(controller, grantRequests, cyAsking(seeded));
		const otherChanges = await inTurn(
			[
				{ [grantRequests.columns.expiresAt]: new Date(Date.now() + HOUR_MS) },
				{ [grantRequests.columns.capabilities]: ['record.view'] },
				{ [grantRequests.columns.roleId]: seededId(seeded.roles, 'owner') },
				{ [grantRequests.columns.requestedAt]: new Date(0) },
			],
			(values) => writeOutcome(updating(controller, requestId, values)),
		);
		const decision = await writeOutcome(
			updating(controller, requestId, decided('refused', seededId(seeded.users, 'bo'))),
		);

		assert.deepEqual(
			otherChanges,
			otherChanges.map(() => INSUFFICIENT_PRIVILEGE),
		);
		assert.equal(decision, 'accepted');
		assert.equal((await requestById(owner, requestId))?.[grantRequests.columns.decision], 'refused');
	});

	test('records every change to a request, under the actor its transaction declared', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context, BASE_FIXTURE);
		const requestId = await insertedId(owner, grantRequests, cyAsking(seeded));

		const { changeRecords } = await committedChange(owner, () =>
			owner.query(
				`UPDATE ${qualified(grantRequests)}
            SET ${grantRequests.columns.decision} = 'refused',
                ${grantRequests.columns.decidedAt} = now(),
                ${grantRequests.columns.decidedBy} = $2
          WHERE ${grantRequests.columns.id} = $1`,
				[requestId, seededId(seeded.users, 'bo')],
			),
		);

		assert.deepEqual(
			changeRecords.map(({ operation, tableName }) => ({
				operation,
				tableName,
			})),
			[{ operation: 'UPDATE', tableName: grantRequests.name }],
		);
	});

	test('names the principal who asked for a grant apart from its granter', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context, BASE_FIXTURE);

		const asGranter = await constraintOf(
			committedInsert(owner, grants, {
				...cyGranted(seeded),
				[grants.columns.requestedBy]: seededId(seeded.users, 'bo'),
			}),
		);
		const apart = await writeOutcome(committedInsert(owner, grants, cyGranted(seeded)));
		const unrequested = await writeOutcome(
			committedInsert(owner, grants, {
				...cyGranted(seeded),
				[grants.columns.recordCategoryId]: seededId(seeded.categories, 'unmarked'),
				[grants.columns.requestedBy]: null,
			}),
		);

		assert.equal(asGranter, POLICY_CONSTRAINTS.grantRequestedByAnother);
		assert.equal(apart, 'accepted');
		assert.equal(unrequested, 'accepted');
	});

	test('ties each owner notification to the one grant or request its kind tells of', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context, BASE_FIXTURE);
		const steward = stewardOf(seeded);
		const grantId = seededId(seeded.grants, 'anaViews');
		const requestId = await insertedId(owner, grantRequests, cyAsking(seeded));
		const notification = (over: Row): Row => ({
			[notificationOutbox.columns.createdAt]: new Date(),
			[notificationOutbox.columns.grantId]: null,
			[notificationOutbox.columns.recipientUserId]: steward,
			[notificationOutbox.columns.requestId]: null,
			...over,
		});

		const refused = await inTurn(
			[
				notification({
					[notificationOutbox.columns.grantId]: grantId,
					[notificationOutbox.columns.kind]: GRANT_REQUEST_NOTIFICATION,
				}),
				notification({
					[notificationOutbox.columns.kind]: SELF_GRANT_NOTIFICATION,
					[notificationOutbox.columns.requestId]: requestId,
				}),
				notification({
					[notificationOutbox.columns.grantId]: grantId,
					[notificationOutbox.columns.kind]: SELF_GRANT_NOTIFICATION,
					[notificationOutbox.columns.requestId]: requestId,
				}),
				notification({ [notificationOutbox.columns.kind]: 'grantRequest' }),
				notification({
					[notificationOutbox.columns.grantId]: grantId,
					[notificationOutbox.columns.kind]: 'invitation',
				}),
			],
			(row) => constraintOf(committedInsert(owner, notificationOutbox, row)),
		);
		const held = await inTurn(
			[
				notification({
					[notificationOutbox.columns.kind]: GRANT_REQUEST_NOTIFICATION,
					[notificationOutbox.columns.requestId]: requestId,
				}),
				notification({
					[notificationOutbox.columns.grantId]: grantId,
					[notificationOutbox.columns.kind]: SELF_GRANT_NOTIFICATION,
				}),
			],
			(row) => writeOutcome(committedInsert(owner, notificationOutbox, row)),
		);

		assert.deepEqual(refused, [
			POLICY_CONSTRAINTS.notificationReference,
			POLICY_CONSTRAINTS.notificationReference,
			POLICY_CONSTRAINTS.notificationReference,
			POLICY_CONSTRAINTS.notificationReference,
			POLICY_CONSTRAINTS.notificationKind,
		]);
		assert.deepEqual(held, ['accepted', 'accepted']);
	});

	test("starts on the privileges the migrations grant, finding none of the controller's role's grants beyond its use", async () => {
		const log = captureLog();

		await withHarness({ configuration: { logStream: log.stream } }, () => Promise.resolve());

		assert.deepEqual(
			log
				.lines()
				.map(jsonObjectOf)
				.filter(
					(line) =>
						line[GRANT_BEYOND_USE_LOG_LINE.message.member] === GRANT_BEYOND_USE_LOG_LINE.message.value,
				),
			[],
		);
	});
});
