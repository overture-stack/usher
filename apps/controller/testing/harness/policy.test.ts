import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suite, type TestContext, test } from 'node:test';

import pg from 'pg';

import { AUDIT_EVENT_TYPES, auditRows, emittedType } from './auditEvents.js';
import { createTestDatabase, DATABASE_ROLES } from './database.js';
import { STARTED_STORE_TEMPLATE, startHarness, takeSnapshot } from './harness.js';
import {
	ACTOR_SETTINGS,
	addAcceptedOwner,
	addGroupMember,
	changeRecordCount,
	failNthInsert,
	FAULT_SCHEMA,
	fixtureApplicationId,
	GRANT_WRITTEN_TABLES,
	grantCountOn,
	highestPosition,
	holdNoticesNaming,
	holdRetentionSweep,
	insertNotices,
	internalIdsInStore,
	inTransactionAs,
	isRetiredInStore,
	isRevoked,
	liveGrantId,
	LOWEST_POSITION,
	mergedPolicy,
	noticePositions,
	noticesAfter,
	noticeSubject,
	OWNER_ROLE,
	POLICY_CONSTRAINTS,
	POLICY_TABLES,
	type PolicyFixture,
	policySnapshot,
	qualified,
	readNoticeStream,
	refuseNoticeWrites,
	removeGroupMember,
	resourceIdOf,
	restoreStoreSnapshot,
	RETENTION_SWEEP,
	retireInStore,
	revokeGrantInStore,
	revokePrincipalInStore,
	rowCountOf,
	rowCounts,
	rowsIn,
	SEEDED_ROLES,
	seededId,
	seedPolicy,
	servedByInStore,
	setEpoch,
	setResourceTimesInStore,
	simulateRestore,
	simulateTrim,
	STEWARD,
	STEWARD_SUBJECT,
	storedCapabilities,
	storedExternalIds,
	storedGrants,
	storedResourceTimes,
	SYSTEM_ACTOR,
	tablesOf,
	takeStoreSnapshot,
	trimNotices,
	trimNoticesBounded,
	trimNoticesOpen,
	userIdOf,
	usersWithSubject,
} from './policy.js';
import { cleanupFor } from './waiting.js';

const ISSUER = 'https://auth.example.org/realms/usher';

const FIXTURE: PolicyFixture = {
	applications: {
		'arranger-test': { serves: ['STUDY-A1', 'STUDY-C3'] },
		'lyric-test': { description: 'Lyric', registeredBy: 'ana', serves: [] },
	},
	categories: {
		'community-governed': {},
		controlled: { description: 'Controlled records' },
	},
	decisions: [
		{ decision: 'accepted', grant: 'anaViews' },
		{
			capabilities: ['record.view'],
			decidedAt: new Date('2026-10-01T12:00:00Z'),
			decision: 'rejected',
			grant: 'cyViewed',
		},
		{ decision: 'accepted', grant: 'readersView', person: 'bo' },
	],
	fields: { organization: { description: 'Who holds the data' } },
	grants: {
		anaOwns: {
			category: null,
			holder: { user: 'ana' },
			resource: 'STUDY-A1',
			role: 'owner',
		},
		anaViews: {
			category: 'controlled',
			expiresAt: new Date('2030-01-01T00:00:00Z'),
			grantedBy: 'ana',
			holder: { user: 'ana' },
			resource: 'STUDY-A1',
			role: 'viewer',
		},
		assembles: {
			category: 'unmarked',
			holder: { user: 'bo' },
			resource: 'STUDY-C3',
			role: 'assembler',
		},
		cyViewed: {
			category: 'community-governed',
			grantedAt: new Date('2026-09-01T12:00:00Z'),
			holder: { user: 'cy' },
			resource: 'STUDY-C3',
			revoked: { at: new Date('2026-09-15T12:00:00Z'), by: 'ana' },
			role: 'viewer',
		},
		readersView: {
			category: 'controlled',
			holder: { group: 'readers' },
			resource: 'STUDY-A1',
			role: 'viewer',
		},
	},
	groups: { readers: { members: ['bo', 'cy'], resource: 'STUDY-A1' } },
	issuer: ISSUER,
	resources: {
		'STUDY-A1': {
			baseTier: 'open',
			fieldValues: { organization: 'Institut Exemple du Sud' },
			name: 'Cardiac Outcomes',
			offers: ['controlled'],
			registeredBy: 'ana',
		},
		'STUDY-C3': {
			baseTier: 'registered',
			description: "L'étude « Nord »",
			name: 'Members Archive',
			offers: ['controlled', 'community-governed'],
			suppressed: true,
		},
	},
	revocations: [
		{
			lifted: { at: new Date('2026-10-02T12:00:00Z') },
			reason: 'compromised account',
			revokedAt: new Date('2026-10-01T12:00:00Z'),
			revokedBy: 'ana',
			user: 'cy',
		},
	],
	roles: {
		assembler: {
			capabilities: ['artifact.create', 'artifact.view', 'record.view'],
			plane: 'data',
		},
	},
	users: {
		ana: { subject: '0b7c2f1e-5d1a-4c3e-9f2a-6e8d4b1a7c90' },
		bo: { issuer: 'https://login.example.org', subject: 'auth0|bo+test/=' },
		cy: { subject: 'cy-CASE' },
	},
};

const ownerOfFreshDatabase = async (context: TestContext): Promise<pg.Client> => {
	const database = await createTestDatabase(STARTED_STORE_TEMPLATE);
	context.after(() => database.close());
	return database.connect('migration');
};

const selected = async <Row extends object>(
	client: pg.Client,
	text: string,
	parameters: readonly unknown[] = [],
): Promise<readonly Row[]> => (await client.query<Row>(text, [...parameters])).rows;

const { changeRecords, grantDecisions, grants, resources, userIdentities, users } = POLICY_TABLES;

suite('seeding policy by SQL', () => {
	test("writes every entity of a fixture, returning the internal ids by the fixture's names", async (context) => {
		const client = await ownerOfFreshDatabase(context);

		const seeded = await seedPolicy(client, FIXTURE);

		const subjects = await selected<{
			id: string;
			issuer: string;
			subject: string;
		}>(
			client,
			`SELECT ${userIdentities.columns.userId} AS id, ${userIdentities.columns.idpIssuer} AS issuer, ${userIdentities.columns.idpSubjectId} AS subject FROM ${qualified(userIdentities)} ORDER BY ${userIdentities.columns.idpSubjectId}`,
		);
		assert.equal(await rowCountOf(client, users), subjects.length);
		assert.deepEqual(Object.fromEntries(subjects.map(({ id, issuer, subject }) => [id, `${issuer} ${subject}`])), {
			[seeded.users['ana'] ?? '']: `${ISSUER} 0b7c2f1e-5d1a-4c3e-9f2a-6e8d4b1a7c90`,
			[seeded.users['bo'] ?? '']: 'https://login.example.org auth0|bo+test/=',
			[seeded.users['cy'] ?? '']: `${ISSUER} cy-CASE`,
			[seeded.users[STEWARD] ?? '']: `${ISSUER} steward-7b3e9c1a-usher-test`,
		});
		assert.deepEqual(
			await selected(
				client,
				`SELECT resource.external_id, resource.name, resource.description, resource.base_tier, resource.suppressed, registrant.idp_subject_id AS registrant, array(SELECT category.name FROM ${qualified(POLICY_TABLES.resourceCategories)} offer JOIN ${qualified(POLICY_TABLES.categories)} category ON category.id = offer.category_id WHERE offer.resource_id = resource.id ORDER BY category.name) AS offers, array(SELECT served.application_id::text FROM ${qualified(POLICY_TABLES.applicationResources)} served WHERE served.resource_id = resource.id ORDER BY 1) AS served_by FROM ${qualified(resources)} resource JOIN ${qualified(userIdentities)} registrant ON registrant.user_id = resource.registered_by ORDER BY resource.external_id`,
			),
			[
				{
					base_tier: 'open',
					description: null,
					external_id: 'STUDY-A1',
					name: 'Cardiac Outcomes',
					offers: ['controlled'],
					registrant: '0b7c2f1e-5d1a-4c3e-9f2a-6e8d4b1a7c90',
					served_by: [fixtureApplicationId('arranger-test')],
					suppressed: false,
				},
				{
					base_tier: 'registered',
					description: "L'étude « Nord »",
					external_id: 'STUDY-C3',
					name: 'Members Archive',
					offers: ['community-governed', 'controlled'],
					registrant: 'steward-7b3e9c1a-usher-test',
					served_by: [fixtureApplicationId('arranger-test')],
					suppressed: true,
				},
			],
		);
		assert.deepEqual(
			await selected(
				client,
				`SELECT field.name, held.value, held.resource_id FROM ${qualified(POLICY_TABLES.resourceFieldValues)} held JOIN ${qualified(POLICY_TABLES.resourceFields)} field ON field.id = held.field_id`,
			),
			[
				{
					name: 'organization',
					resource_id: seeded.resources['STUDY-A1'],
					value: 'Institut Exemple du Sud',
				},
			],
		);
		assert.deepEqual(
			await selected(
				client,
				`SELECT ${grants.columns.id} AS id, holder_user_id, holder_group_id, record_category_id, revoked_at, expires_at FROM ${qualified(grants)} ORDER BY granted_at`,
			),
			[
				{
					expires_at: null,
					holder_group_id: null,
					holder_user_id: seeded.users['cy'],
					id: seeded.grants['cyViewed'],
					record_category_id: seeded.categories['community-governed'],
					revoked_at: new Date('2026-09-15T12:00:00Z'),
				},
				{
					expires_at: null,
					holder_group_id: null,
					holder_user_id: seeded.users['ana'],
					id: seeded.grants['anaOwns'],
					record_category_id: null,
					revoked_at: null,
				},
				{
					expires_at: new Date('2030-01-01T00:00:00Z'),
					holder_group_id: null,
					holder_user_id: seeded.users['ana'],
					id: seeded.grants['anaViews'],
					record_category_id: seeded.categories['controlled'],
					revoked_at: null,
				},
				{
					expires_at: null,
					holder_group_id: null,
					holder_user_id: seeded.users['bo'],
					id: seeded.grants['assembles'],
					record_category_id: seeded.categories['unmarked'],
					revoked_at: null,
				},
				{
					expires_at: null,
					holder_group_id: seeded.groups['readers'],
					holder_user_id: null,
					id: seeded.grants['readersView'],
					record_category_id: seeded.categories['controlled'],
					revoked_at: null,
				},
			],
		);
		assert.deepEqual(
			await selected(
				client,
				`SELECT role.name, array(SELECT capability.entity || '.' || capability.action FROM ${qualified(POLICY_TABLES.rolePermissions)} permission JOIN ${qualified(POLICY_TABLES.capabilities)} capability ON capability.id = permission.capability_id WHERE permission.role_id = role.id ORDER BY 1) AS capabilities FROM ${qualified(POLICY_TABLES.roles)} role WHERE role.id = $1`,
				[seeded.roles['assembler']],
			),
			[
				{
					capabilities: ['artifact.create', 'artifact.view', 'record.view'],
					name: 'assembler',
				},
			],
		);
		assert.deepEqual(
			await selected(
				client,
				`SELECT grant_id, user_id, decision, capabilities FROM ${qualified(grantDecisions)} ORDER BY decided_at`,
			),
			[
				{
					capabilities: ['record.view'],
					decision: 'rejected',
					grant_id: seeded.grants['cyViewed'],
					user_id: seeded.users['cy'],
				},
				{
					capabilities: ['record.count', 'record.export', 'record.view'],
					decision: 'accepted',
					grant_id: seeded.grants['anaViews'],
					user_id: seeded.users['ana'],
				},
				{
					capabilities: ['record.count', 'record.export', 'record.view'],
					decision: 'accepted',
					grant_id: seeded.grants['readersView'],
					user_id: seeded.users['bo'],
				},
			],
		);
		assert.deepEqual(
			await selected(
				client,
				`SELECT id, user_id, revoked_by, lifted_by, reason FROM ${qualified(POLICY_TABLES.principalRevocations)}`,
			),
			[
				{
					id: seeded.revocations[0],
					lifted_by: seeded.users[STEWARD],
					reason: 'compromised account',
					revoked_by: seeded.users['ana'],
					user_id: seeded.users['cy'],
				},
			],
		);
		assert.deepEqual(
			await selected(
				client,
				`SELECT grouped.name, array(SELECT member.idp_subject_id FROM ${qualified(POLICY_TABLES.groupUsers)} membership JOIN ${qualified(userIdentities)} member ON member.user_id = membership.user_id WHERE membership.group_id = grouped.id ORDER BY 1) AS members FROM ${qualified(POLICY_TABLES.groups)} grouped`,
			),
			[{ members: ['auth0|bo+test/=', 'cy-CASE'], name: 'readers' }],
		);
	});

	test('declares the system actor for every row it writes, and for no transaction after', async (context) => {
		const client = await ownerOfFreshDatabase(context);

		await seedPolicy(client, FIXTURE);
		const actors = await selected<{
			actor_type: string;
			count: number;
			idp_subject_id: string | null;
		}>(
			client,
			`SELECT ${changeRecords.columns.actorType} AS actor_type, ${changeRecords.columns.idpSubjectId} AS idp_subject_id, count(*)::int AS count FROM ${qualified(changeRecords)} GROUP BY 1, 2`,
		);
		const afterwards = await selected<{ type: string | null }>(client, 'SELECT current_setting($1, true) AS type', [
			ACTOR_SETTINGS.type,
		]);

		assert.equal(actors.length, 1);
		assert.equal(actors[0]?.actor_type, SYSTEM_ACTOR.type);
		assert.equal(actors[0]?.idp_subject_id, null);
		assert.ok((actors[0]?.count ?? 0) > 30);
		assert.equal(afterwards[0]?.type ?? '', '');
	});

	test('writes nothing when the fixture names something it does not hold, naming it', async (context) => {
		const client = await ownerOfFreshDatabase(context);
		const before = await rowCounts(client, {
			changeRecords,
			userIdentities,
			users,
		});

		await assert.rejects(
			seedPolicy(client, {
				...FIXTURE,
				grants: {
					...FIXTURE.grants,
					deeViews: {
						category: 'controlled',
						holder: { user: 'dee' },
						resource: 'STUDY-A1',
						role: 'viewer',
					},
				},
			}),
			{ message: 'the fixture names no user dee' },
		);
		await assert.rejects(
			seedPolicy(client, {
				...FIXTURE,
				resources: {
					...FIXTURE.resources,
					'STUDY-B2': { baseTier: 'open', name: 'B2', offers: ['restricted'] },
				},
			}),
			{ message: 'the fixture names no global category restricted' },
		);

		assert.deepEqual(await rowCounts(client, { changeRecords, userIdentities, users }), before);
	});

	test('writes the steward only when an entry names no one to act for it', async (context) => {
		const client = await ownerOfFreshDatabase(context);

		const named = await seedPolicy(client, {
			resources: {
				'STUDY-A1': { baseTier: 'open', name: 'A1', registeredBy: 'ana' },
			},
			users: { ana: { subject: 'ana-subject' } },
		});
		const unnamed = await seedPolicy(client, {
			resources: { 'STUDY-B2': { baseTier: 'grant', name: 'B2' } },
		});

		assert.deepEqual(Object.keys(named.users), ['ana']);
		assert.deepEqual(Object.keys(unnamed.users), [STEWARD]);
		assert.deepEqual(
			await selected(
				client,
				`SELECT resource.external_id, registrant.id AS registrant FROM ${qualified(resources)} resource JOIN ${qualified(users)} registrant ON registrant.id = resource.registered_by ORDER BY 1`,
			),
			[
				{ external_id: 'STUDY-A1', registrant: named.users['ana'] },
				{ external_id: 'STUDY-B2', registrant: unnamed.users[STEWARD] },
			],
		);
	});

	test("refuses a decision on a group's grant that names no person", async (context) => {
		const client = await ownerOfFreshDatabase(context);

		await assert.rejects(
			seedPolicy(client, {
				...FIXTURE,
				decisions: [{ decision: 'accepted', grant: 'readersView' }],
			}),
			{
				message: "the fixture's decision on readersView, a group's grant, names no person",
			},
		);
	});
});

suite('declaring who acts', () => {
	test('declares an actor for its transaction alone', async (context) => {
		const client = await ownerOfFreshDatabase(context);
		const declared = (): Promise<readonly { id: string | null; type: string | null }[]> =>
			selected(client, 'SELECT current_setting($1, true) AS type, current_setting($2, true) AS id', [
				ACTOR_SETTINGS.type,
				ACTOR_SETTINGS.id,
			]);

		const during = await inTransactionAs(client, { id: 'ana-subject', type: 'human' }, declared);
		const afterwards = await declared();

		assert.deepEqual(during, [{ id: 'ana-subject', type: 'human' }]);
		assert.deepEqual(
			afterwards.map(({ id, type }) => [id ?? '', type ?? '']),
			[['', '']],
		);
		await assert.rejects(
			client.query(`INSERT INTO ${qualified(POLICY_TABLES.categories)} (scope, name) VALUES ('global', $1)`, [
				'restricted',
			]),
			{ message: 'a policy change declares no actor' },
		);
	});

	test('records the declared actor with the change, a subject for a person and none for the system', async (context) => {
		const client = await ownerOfFreshDatabase(context);
		const insertCategory = (name: string) => (): Promise<pg.QueryResult> =>
			client.query(`INSERT INTO ${qualified(POLICY_TABLES.categories)} (scope, name) VALUES ('global', $1)`, [
				name,
			]);

		await inTransactionAs(client, { id: 'admin-0001', type: 'human' }, insertCategory('controlled'));
		await inTransactionAs(client, { id: 'lyric', type: 'serviceAccount' }, insertCategory('restricted'));
		await inTransactionAs(client, SYSTEM_ACTOR, insertCategory('reviewed'));

		assert.deepEqual(
			await selected(
				client,
				`SELECT ${changeRecords.columns.actorType} AS type, ${changeRecords.columns.idpSubjectId} AS id FROM ${qualified(changeRecords)} WHERE ${changeRecords.columns.tableName} = $1 AND ${changeRecords.columns.newRow} ->> $2 = ANY ($3) ORDER BY ${changeRecords.columns.actorType}`,
				[
					POLICY_TABLES.categories.name,
					POLICY_TABLES.categories.columns.name,
					['controlled', 'restricted', 'reviewed'],
				],
			),
			[
				{ id: 'admin-0001', type: 'human' },
				{ id: 'lyric', type: 'serviceAccount' },
				{ id: null, type: 'system' },
			],
		);
	});

	test('rolls the transaction back when its work throws, and rethrows', async (context) => {
		const client = await ownerOfFreshDatabase(context);

		await assert.rejects(
			inTransactionAs(client, SYSTEM_ACTOR, async () => {
				await client.query(`INSERT INTO ${qualified(users)} (${users.columns.createdAt}) VALUES (now())`);
				throw new Error('the work failed');
			}),
			{ message: 'the work failed' },
		);

		assert.deepEqual(await selected(client, `SELECT count(*)::int AS count FROM ${qualified(users)}`), [
			{ count: 0 },
		]);
	});
});

suite('seeding again on one database', () => {
	test('finds a person and an application already held, by the id derived from its label or the id given, rather than writing them twice, and names a resource already held', async (context) => {
		const client = await ownerOfFreshDatabase(context);

		const first = await seedPolicy(client, {
			applications: { 'arranger-test': { registeredBy: 'ana', serves: [] } },
			resources: {
				'STUDY-A1': { baseTier: 'open', name: 'A1', registeredBy: 'ana' },
			},
			users: { ana: { subject: 'ana-subject' } },
		});
		const registeredId = randomUUID();
		const second = await seedPolicy(client, {
			applications: {
				'arranger-test': { registeredBy: 'ana', serves: ['STUDY-A1'] },
				'lyric-test': { id: registeredId, registeredBy: 'ana', serves: [] },
			},
			grants: {
				anaViews: {
					category: 'unmarked',
					grantedBy: 'ana',
					holder: { user: 'ana' },
					resource: 'STUDY-A1',
					role: 'viewer',
				},
			},
			users: { ana: { subject: 'ana-subject' } },
		});

		const third = await seedPolicy(client, {
			applications: {
				'lyric-test': {
					id: registeredId,
					registeredBy: 'ana',
					serves: ['STUDY-A1'],
				},
			},
			users: { ana: { subject: 'ana-subject' } },
		});

		assert.equal(second.users['ana'], first.users['ana']);
		assert.deepEqual(first.applications, {
			'arranger-test': fixtureApplicationId('arranger-test'),
		});
		assert.deepEqual(second.applications, {
			'arranger-test': fixtureApplicationId('arranger-test'),
			'lyric-test': registeredId,
		});
		assert.deepEqual(third.applications, { 'lyric-test': registeredId });
		assert.equal(await usersWithSubject(client, 'ana-subject'), 1);
		assert.equal(await usersWithSubject(client, 'bo-subject'), 0);
		assert.equal(second.resources['STUDY-A1'], first.resources['STUDY-A1']);
		assert.deepEqual(
			await selected(
				client,
				`SELECT (SELECT count(*)::int FROM ${qualified(users)}) AS people, (SELECT count(*)::int FROM ${qualified(userIdentities)}) AS identities, (SELECT count(*)::int FROM ${qualified(POLICY_TABLES.applications)}) AS applications, (SELECT count(*)::int FROM ${qualified(POLICY_TABLES.applicationResources)}) AS served, (SELECT count(*)::int FROM ${qualified(grants)}) AS grants`,
			),
			[{ applications: 2, grants: 1, identities: 1, people: 1, served: 2 }],
		);
		assert.deepEqual(
			await selected(
				client,
				`SELECT ${POLICY_TABLES.applications.columns.displayName} AS display_name, ${POLICY_TABLES.applications.columns.id}::text AS id FROM ${qualified(POLICY_TABLES.applications)} ORDER BY 1`,
			),
			[
				{
					display_name: 'arranger-test',
					id: fixtureApplicationId('arranger-test'),
				},
				{ display_name: 'lyric-test', id: registeredId },
			],
		);
	});
});

suite('the id given to a fixture application by seeding', () => {
	test('derives one uuid per label, the same on every call, in the layout of version 8', () => {
		const labels = ['arranger-test', 'lyric-test', 'Arranger-test', ''];

		const ids = labels.map(fixtureApplicationId);

		ids.forEach((id) => assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u));
		assert.equal(new Set(ids).size, labels.length);
		assert.deepEqual(labels.map(fixtureApplicationId), ids);
	});
});

suite('people and their identities', () => {
	test('writes each person with their one identity, added by no one, and finds a person again through that identity alone', async (context) => {
		const client = await ownerOfFreshDatabase(context);

		const first = await seedPolicy(client, {
			users: { ana: { subject: 'ana-subject' } },
		});
		const second = await seedPolicy(client, {
			users: {
				again: { subject: 'ana-subject' },
				elsewhere: {
					issuer: 'https://login.example.org',
					subject: 'ana-subject',
				},
			},
		});
		const identities = await selected<{
			addedAt: Date | null;
			addedBy: string | null;
			issuer: string;
			userId: string;
		}>(
			client,
			`SELECT ${userIdentities.columns.addedAt} AS "addedAt", ${userIdentities.columns.addedBy} AS "addedBy", ${userIdentities.columns.idpIssuer} AS issuer, ${userIdentities.columns.userId} AS "userId" FROM ${qualified(userIdentities)} ORDER BY ${userIdentities.columns.idpIssuer}`,
		);

		assert.equal(second.users['again'], first.users['ana']);
		assert.notEqual(second.users['elsewhere'], first.users['ana']);
		assert.deepEqual(
			identities.map(({ addedAt, addedBy, issuer, userId }) => ({
				added: addedAt instanceof Date,
				addedBy,
				issuer,
				userId,
			})),
			[
				{
					added: true,
					addedBy: null,
					issuer: ISSUER,
					userId: first.users['ana'],
				},
				{
					added: true,
					addedBy: null,
					issuer: 'https://login.example.org',
					userId: second.users['elsewhere'],
				},
			],
		);
		assert.equal(await rowCountOf(client, users), 2);
		assert.equal(await usersWithSubject(client, 'ana-subject'), 2);
	});

	test("writes a person and their identity in one transaction, leaving neither when the identity's insert fails", async (context) => {
		const scope = cleanupFor(context);
		const database = await createTestDatabase(STARTED_STORE_TEMPLATE);
		scope.defer(() => database.close());
		const client = await database.connect('migration');
		await failNthInsert(scope, client, userIdentities, 1);

		await assert.rejects(seedPolicy(client, { users: { ana: { subject: 'ana-subject' } } }), {
			message: 'a test injected a fault at this insert',
		});

		assert.deepEqual(await rowCounts(client, { userIdentities, users }), {
			userIdentities: 0,
			users: 0,
		});
	});

	test("refuses an identity another person already holds, naming the identities' key", async (context) => {
		const client = await ownerOfFreshDatabase(context);
		await seedPolicy(client, { users: { ana: { subject: 'ana-subject' } } });

		await assert.rejects(
			inTransactionAs(client, SYSTEM_ACTOR, async () => {
				const { rows } = await client.query<{ id: string }>(
					`INSERT INTO ${qualified(users)} (${users.columns.createdAt}) VALUES (now()) RETURNING ${users.columns.id} AS id`,
				);
				await client.query(
					`INSERT INTO ${qualified(userIdentities)} (${userIdentities.columns.userId}, ${userIdentities.columns.idpIssuer}, ${userIdentities.columns.idpSubjectId}, ${userIdentities.columns.addedAt}) VALUES ($1, $2, $3, now())`,
					[rows[0]?.id, ISSUER, 'ana-subject'],
				);
			}),
			{ code: '23505', constraint: POLICY_CONSTRAINTS.identity },
		);

		assert.equal(await rowCountOf(client, users), 1);
	});

	test('reads people through their identities, and a reader assuming one identity per person fails clearly on a person holding two', async (context) => {
		const client = await ownerOfFreshDatabase(context);
		const seeded = await seedPolicy(client, FIXTURE);
		const ana = '0b7c2f1e-5d1a-4c3e-9f2a-6e8d4b1a7c90';
		const bo = 'auth0|bo+test/=';
		const anaId = seededId(seeded.users, 'ana');

		await inTransactionAs(client, SYSTEM_ACTOR, () =>
			client.query(
				`INSERT INTO ${qualified(userIdentities)} (${userIdentities.columns.userId}, ${userIdentities.columns.idpIssuer}, ${userIdentities.columns.idpSubjectId}, ${userIdentities.columns.addedAt}, ${userIdentities.columns.addedBy}) VALUES ($1, $2, $3, now(), $4)`,
				[anaId, 'https://login.example.org', 'ana-elsewhere', seededId(seeded.users, STEWARD)],
			),
		);
		const anaViews = {
			category: 'controlled',
			resource: 'STUDY-A1',
			role: 'viewer',
		};

		assert.equal(await userIdOf(client, ana), anaId);
		assert.equal(await userIdOf(client, 'ana-elsewhere'), anaId);
		assert.equal(await usersWithSubject(client, ana), 1);
		assert.equal(await usersWithSubject(client, 'ana-elsewhere'), 1);
		assert.equal(await liveGrantId(client, { ...anaViews, holder: ana }), seededId(seeded.grants, 'anaViews'));
		assert.equal(
			await liveGrantId(client, { ...anaViews, holder: 'ana-elsewhere' }),
			seededId(seeded.grants, 'anaViews'),
		);
		assert.deepEqual(
			(await storedGrants(client, { holder: bo })).map(({ granterSubject, holderIssuer, holderSubject }) => ({
				granterSubject,
				holderIssuer,
				holderSubject,
			})),
			[
				{
					granterSubject: STEWARD_SUBJECT,
					holderIssuer: 'https://login.example.org',
					holderSubject: bo,
				},
			],
		);
		await assert.rejects(storedGrants(client, { holder: ana }), {
			message:
				'a person holds more than one identity in the store, and this reader reads one: the first release records one identity per person',
		});
	});
});

suite("a resource's own categories, a retirement and invitations", () => {
	test('writes them at the database, naming each category by its scope as a payload does', async (context) => {
		const client = await ownerOfFreshDatabase(context);

		const seeded = await seedPolicy(client, {
			categories: { controlled: {} },
			grants: {
				anaRestricted: {
					category: 'resource.restricted',
					holder: { user: 'ana' },
					resource: 'STUDY-A1',
					role: 'viewer',
				},
			},
			invitations: [
				{
					category: 'resource.restricted',
					email: 'gil@example.org',
					resource: 'STUDY-A1',
					role: 'viewer',
				},
				{
					category: 'global.controlled',
					email: 'una@example.org',
					expiresAt: new Date('2027-01-01T00:00:00Z'),
					resource: 'STUDY-B2',
					role: 'viewer',
				},
			],
			resources: {
				'STUDY-A1': {
					baseTier: 'grant',
					categories: { restricted: { description: 'Restricted records' } },
					name: 'A1',
					offers: ['resource.restricted', 'global.controlled', 'unmarked'],
				},
				'STUDY-B2': {
					baseTier: 'open',
					name: 'B2',
					retired: { at: new Date('2026-10-01T12:00:00Z') },
				},
			},
			users: { ana: { subject: 'ana-subject' } },
		});
		const restricted = seeded.resourceCategories['STUDY-A1']?.['restricted'];

		assert.deepEqual(
			await selected(
				client,
				`SELECT scope, resource_id, name, description FROM ${qualified(POLICY_TABLES.categories)} WHERE id = $1`,
				[restricted],
			),
			[
				{
					description: 'Restricted records',
					name: 'restricted',
					resource_id: seeded.resources['STUDY-A1'],
					scope: 'resource',
				},
			],
		);
		assert.deepEqual(
			(
				await selected<{ category_id: string }>(
					client,
					`SELECT category_id FROM ${qualified(POLICY_TABLES.resourceCategories)} WHERE resource_id = $1`,
					[seeded.resources['STUDY-A1']],
				)
			)
				.map(({ category_id }) => category_id)
				.toSorted(),
			[restricted, seeded.categories['controlled'], seeded.categories['unmarked']].toSorted(),
		);
		assert.deepEqual(
			await selected(client, `SELECT record_category_id FROM ${qualified(grants)} WHERE id = $1`, [
				seeded.grants['anaRestricted'],
			]),
			[{ record_category_id: restricted }],
		);
		assert.deepEqual(
			await selected(
				client,
				`SELECT external_id, retired_at, retired_by FROM ${qualified(resources)} ORDER BY external_id`,
			),
			[
				{ external_id: 'STUDY-A1', retired_at: null, retired_by: null },
				{
					external_id: 'STUDY-B2',
					retired_at: new Date('2026-10-01T12:00:00Z'),
					retired_by: seeded.users[STEWARD],
				},
			],
		);
		assert.deepEqual(
			await selected(
				client,
				`SELECT id, email, record_category_id, expires_at, invited_by, octet_length(link_token_hash) AS hash_bytes FROM ${qualified(POLICY_TABLES.invitations)} ORDER BY email`,
			),
			[
				{
					email: 'gil@example.org',
					expires_at: null,
					hash_bytes: 32,
					id: seeded.invitations[0],
					invited_by: seeded.users[STEWARD],
					record_category_id: restricted,
				},
				{
					email: 'una@example.org',
					expires_at: new Date('2027-01-01T00:00:00Z'),
					hash_bytes: 32,
					id: seeded.invitations[1],
					invited_by: seeded.users[STEWARD],
					record_category_id: seeded.categories['controlled'],
				},
			],
		);
	});

	test('refuses a resource category the resource does not hold, naming it', async (context) => {
		const client = await ownerOfFreshDatabase(context);

		await assert.rejects(
			seedPolicy(client, {
				resources: {
					'STUDY-A1': {
						baseTier: 'open',
						name: 'A1',
						offers: ['resource.restricted'],
					},
				},
			}),
			{ message: 'the fixture names no category of STUDY-A1 restricted' },
		);
	});
});

suite('changes by SQL that pass through no write path of the controller', () => {
	test('finds a live grant by holder, resource, category and role, and revokes it by SQL', async (context) => {
		const client = await ownerOfFreshDatabase(context);
		const seeded = await seedPolicy(client, FIXTURE);
		const ana = '0b7c2f1e-5d1a-4c3e-9f2a-6e8d4b1a7c90';

		const viewing = await liveGrantId(client, {
			category: 'controlled',
			holder: ana,
			resource: 'STUDY-A1',
			role: 'viewer',
		});
		const owning = await liveGrantId(client, {
			category: null,
			holder: ana,
			resource: 'STUDY-A1',
		});
		await assert.rejects(liveGrantId(client, { holder: ana, resource: 'STUDY-A1' }), {
			message: 'the store holds 2 live grants matching that lookup on STUDY-A1',
		});
		const before = await isRevoked(client, viewing);
		await revokeGrantInStore(client, {
			grantId: viewing,
			revokedBy: seededId(seeded.users, STEWARD),
		});

		assert.equal(viewing, seededId(seeded.grants, 'anaViews'));
		assert.equal(owning, seededId(seeded.grants, 'anaOwns'));
		assert.equal(before, false);
		assert.equal(await isRevoked(client, viewing), true);
		await assert.rejects(
			liveGrantId(client, {
				category: 'global.controlled',
				holder: ana,
				resource: 'STUDY-A1',
			}),
			{
				message: 'the store holds 0 live grants matching that lookup on STUDY-A1',
			},
		);
		assert.throws(() => seededId(seeded.grants, 'nobodyViews'), {
			message: 'seeding wrote nothing named nobodyViews',
		});
	});

	test('revokes a principal, and adds and removes a group member, each under the system actor', async (context) => {
		const client = await ownerOfFreshDatabase(context);
		const seeded = await seedPolicy(client, FIXTURE);
		const members = async (): Promise<readonly string[]> =>
			(
				await selected<{ user_id: string }>(
					client,
					`SELECT user_id FROM ${qualified(POLICY_TABLES.groupUsers)} WHERE group_id = $1 ORDER BY user_id`,
					[seeded.groups['readers']],
				)
			).map(({ user_id }) => user_id);
		const groupId = seededId(seeded.groups, 'readers');
		const anaId = seededId(seeded.users, 'ana');
		const recorded = async (): Promise<readonly string[]> =>
			(
				await selected<{ change: string }>(
					client,
					`SELECT table_name || ' ' || operation || ' ' || actor_type AS change FROM ${qualified(changeRecords)} WHERE table_name IN ('group_users', 'principal_revocations') ORDER BY 1`,
				)
			).map(({ change }) => change);
		const before = await recorded();

		await revokePrincipalInStore(client, {
			revokedBy: seededId(seeded.users, STEWARD),
			userId: anaId,
		});
		await addGroupMember(client, { groupId, userId: anaId });
		const added = await members();
		await removeGroupMember(client, { groupId, userId: anaId });

		assert.ok(added.includes(anaId));
		assert.ok(!(await members()).includes(anaId));
		assert.deepEqual(
			await selected(
				client,
				`SELECT reason, lifted_at FROM ${qualified(POLICY_TABLES.principalRevocations)} WHERE user_id = $1`,
				[anaId],
			),
			[{ lifted_at: null, reason: 'synthetic revocation for a test' }],
		);
		assert.equal((await recorded()).length - before.length, 3);
		assert.deepEqual([...new Set(await recorded())].toSorted(), [
			'group_users DELETE system',
			'group_users INSERT system',
			'principal_revocations INSERT system',
		]);
		assert.equal(STEWARD_SUBJECT, 'steward-7b3e9c1a-usher-test');
	});
});

suite('the notice stream, written and read straight in its tables', () => {
	test('writes notices in the order given in one transaction, and reads them back after a position', async (context) => {
		const client = await ownerOfFreshDatabase(context);
		await seedPolicy(client, {
			applications: { 'search-test': { serves: [] } },
		});

		const empty = await highestPosition(client);
		await insertNotices(client, [
			{
				kind: 'principal',
				subject: noticeSubject({ subject: 'auth0|bo+test/=' }),
			},
			{ kind: 'category', resourceExternalId: 'STUDY-A1' },
			{
				audience: fixtureApplicationId('search-test'),
				kind: 'servedResources',
			},
		]);
		const written = await noticesAfter(client);
		const [first] = written;
		const later = await noticesAfter(client, first?.position ?? LOWEST_POSITION);

		assert.equal(empty, LOWEST_POSITION);
		assert.deepEqual(
			written.map(({ audience, kind, resourceExternalId, subject }) => ({
				audience,
				kind,
				resourceExternalId,
				subject,
			})),
			[
				{
					audience: null,
					kind: 'principal',
					resourceExternalId: null,
					subject: 'auth0|bo+test/=',
				},
				{
					audience: null,
					kind: 'category',
					resourceExternalId: 'STUDY-A1',
					subject: null,
				},
				{
					audience: fixtureApplicationId('search-test'),
					kind: 'servedResources',
					resourceExternalId: null,
					subject: null,
				},
			],
		);
		assert.equal(new Set(written.map(({ transaction }) => transaction)).size, 1);
		assert.deepEqual(
			later.map(({ kind }) => kind),
			['category', 'servedResources'],
		);
		assert.equal(await highestPosition(client), written.at(-1)?.position);
	});

	test('stands in for a trim, a new epoch and a restore', async (context) => {
		const client = await ownerOfFreshDatabase(context);
		await insertNotices(client, [{ kind: 'baseline' }, { kind: 'global' }, { kind: 'baseline' }]);
		const [first, second] = await noticePositions(client);
		const before = await readNoticeStream(client);

		await simulateTrim(client, first ?? 0n);
		const trimmed = await readNoticeStream(client);
		await setEpoch(client);
		const renewed = await readNoticeStream(client);
		await simulateRestore(client, { epoch: 'kept', keptThrough: second ?? 0n });
		await insertNotices(client, [{ kind: 'global' }]);

		assert.equal(trimmed.trimmedThrough, first);
		assert.equal(trimmed.epoch, before.epoch);
		assert.notEqual(renewed.epoch, before.epoch);
		assert.deepEqual(await noticePositions(client), [second, (second ?? 0n) + 1n]);
		assert.equal((await readNoticeStream(client)).epoch, renewed.epoch);
	});

	test("holds a notice's writer open after its insert until released, and refuses every write while told to", async (context) => {
		const scope = cleanupFor(context);
		const database = await createTestDatabase(STARTED_STORE_TEMPLATE);
		scope.defer(() => database.close());
		const holder = await database.connect('migration');
		const otherWriter = await database.connect('migration');

		const hold = await holdNoticesNaming(scope, holder, ['held-subject']);
		const writing = insertNotices(otherWriter, [{ kind: 'principal', subject: 'held-subject' }]);
		await hold.waitUntilHeld();
		const whileHeld = await noticesAfter(holder);
		await hold.release();
		await writing;
		await hold.remove();
		const refusal = await refuseNoticeWrites(scope, holder);
		const refused = await insertNotices(holder, [{ kind: 'global' }]).then(
			() => 'written',
			(error: unknown) => (error instanceof Error ? error.message : 'refused'),
		);
		await refusal.remove();
		await insertNotices(holder, [{ kind: 'baseline' }]);

		assert.deepEqual(whileHeld, []);
		assert.equal(refused, 'a test refuses this notice write');
		assert.deepEqual(
			(await noticesAfter(holder)).map(({ kind }) => kind),
			['principal', 'baseline'],
		);
	});
});

suite('the trimming function, called', () => {
	test('commits a trim, and leaves another open to look between the trim and its commit', async (context) => {
		const client = await ownerOfFreshDatabase(context);
		const old = new Date(Date.now() - 3_600_000);
		await insertNotices(client, [
			{ createdAt: old, kind: 'baseline' },
			{ createdAt: old, kind: 'global' },
			{ kind: 'baseline' },
		]);
		const [, second] = await noticePositions(client);

		const open = await trimNoticesOpen(client);
		const whileOpen = (await readNoticeStream(client)).trimmedThrough;
		await open.rollback();
		const rolledBack = (await readNoticeStream(client)).trimmedThrough;
		const committed = await trimNotices(client);

		assert.equal(open.trimmedThrough, second);
		assert.equal(whileOpen, second);
		assert.equal(rolledBack, 0n);
		assert.equal(committed, second);
		assert.deepEqual(
			(await noticesAfter(client)).map(({ kind }) => kind),
			['baseline'],
		);
	});

	test('calls the bounded trim with the most notices it may delete, committing it', async (context) => {
		const client = await ownerOfFreshDatabase(context);
		const old = new Date(Date.now() - 3_600_000);
		await insertNotices(client, [
			{ createdAt: old, kind: 'baseline' },
			{ createdAt: old, kind: 'global' },
			{ kind: 'baseline' },
		]);
		const [first] = await noticePositions(client);

		const trimmedThrough = await trimNoticesBounded(client, 1);

		assert.equal(trimmedThrough, first);
		assert.equal((await readNoticeStream(client)).trimmedThrough, first);
		assert.deepEqual(
			(await noticesAfter(client)).map(({ kind }) => kind),
			['global', 'baseline'],
		);
	});
});

suite("the retention sweep's lock, held", () => {
	test('keeps the lock from every other session until released', async (context) => {
		const database = await createTestDatabase(STARTED_STORE_TEMPLATE);
		context.after(() => database.close());
		const holder = await database.connect('migration');
		const other = await database.connect('runtime');
		const tryLock = async (): Promise<boolean> => {
			await other.query('BEGIN');
			try {
				const { rows } = await other.query<{ locked: boolean }>(
					'SELECT pg_try_advisory_xact_lock($1) AS locked',
					[RETENTION_SWEEP.lock],
				);
				return rows[0]?.locked === true;
			} finally {
				await other.query('COMMIT');
			}
		};

		const hold = await holdRetentionSweep(holder);
		const whileHeld = await tryLock();
		await hold.release();
		await hold.release();
		const released = await tryLock();

		assert.deepEqual({ released, whileHeld }, { released: true, whileHeld: false });
	});
});

suite('fixtures combined', () => {
	test('merges records by name, the later winning, joins lists in order, and keeps the last issuer given', () => {
		const merged = mergedPolicy(
			{
				decisions: [{ decision: 'accepted', grant: 'first' }],
				issuer: 'https://realm.example.org/realms/one',
				resources: { 'STUDY-A1': { baseTier: 'open', name: 'First' } },
				users: { ana: { subject: 'ana-1' } },
			},
			{
				decisions: [{ decision: 'rejected', grant: 'second' }],
				resources: { 'STUDY-A1': { baseTier: 'grant', name: 'Second' } },
				users: { bo: { subject: 'bo-1' } },
			},
		);
		const reissued = mergedPolicy(merged, {
			issuer: 'https://realm.example.org/realms/two',
		});

		assert.equal(merged.issuer, 'https://realm.example.org/realms/one');
		assert.equal(reissued.issuer, 'https://realm.example.org/realms/two');
		assert.deepEqual(merged.resources, {
			'STUDY-A1': { baseTier: 'grant', name: 'Second' },
		});
		assert.deepEqual(
			merged.decisions?.map(({ grant }) => grant),
			['first', 'second'],
		);
		assert.deepEqual(Object.keys(merged.users ?? {}), ['ana', 'bo']);
		assert.equal(mergedPolicy().issuer, undefined);
	});
});

suite("a resource's registration and change times", () => {
	test('are set once the rest of a fixture is seeded and read back, and set again by SQL', async (context) => {
		const client = await ownerOfFreshDatabase(context);
		const registeredAt = new Date('2026-01-02T03:04:05.678Z');
		const updatedAt = new Date('2026-02-03T04:05:06.000Z');
		const before = Date.now();

		const seeded = await seedPolicy(client, {
			fields: { organization: {} },
			resources: {
				'STUDY-T1': {
					baseTier: 'open',
					fieldValues: { organization: 'Institut Exemple' },
					name: 'Timed',
					registeredAt,
					updatedAt,
				},
				'STUDY-T2': { baseTier: 'open', name: 'Untimed' },
			},
		});
		const untimed = seeded.resourceTimes['STUDY-T2'];
		const changed = {
			'STUDY-T2': {
				registeredAt: new Date('2025-05-05T05:05:05.000Z'),
				updatedAt: new Date('2025-06-06T06:06:06.000Z'),
			},
		};
		const snapshot = await policySnapshot(client);
		await setResourceTimesInStore(client, changed);

		assert.deepEqual(seeded.resourceTimes['STUDY-T1'], {
			registeredAt,
			updatedAt,
		});
		assert.ok((untimed?.registeredAt.getTime() ?? 0) >= before - 1000);
		assert.deepEqual(await storedResourceTimes(client, ['STUDY-T2', 'STUDY-ZZ']), changed);
		assert.notDeepEqual(await policySnapshot(client), snapshot);
	});
});

suite('retiring a resource, and adding an owner, by SQL', () => {
	const ANA = '0b7c2f1e-5d1a-4c3e-9f2a-6e8d4b1a7c90';

	const OWNED: PolicyFixture = {
		grants: {
			anaOwns: {
				category: null,
				holder: { user: 'ana' },
				resource: 'STUDY-R1',
				role: OWNER_ROLE,
			},
			anaOwnsOther: {
				category: null,
				holder: { user: 'ana' },
				resource: 'STUDY-R2',
				role: OWNER_ROLE,
			},
			anaViewed: {
				category: 'unmarked',
				expiresAt: new Date('2026-10-01T00:00:00Z'),
				holder: { user: 'ana' },
				resource: 'STUDY-R1',
				role: 'viewer',
			},
			cyOwnedOnce: {
				category: null,
				holder: { user: 'cy' },
				resource: 'STUDY-R1',
				revoked: { at: new Date('2026-09-01T00:00:00Z') },
				role: OWNER_ROLE,
			},
			stewardsOwned: {
				category: null,
				expiresAt: new Date('2026-10-01T00:00:00Z'),
				holder: { group: 'stewards' },
				resource: 'STUDY-R1',
				role: OWNER_ROLE,
			},
		},
		groups: { stewards: { members: ['cy'], resource: 'STUDY-R1' } },
		resources: {
			'STUDY-R1': { baseTier: 'grant', name: 'Retiring' },
			'STUDY-R2': { baseTier: 'grant', name: 'Staying' },
		},
		users: {
			ana: { subject: ANA },
			bo: { subject: 'auth0|bo+test/=' },
			cy: { subject: 'cy-CASE' },
		},
	};

	const revocationOf = async (
		client: pg.Client,
		grantId: string,
	): Promise<{ by: string | null; revoked: string | null }> => {
		const [row] = await selected<{ by: string | null; revoked: string | null }>(
			client,
			`SELECT revoked_at::text AS revoked, revoked_by::text AS by FROM ${qualified(grants)} WHERE id = $1`,
			[grantId],
		);
		return row ?? { by: null, revoked: null };
	};

	test("ends every person's owner grant neither revoked nor expired, at the retirement's instant, in its transaction", async (context) => {
		const client = await ownerOfFreshDatabase(context);
		const seeded = await seedPolicy(client, OWNED);
		const steward = seededId(seeded.users, STEWARD);
		const grant = (name: string): string => seededId(seeded.grants, name);
		const resourceChanges = await changeRecordCount(client, resources);
		const earlier = await revocationOf(client, grant('cyOwnedOnce'));
		const at = new Date('2026-10-20T10:00:00.123Z');

		const ended = await retireInStore(client, {
			at,
			by: steward,
			externalId: 'STUDY-R1',
		});
		const [retired] = await selected<{ at: string; by: string }>(
			client,
			`SELECT retired_at::text AS at, retired_by::text AS by FROM ${qualified(resources)} WHERE external_id = 'STUDY-R1'`,
		);
		// One connection runs one query at a time, so the reads run in turn, each after the one before.
		const untouched = await ['anaOwnsOther', 'anaViewed', 'stewardsOwned'].reduce<Promise<(string | null)[]>>(
			(previous, name) =>
				previous.then(async (done) => [...done, (await revocationOf(client, grant(name))).revoked]),
			Promise.resolve([]),
		);

		assert.deepEqual(ended, [grant('anaOwns')]);
		assert.equal(await isRetiredInStore(client, 'STUDY-R1'), true);
		assert.equal(await isRetiredInStore(client, 'STUDY-R2'), false);
		assert.deepEqual(await revocationOf(client, grant('anaOwns')), {
			by: steward,
			revoked: retired?.at ?? 'no retirement',
		});
		assert.equal(retired?.by, steward);
		assert.deepEqual(untouched, [null, null, null]);
		assert.deepEqual(await revocationOf(client, grant('cyOwnedOnce')), earlier);
		assert.equal((await changeRecordCount(client, resources)) - resourceChanges, 1);
	});

	test('writes nothing for a resource the store does not hold', async (context) => {
		const client = await ownerOfFreshDatabase(context);
		const seeded = await seedPolicy(client, OWNED);
		const snapshot = await policySnapshot(client);

		await assert.rejects(
			retireInStore(client, {
				by: seededId(seeded.users, STEWARD),
				externalId: 'STUDY-ZZ',
			}),
			{ message: 'the store holds no resource STUDY-ZZ' },
		);

		assert.deepEqual(await policySnapshot(client), snapshot);
	});

	test('adds an owner grant with its acceptance, so its holder owns the resource from the commit on', async (context) => {
		const client = await ownerOfFreshDatabase(context);
		const seeded = await seedPolicy(client, OWNED);
		const bo = seededId(seeded.users, 'bo');

		const grantId = await addAcceptedOwner(client, {
			grantedBy: seededId(seeded.users, STEWARD),
			holderUserId: bo,
			resourceId: seededId(seeded.resources, 'STUDY-R2'),
		});
		const decisions = await selected<{
			capabilities: string[];
			decision: string;
			user_id: string;
		}>(
			client,
			`SELECT capabilities, decision, user_id::text FROM ${qualified(grantDecisions)} WHERE grant_id = $1`,
			[grantId],
		);

		assert.equal(
			await liveGrantId(client, {
				category: null,
				holder: 'auth0|bo+test/=',
				resource: 'STUDY-R2',
				role: OWNER_ROLE,
			}),
			grantId,
		);
		assert.deepEqual(decisions, [
			{
				capabilities: [...SEEDED_ROLES.owner.capabilities],
				decision: 'accepted',
				user_id: bo,
			},
		]);
	});
});

suite('reading the store', () => {
	test('reads the externalIds, internal ids, grants, retirement, served set, change records and capabilities the store holds', async (context) => {
		const client = await ownerOfFreshDatabase(context);
		const seeded = await seedPolicy(client, FIXTURE);
		const ana = '0b7c2f1e-5d1a-4c3e-9f2a-6e8d4b1a7c90';

		const internal = await internalIdsInStore(client);

		assert.deepEqual(await storedExternalIds(client), ['STUDY-A1', 'STUDY-C3']);
		assert.equal(await resourceIdOf(client, 'STUDY-A1'), seededId(seeded.resources, 'STUDY-A1'));
		await assert.rejects(resourceIdOf(client, 'STUDY-ZZ'), {
			message: 'the store holds no resource STUDY-ZZ',
		});
		assert.equal(await userIdOf(client, ana), seededId(seeded.users, 'ana'));
		await assert.rejects(userIdOf(client, 'nobody'), {
			message: 'the store holds 0 principals by that subject',
		});
		assert.ok(
			[
				seededId(seeded.users, 'ana'),
				seededId(seeded.resources, 'STUDY-C3'),
				seededId(seeded.roles, 'assembler'),
				seededId(seeded.categories, 'controlled'),
			].every((id) => internal.includes(id.toLowerCase())),
		);
		assert.ok(!internal.includes(seededId(seeded.grants, 'anaViews')));
		assert.equal(await grantCountOn(client, 'STUDY-A1'), 3);
		assert.equal(await grantCountOn(client, 'STUDY-ZZ'), 0);
		assert.equal(await isRetiredInStore(client, 'STUDY-A1'), false);
		assert.deepEqual(await servedByInStore(client, 'STUDY-C3'), [fixtureApplicationId('arranger-test')]);
		assert.equal(await changeRecordCount(client, resources), 2);
		assert.deepEqual(await storedCapabilities(client, ['artifact.create', 'record.view']), [
			{ description: null, displayName: 'create', name: 'artifact.create' },
			{ description: null, displayName: 'view', name: 'record.view' },
		]);
	});
});

suite('a snapshot of the store, and its restore', () => {
	test("takes every table's rows and every sequence's state in one read, writing nothing", async (context) => {
		const client = await ownerOfFreshDatabase(context);
		await seedPolicy(client, FIXTURE);
		const seedingNotices = (await noticesAfter(client)).length;
		await insertNotices(client, [{ kind: 'baseline' }, { kind: 'global' }]);
		const changesBefore = await changeRecordCount(client, resources);

		const snapshot = await takeStoreSnapshot(client);

		assert.ok(
			[
				POLICY_TABLES.changeRecords.name,
				POLICY_TABLES.noticeStream.name,
				POLICY_TABLES.notices.name,
				POLICY_TABLES.userIdentities.name,
				POLICY_TABLES.users.name,
			].every((table) => snapshot.tables.some(({ name }) => name === table)),
		);
		assert.equal(
			(
				JSON.parse(
					snapshot.tables.find(({ name }) => name === POLICY_TABLES.notices.name)?.rows ?? '[]',
				) as unknown[]
			).length,
			seedingNotices + 2,
		);
		assert.ok(snapshot.sequences.some(({ isCalled }) => isCalled));
		assert.equal(await changeRecordCount(client, resources), changesBefore);
	});

	test("puts back every row and every sequence over later changes, firing no trigger, and keeps the snapshot's epoch", async (context) => {
		const client = await ownerOfFreshDatabase(context);
		const seeded = await seedPolicy(client, FIXTURE);
		await insertNotices(client, [{ kind: 'baseline' }, { kind: 'global' }]);
		const policyBefore = await policySnapshot(client);
		const positionsBefore = await noticePositions(client);
		const streamBefore = await readNoticeStream(client);
		const changesBefore = await changeRecordCount(client, resources);
		const snapshot = await takeStoreSnapshot(client);
		await seedPolicy(client, {
			resources: { 'STUDY-D4': { baseTier: 'grant', name: 'D4' } },
		});
		await revokeGrantInStore(client, {
			grantId: seededId(seeded.grants, 'anaViews'),
			revokedBy: seededId(seeded.users, STEWARD),
		});
		await insertNotices(client, [{ kind: 'global' }, { kind: 'baseline' }]);
		await setEpoch(client);
		const policyChanged = await policySnapshot(client);

		await restoreStoreSnapshot(client, snapshot);
		const changesRestored = await changeRecordCount(client, resources);
		await insertNotices(client, [{ kind: 'global' }]);
		await seedPolicy(client, {
			resources: { 'STUDY-E5': { baseTier: 'open', name: 'E5' } },
		});

		assert.notDeepEqual(policyChanged, policyBefore);
		assert.deepEqual(await noticePositions(client), [...positionsBefore, (positionsBefore.at(-1) ?? 0n) + 1n]);
		assert.equal(changesRestored, changesBefore);
		assert.equal(await changeRecordCount(client, resources), changesBefore + 1);
		assert.equal((await readNoticeStream(client)).epoch, streamBefore.epoch);
		assert.deepEqual(await storedExternalIds(client), ['STUDY-A1', 'STUDY-C3', 'STUDY-E5']);
		await restoreStoreSnapshot(client, snapshot);
		assert.deepEqual(await policySnapshot(client), policyBefore);
	});
});

suite("the started store's template", () => {
	test("on its template, a first start writes the key-encryption key's fingerprint and fills the identity provider's record, and nothing else", async (context) => {
		const scope = cleanupFor(context);
		const harness = await startHarness({
			applications: [],
			seedsAdministrator: false,
			startsController: false,
			template: STARTED_STORE_TEMPLATE,
		});
		scope.defer(() => harness.stop());
		const { identityProviderConfiguration, keyFingerprints } = POLICY_TABLES;
		const written = [keyFingerprints, identityProviderConfiguration];
		const before = await takeSnapshot(harness);
		const valuesOf = (snapshot: Awaited<ReturnType<typeof takeSnapshot>>): readonly unknown[] =>
			rowsIn(snapshot, identityProviderConfiguration).map((row) => Reflect.get(row as object, 'value'));

		await harness.startController();

		const after = await takeSnapshot(harness);
		assert.deepEqual(tablesOf(after, written), tablesOf(before, written));
		assert.equal(rowsIn(after, keyFingerprints).length, 1);
		assert.deepEqual(valuesOf(before), Array(6).fill(null));
		assert.equal(valuesOf(after).length, 6);
		assert.equal(valuesOf(after).includes(null), false);
	});

	test("holds permissions-model.md's matrix: the data plane's staircase and submitter beside it, and the control plane's two", () => {
		assert.deepEqual(SEEDED_ROLES, {
			admin: {
				capabilities: [
					'category.create',
					'grant.create',
					'grant.extend',
					'grant.reduce',
					'grant.revoke',
					'grant.view',
					'group.addMember',
					'group.create',
					'group.removeMember',
					'group.update',
					'group.view',
					'invitation.create',
					'ownership.transfer',
					'resource.register',
					'resource.restore',
					'resource.suppress',
					'resource.update',
					'resource.view',
					'role.define',
				],
				plane: 'control',
			},
			curator: {
				capabilities: [
					'record.count',
					'record.create',
					'record.delete',
					'record.export',
					'record.update',
					'record.view',
				],
				plane: 'data',
			},
			editor: {
				capabilities: ['record.count', 'record.create', 'record.export', 'record.update', 'record.view'],
				plane: 'data',
			},
			owner: {
				capabilities: [
					'grant.create',
					'grant.extend',
					'grant.reduce',
					'grant.revoke',
					'grant.view',
					'invitation.create',
					'ownership.transfer',
					'resource.restore',
					'resource.suppress',
					'resource.update',
					'resource.view',
				],
				plane: 'control',
			},
			submitter: {
				capabilities: ['record.create', 'record.update'],
				plane: 'data',
			},
			viewer: {
				capabilities: ['record.count', 'record.export', 'record.view'],
				plane: 'data',
			},
		});
		assert.ok(
			SEEDED_ROLES.owner.capabilities.every((capability) => SEEDED_ROLES.admin.capabilities.includes(capability)),
		);
	});
});

suite("the store's grants and row counts, read", () => {
	test('reads each grant with its people by subject, its resource by externalId and its categories scoped, in the order they were granted', async (context) => {
		const client = await ownerOfFreshDatabase(context);
		const seeded = await seedPolicy(client, FIXTURE);
		const ana = '0b7c2f1e-5d1a-4c3e-9f2a-6e8d4b1a7c90';

		const all = await storedGrants(client);
		const anaViews = (await storedGrants(client, { holder: ana })).find(
			({ id }) => id === seededId(seeded.grants, 'anaViews'),
		);
		const cyViewed = await storedGrants(client, {
			id: seededId(seeded.grants, 'cyViewed'),
		});
		const readers = await storedGrants(client, {
			resource: 'STUDY-A1',
			role: 'viewer',
		});

		assert.equal(all.length, 5);
		assert.equal(all[0]?.id, seededId(seeded.grants, 'cyViewed'));
		assert.deepEqual(
			{ ...anaViews, grantedAt: undefined },
			{
				category: 'global.controlled',
				expiresAt: new Date('2030-01-01T00:00:00Z'),
				fieldCategory: null,
				grantedAt: undefined,
				granterSubject: ana,
				holderIssuer: ISSUER,
				holderSubject: ana,
				id: seededId(seeded.grants, 'anaViews'),
				resource: 'STUDY-A1',
				revokedAt: null,
				revokerSubject: null,
				role: 'viewer',
			},
		);
		assert.deepEqual(
			cyViewed.map(({ revokedAt, revokerSubject }) => ({
				revokedAt,
				revokerSubject,
			})),
			[{ revokedAt: new Date('2026-09-15T12:00:00Z'), revokerSubject: ana }],
		);
		assert.deepEqual(readers.map(({ holderSubject }) => holderSubject).toSorted(), [ana, null].toSorted());
		assert.equal((await storedGrants(client, { holder: 'nobody' })).length, 0);
	});

	test('counts the rows of one table, or of several in one read by the names given', async (context) => {
		const client = await ownerOfFreshDatabase(context);
		await seedPolicy(client, FIXTURE);

		const counts = await rowCounts(client, {
			grants,
			resources,
			users,
		});
		const named = await rowCounts(client, {
			decided: grantDecisions,
			held: grants,
		});

		assert.equal(await rowCountOf(client, grants), 5);
		assert.deepEqual(counts, {
			grants: 5,
			resources: 2,
			users: await rowCountOf(client, users),
		});
		assert.deepEqual(Object.keys(GRANT_WRITTEN_TABLES).toSorted(), [
			'categories',
			'grantDecisions',
			'grants',
			'invitations',
			'notificationOutbox',
			'resources',
			'userIdentities',
			'users',
		]);
		assert.deepEqual(named, {
			decided: await rowCountOf(client, grantDecisions),
			held: 5,
		});
	});

	test("reads a snapshot's tables less those named, and one table's rows parsed", async (context) => {
		const client = await ownerOfFreshDatabase(context);
		await seedPolicy(client, FIXTURE);

		const snapshot = await takeStoreSnapshot(client);
		const without = tablesOf(snapshot, [grants, users]);

		assert.equal(tablesOf(snapshot).length, snapshot.tables.length);
		assert.equal(without.length, snapshot.tables.length - 2);
		assert.ok(without.every(({ name }) => name !== grants.name && name !== users.name));
		assert.equal(rowsIn(snapshot, grants).length, 5);
		assert.deepEqual(rowsIn(snapshot, { name: 'no_such_table' }), []);
	});
});

suite('a fault injected at the store', () => {
	test('fails the Nth insert into a table whoever writes it, counting the inserts of transactions rolled back, and goes once removed', async (context) => {
		const database = await createTestDatabase(STARTED_STORE_TEMPLATE);
		context.after(() => database.close());
		const owner = await database.connect('migration');
		await owner.query(
			`CREATE TABLE usher.fault_probe (n integer); GRANT USAGE ON SCHEMA usher TO ${pg.escapeIdentifier(DATABASE_ROLES.runtime)}; GRANT INSERT ON usher.fault_probe TO ${pg.escapeIdentifier(DATABASE_ROLES.runtime)}`,
		);
		const runtime = await database.connect('runtime');
		const probe = { name: 'fault_probe' };
		const fault = await failNthInsert(cleanupFor(context), owner, probe, 3);
		const inserted = (n: number): Promise<string> =>
			runtime.query('INSERT INTO usher.fault_probe VALUES ($1)', [n]).then(
				() => 'written',
				(error: unknown) => (error instanceof Error ? error.message : 'failed'),
			);

		const first = await inserted(1);
		await runtime.query('BEGIN');
		const rolledBack = await inserted(2);
		await runtime.query('ROLLBACK');
		const third = await inserted(3);
		const fourth = await inserted(4);
		const attempts = await fault.attempts();
		await fault.remove();
		await fault.remove();
		const afterRemoval = await runtime.query('INSERT INTO usher.fault_probe VALUES (5)').then(() => 'written');
		const { rows } = await owner.query<{ n: number }>('SELECT n FROM usher.fault_probe ORDER BY n');
		const left = await owner.query<{ objects: number }>(
			'SELECT count(*)::int AS objects FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1',
			[FAULT_SCHEMA],
		);

		assert.deepEqual(
			{ afterRemoval, first, fourth, rolledBack, third },
			{
				afterRemoval: 'written',
				first: 'written',
				fourth: 'written',
				rolledBack: 'written',
				third: 'a test injected a fault at this insert',
			},
		);
		assert.equal(attempts, 4);
		assert.deepEqual(
			rows.map(({ n }) => n),
			[1, 4, 5],
		);
		assert.equal(left.rows[0]?.objects, 0);
	});
});
