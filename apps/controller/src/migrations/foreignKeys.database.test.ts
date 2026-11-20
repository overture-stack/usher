import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import type pg from 'pg';

import {
	administratorRow,
	BASE_FIXTURE,
	capabilityId,
	committedInsert,
	committedPerson,
	committedQuery,
	decisionRow,
	globalCategoryRow,
	grantRow,
	identityRow,
	insertRow,
	INTEGRITY,
	invitationRow,
	type NamedTable,
	nominationRow,
	noticeRow,
	openSeededDatabase,
	readForeignKeys,
	resourceCategoryRow,
	resourceRow,
	RESTRICTED_DELETE_CODES,
	revocationRow,
	type Row,
	SECOND_ISSUER,
	selectRows,
	stewardOf,
	unheldId,
	userRow,
	writeOutcome,
} from '../../testing/fixtures/database.js';
import {
	declareActor,
	DEFAULT_FIXTURE_ISSUER,
	inTransactionAs,
	inTurn,
	type PolicyFixture,
	POLICY_TABLES,
	qualified,
	seededId,
	SELF_GRANT_NOTIFICATION,
	SYSTEM_ACTOR,
} from '../../testing/harness/policy.js';

const {
	administrators,
	applicationKeys,
	applicationResources,
	applications,
	capabilities,
	categories,
	grantDecisions,
	grants,
	groupUsers,
	groups,
	invitations,
	nominations,
	notices,
	notificationOutbox,
	principalRevocations,
	resourceCategories,
	resourceFieldValues,
	resourceFields,
	resources,
	rolePermissions,
	roles,
	userIdentities,
	users,
} = POLICY_TABLES;

// A delete a referencing key refused, whichever of the two codes the server version gives it.
const REFUSED_BY_ITS_KEY = 'refused by its key';

const WITH_GROUP_AND_FIELD: PolicyFixture = {
	...BASE_FIXTURE,
	fields: { organization: { description: 'Who holds the data' } },
	groups: { readers: { members: ['ana'], resource: 'STUDY-A1' } },
};

/** A foreign key the design names: its table, its columns in key order, and the table they reference. */
const DESIGNED_FOREIGN_KEYS: readonly {
	columns: readonly string[];
	referenced: NamedTable;
	table: NamedTable;
}[] = [
	{
		columns: [administrators.columns.nominationId, administrators.columns.userId],
		referenced: nominations,
		table: administrators,
	},
	{
		columns: [administrators.columns.userId],
		referenced: users,
		table: administrators,
	},
	{
		columns: [applicationKeys.columns.applicationId],
		referenced: applications,
		table: applicationKeys,
	},
	{
		columns: [applicationKeys.columns.issuedBy],
		referenced: users,
		table: applicationKeys,
	},
	{
		columns: [applicationKeys.columns.revokedBy],
		referenced: users,
		table: applicationKeys,
	},
	{
		columns: [applicationResources.columns.applicationId],
		referenced: applications,
		table: applicationResources,
	},
	{
		columns: [applicationResources.columns.resourceId],
		referenced: resources,
		table: applicationResources,
	},
	{
		columns: [applications.columns.registeredBy],
		referenced: users,
		table: applications,
	},
	{
		columns: [categories.columns.resourceId],
		referenced: resources,
		table: categories,
	},
	{
		columns: [grantDecisions.columns.grantId],
		referenced: grants,
		table: grantDecisions,
	},
	{
		columns: [grantDecisions.columns.userId],
		referenced: users,
		table: grantDecisions,
	},
	{
		columns: [grants.columns.fieldCategoryId],
		referenced: categories,
		table: grants,
	},
	{ columns: [grants.columns.grantedBy], referenced: users, table: grants },
	{
		columns: [grants.columns.holderGroupId, grants.columns.resourceId],
		referenced: groups,
		table: grants,
	},
	{ columns: [grants.columns.holderUserId], referenced: users, table: grants },
	{
		columns: [grants.columns.recordCategoryId],
		referenced: categories,
		table: grants,
	},
	{
		columns: [grants.columns.resourceId],
		referenced: resources,
		table: grants,
	},
	{ columns: [grants.columns.revokedBy], referenced: users, table: grants },
	{ columns: [grants.columns.roleId], referenced: roles, table: grants },
	{
		columns: [groupUsers.columns.groupId],
		referenced: groups,
		table: groupUsers,
	},
	{
		columns: [groupUsers.columns.userId],
		referenced: users,
		table: groupUsers,
	},
	{ columns: [groups.columns.createdBy], referenced: users, table: groups },
	{
		columns: [groups.columns.resourceId],
		referenced: resources,
		table: groups,
	},
	{
		columns: [invitations.columns.fieldCategoryId],
		referenced: categories,
		table: invitations,
	},
	{
		columns: [invitations.columns.invitedBy],
		referenced: users,
		table: invitations,
	},
	{
		columns: [invitations.columns.recordCategoryId],
		referenced: categories,
		table: invitations,
	},
	{
		columns: [invitations.columns.resourceId],
		referenced: resources,
		table: invitations,
	},
	{
		columns: [invitations.columns.roleId],
		referenced: roles,
		table: invitations,
	},
	{
		columns: [notices.columns.audience],
		referenced: applications,
		table: notices,
	},
	{
		columns: [notificationOutbox.columns.grantId],
		referenced: grants,
		table: notificationOutbox,
	},
	{
		columns: [notificationOutbox.columns.recipientUserId],
		referenced: users,
		table: notificationOutbox,
	},
	{
		columns: [principalRevocations.columns.liftedBy],
		referenced: users,
		table: principalRevocations,
	},
	{
		columns: [principalRevocations.columns.revokedBy],
		referenced: users,
		table: principalRevocations,
	},
	{
		columns: [principalRevocations.columns.userId],
		referenced: users,
		table: principalRevocations,
	},
	{
		columns: [resourceCategories.columns.categoryId],
		referenced: categories,
		table: resourceCategories,
	},
	{
		columns: [resourceCategories.columns.resourceId],
		referenced: resources,
		table: resourceCategories,
	},
	{
		columns: [resourceFieldValues.columns.fieldId],
		referenced: resourceFields,
		table: resourceFieldValues,
	},
	{
		columns: [resourceFieldValues.columns.resourceId],
		referenced: resources,
		table: resourceFieldValues,
	},
	{
		columns: [resources.columns.registeredBy],
		referenced: users,
		table: resources,
	},
	{
		columns: [resources.columns.retiredBy],
		referenced: users,
		table: resources,
	},
	{
		columns: [nominations.columns.nominatedBy],
		referenced: users,
		table: nominations,
	},
	{
		columns: [nominations.columns.nomineeId],
		referenced: users,
		table: nominations,
	},
	{
		columns: [rolePermissions.columns.capabilityId],
		referenced: capabilities,
		table: rolePermissions,
	},
	{
		columns: [rolePermissions.columns.roleId],
		referenced: roles,
		table: rolePermissions,
	},
	{
		columns: [userIdentities.columns.addedBy],
		referenced: users,
		table: userIdentities,
	},
	{
		columns: [userIdentities.columns.userId],
		referenced: users,
		table: userIdentities,
	},
];

interface ReferenceCase {
	/** The id the reference names when it holds: a row that exists. */
	held: string;

	label: string;

	/** The row to write, naming the given id where the reference is. */
	row: (id: string) => Row;

	table: NamedTable;
}

// The row a case writes with a held reference must be accepted, or a refusal of the missing one
// proves nothing; it is written in a transaction rolled back, so the cases stay independent.
const acceptedThenRolledBack = async (client: pg.ClientBase, table: NamedTable, row: Row): Promise<boolean> => {
	await client.query('BEGIN');
	await declareActor(client, SYSTEM_ACTOR);
	const outcome = await writeOutcome(insertRow(client, table, row));
	await client.query('ROLLBACK');
	return outcome === 'accepted';
};

const rowsWhere = (
	client: pg.ClientBase,
	table: NamedTable,
	conditions: Readonly<Record<string, unknown>>,
): Promise<readonly Row[]> => {
	const entries = Object.entries(conditions);
	return selectRows<Row>(
		client,
		`SELECT * FROM ${qualified(table)} WHERE ${entries.map(([column], index) => `${column} = $${index + 1}`).join(' AND ')}`,
		entries.map(([, value]) => value),
	);
};

suite('foreign keys', () => {
	test('refuses every reference to a row that does not exist', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context, WITH_GROUP_AND_FIELD);
		const steward = stewardOf(seeded);
		const user = (name: string): string => seededId(seeded.users, name);
		const studyA1 = seededId(seeded.resources, 'STUDY-A1');
		const controlled = seededId(seeded.categories, 'controlled');
		const viewer = seededId(seeded.roles, 'viewer');
		const anaViews = seededId(seeded.grants, 'anaViews');
		const readers = seededId(seeded.groups, 'readers');
		const organization = seededId(seeded.fields, 'organization');
		const recordView = await capabilityId(owner, 'record.view');
		const cyGrant = (parts: Partial<Parameters<typeof grantRow>[0]>): Row =>
			grantRow({
				grantedBy: steward,
				holderUserId: user('cy'),
				recordCategoryId: controlled,
				resourceId: studyA1,
				roleId: viewer,
				...parts,
			});
		const toCy = (parts: Partial<Parameters<typeof invitationRow>[0]>): Row =>
			invitationRow({
				email: 'cy@example.org',
				invitedBy: steward,
				recordCategoryId: controlled,
				resourceId: studyA1,
				roleId: viewer,
				...parts,
			});
		const cyNominated = String(
			(await committedInsert(owner, nominations, nominationRow({ nominatedBy: steward, nomineeId: user('cy') })))[
				nominations.columns.id
			],
		);
		const lyric = seededId(seeded.applications, 'ims-lyric');
		const lyricKey = (parts: Readonly<Record<string, string>>): Row => ({
			[applicationKeys.columns.applicationId]: lyric,
			[applicationKeys.columns.encryptedKey]: randomBytes(60),
			[applicationKeys.columns.id]: randomUUID(),
			[applicationKeys.columns.issuedAt]: new Date(),
			[applicationKeys.columns.issuedBy]: steward,
			...parts,
		});
		const cases: readonly ReferenceCase[] = [
			{
				held: cyNominated,
				label: "an administrator's nomination",
				row: (id) => administratorRow({ nominationId: id, userId: user('cy') }),
				table: administrators,
			},
			{
				held: user('cy'),
				label: "an administrator's person, the nominee of the nomination accepted",
				row: (id) => administratorRow({ nominationId: cyNominated, userId: id }),
				table: administrators,
			},
			{
				held: steward,
				label: "a nomination's nominator",
				row: (id) =>
					nominationRow({
						nominatedAt: new Date(Date.now() + 1000),
						nominatedBy: id,
						nomineeId: user('cy'),
					}),
				table: nominations,
			},
			{
				held: user('bo'),
				label: "a nomination's nominee",
				row: (id) =>
					nominationRow({
						nominatedAt: new Date(Date.now() + 2000),
						nominatedBy: steward,
						nomineeId: id,
					}),
				table: nominations,
			},
			{
				held: lyric,
				label: "a key's application",
				row: (id) => lyricKey({ [applicationKeys.columns.applicationId]: id }),
				table: applicationKeys,
			},
			{
				held: steward,
				label: "a key's issuer",
				row: (id) => lyricKey({ [applicationKeys.columns.issuedBy]: id }),
				table: applicationKeys,
			},
			{
				held: steward,
				label: "a key's revoker",
				row: (id) => ({
					...lyricKey({ [applicationKeys.columns.revokedBy]: id }),
					[applicationKeys.columns.revokedAt]: new Date(),
				}),
				table: applicationKeys,
			},
			{
				held: lyric,
				label: 'served by an application',
				row: (id) => ({
					[applicationResources.columns.applicationId]: id,
					[applicationResources.columns.resourceId]: seededId(seeded.resources, 'STUDY-B2'),
				}),
				table: applicationResources,
			},
			{
				held: seededId(seeded.resources, 'study.c_3'),
				label: 'a served resource',
				row: (id) => ({
					[applicationResources.columns.applicationId]: lyric,
					[applicationResources.columns.resourceId]: id,
				}),
				table: applicationResources,
			},
			{
				held: steward,
				label: 'an application registrar',
				row: (id) => ({
					[applications.columns.displayName]: 'Song',
					[applications.columns.id]: randomUUID(),
					[applications.columns.registeredAt]: new Date(),
					[applications.columns.registeredBy]: id,
				}),
				table: applications,
			},
			{
				held: studyA1,
				label: "a resource category's resource",
				row: (id) => resourceCategoryRow('cohort', id),
				table: categories,
			},
			{
				held: anaViews,
				label: 'the grant a decision answers',
				row: (id) =>
					decisionRow({
						decision: 'rejected',
						grantId: id,
						userId: user('ana'),
					}),
				table: grantDecisions,
			},
			{
				held: user('ana'),
				label: 'the person deciding',
				row: (id) => decisionRow({ decision: 'rejected', grantId: anaViews, userId: id }),
				table: grantDecisions,
			},
			{
				held: seededId(seeded.categories, 'unmarked'),
				label: "a grant's field category",
				row: (id) => cyGrant({ fieldCategoryId: id }),
				table: grants,
			},
			{
				held: steward,
				label: 'a granter',
				row: (id) => cyGrant({ grantedBy: id }),
				table: grants,
			},
			{
				held: readers,
				label: 'a holding group',
				row: (id) =>
					grantRow({
						grantedBy: steward,
						holderGroupId: id,
						recordCategoryId: controlled,
						resourceId: studyA1,
						roleId: viewer,
					}),
				table: grants,
			},
			{
				held: user('cy'),
				label: 'a holding person',
				row: (id) => cyGrant({ holderUserId: id }),
				table: grants,
			},
			{
				held: controlled,
				label: "a grant's record category",
				row: (id) => cyGrant({ recordCategoryId: id }),
				table: grants,
			},
			{
				held: studyA1,
				label: "a grant's resource",
				row: (id) => cyGrant({ resourceId: id }),
				table: grants,
			},
			{
				held: steward,
				label: 'a revoker of a grant',
				row: (id) => cyGrant({ revoked: { at: new Date(), by: id } }),
				table: grants,
			},
			{
				held: viewer,
				label: "a grant's role",
				row: (id) => cyGrant({ roleId: id }),
				table: grants,
			},
			{
				held: readers,
				label: 'the group a member joins',
				row: (id) => ({
					[groupUsers.columns.groupId]: id,
					[groupUsers.columns.userId]: user('cy'),
				}),
				table: groupUsers,
			},
			{
				held: user('cy'),
				label: 'a group member',
				row: (id) => ({
					[groupUsers.columns.groupId]: readers,
					[groupUsers.columns.userId]: id,
				}),
				table: groupUsers,
			},
			{
				held: steward,
				label: 'a group creator',
				row: (id) => ({
					[groups.columns.createdAt]: new Date(),
					[groups.columns.createdBy]: id,
					[groups.columns.name]: 'curators',
					[groups.columns.resourceId]: studyA1,
				}),
				table: groups,
			},
			{
				held: studyA1,
				label: "a group's resource",
				row: (id) => ({
					[groups.columns.createdAt]: new Date(),
					[groups.columns.createdBy]: steward,
					[groups.columns.name]: 'curators',
					[groups.columns.resourceId]: id,
				}),
				table: groups,
			},
			{
				held: seededId(seeded.categories, 'unmarked'),
				label: "an invitation's field category",
				row: (id) => toCy({ fieldCategoryId: id }),
				table: invitations,
			},
			{
				held: steward,
				label: 'an inviter',
				row: (id) => toCy({ invitedBy: id }),
				table: invitations,
			},
			{
				held: controlled,
				label: "an invitation's record category",
				row: (id) => toCy({ recordCategoryId: id }),
				table: invitations,
			},
			{
				held: studyA1,
				label: "an invitation's resource",
				row: (id) => toCy({ resourceId: id }),
				table: invitations,
			},
			{
				held: viewer,
				label: "an invitation's role",
				row: (id) => toCy({ roleId: id }),
				table: invitations,
			},
			{
				held: lyric,
				label: "a servedResources notice's audience",
				row: (id) => noticeRow({ audience: id, kind: 'servedResources' }),
				table: notices,
			},
			{
				held: anaViews,
				label: "an outbox row's grant",
				row: (id) => ({
					[notificationOutbox.columns.createdAt]: new Date(),
					[notificationOutbox.columns.grantId]: id,
					[notificationOutbox.columns.kind]: SELF_GRANT_NOTIFICATION,
					[notificationOutbox.columns.recipientUserId]: user('bo'),
				}),
				table: notificationOutbox,
			},
			{
				held: user('bo'),
				label: "an outbox row's recipient",
				row: (id) => ({
					[notificationOutbox.columns.createdAt]: new Date(),
					[notificationOutbox.columns.grantId]: anaViews,
					[notificationOutbox.columns.kind]: SELF_GRANT_NOTIFICATION,
					[notificationOutbox.columns.recipientUserId]: id,
				}),
				table: notificationOutbox,
			},
			{
				held: steward,
				label: 'a lifter',
				row: (id) =>
					revocationRow({
						lifted: { at: new Date(), by: id },
						revokedBy: steward,
						userId: user('cy'),
					}),
				table: principalRevocations,
			},
			{
				held: steward,
				label: 'a revoker of a principal',
				row: (id) => revocationRow({ revokedBy: id, userId: user('cy') }),
				table: principalRevocations,
			},
			{
				held: user('cy'),
				label: 'a principal revoked',
				row: (id) => revocationRow({ revokedBy: steward, userId: id }),
				table: principalRevocations,
			},
			{
				held: seededId(seeded.categories, 'controlled'),
				label: 'an offered category',
				row: (id) => ({
					[resourceCategories.columns.categoryId]: id,
					[resourceCategories.columns.resourceId]: seededId(seeded.resources, 'STUDY-B2'),
				}),
				table: resourceCategories,
			},
			{
				held: seededId(seeded.resources, 'STUDY-B2'),
				label: 'an offering resource',
				row: (id) => ({
					[resourceCategories.columns.categoryId]: controlled,
					[resourceCategories.columns.resourceId]: id,
				}),
				table: resourceCategories,
			},
			{
				held: organization,
				label: "a value's field",
				row: (id) => ({
					[resourceFieldValues.columns.fieldId]: id,
					[resourceFieldValues.columns.resourceId]: studyA1,
					[resourceFieldValues.columns.value]: 'Institut Exemple du Sud',
				}),
				table: resourceFieldValues,
			},
			{
				held: studyA1,
				label: "a value's resource",
				row: (id) => ({
					[resourceFieldValues.columns.fieldId]: organization,
					[resourceFieldValues.columns.resourceId]: id,
					[resourceFieldValues.columns.value]: 'Institut Exemple du Sud',
				}),
				table: resourceFieldValues,
			},
			{
				held: steward,
				label: 'a resource registrar',
				row: (id) => resourceRow('STUDY-J1', id),
				table: resources,
			},
			{
				held: steward,
				label: 'a resource retirer',
				row: (id) => ({
					...resourceRow('STUDY-J1', steward),
					[resources.columns.retiredAt]: new Date(),
					[resources.columns.retiredBy]: id,
				}),
				table: resources,
			},
			{
				held: await capabilityId(owner, 'record.create'),
				label: "a permission's capability",
				row: (id) => ({
					[rolePermissions.columns.capabilityId]: id,
					[rolePermissions.columns.roleId]: viewer,
				}),
				table: rolePermissions,
			},
			{
				held: seededId(seeded.roles, 'submitter'),
				label: "a permission's role",
				row: (id) => ({
					[rolePermissions.columns.capabilityId]: recordView,
					[rolePermissions.columns.roleId]: id,
				}),
				table: rolePermissions,
			},
			{
				held: user('cy'),
				label: "an identity's person",
				row: (id) => identityRow(id, 'identity-of-a-person', SECOND_ISSUER),
				table: userIdentities,
			},
			{
				held: steward,
				label: 'who added an identity',
				row: (id) => identityRow(user('cy'), 'identity-added-by', SECOND_ISSUER, id),
				table: userIdentities,
			},
		];

		const outcomes = await inTurn(cases, async ({ held, label, row, table }) => ({
			acceptedWhenHeld: await acceptedThenRolledBack(owner, table, row(held)),
			label,
			missingRefusedAs: await writeOutcome(committedInsert(owner, table, row(unheldId()))),
		}));

		assert.deepEqual(
			outcomes,
			cases.map(({ label }) => ({
				acceptedWhenHeld: true,
				label,
				missingRefusedAs: INTEGRITY.foreignKey,
			})),
		);
	});

	test('restricts deletion on every foreign key', async (context) => {
		const { owner } = await openSeededDatabase(context);

		const foreignKeys = await readForeignKeys(owner);

		assert.deepEqual(
			DESIGNED_FOREIGN_KEYS.filter(
				({ columns, referenced, table }) =>
					!foreignKeys.some(
						(key) =>
							key.table === table.name &&
							key.referenced === referenced.name &&
							key.columns === columns.join(','),
					),
			).map(({ columns, table }) => `${table.name} (${columns.join(', ')})`),
			[],
		);
		assert.deepEqual(
			foreignKeys.filter(({ onDelete }) => onDelete !== 'r').map(({ columns, table }) => `${table} (${columns})`),
			[],
		);
	});

	test('keeps a referenced principal, role, capability, global category or application in place', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context);
		const steward = stewardOf(seeded);
		const studyA1 = seededId(seeded.resources, 'STUDY-A1');
		const studyB2 = seededId(seeded.resources, 'STUDY-B2');
		const unmarked = seededId(seeded.categories, 'unmarked');
		const viewer = seededId(seeded.roles, 'viewer');
		const anaViews = seededId(seeded.grants, 'anaViews');
		const newUser = (subject: string): Promise<string> => committedPerson(owner, subject);
		const newRole = async (name: string): Promise<string> =>
			String(
				(
					await committedInsert(owner, roles, {
						[roles.columns.name]: name,
						[roles.columns.plane]: 'data',
					})
				)[roles.columns.id],
			);
		const newCategory = async (name: string): Promise<string> =>
			String((await committedInsert(owner, categories, globalCategoryRow(name)))[categories.columns.id]);
		const newApplication = async (displayName: string): Promise<string> => {
			const id = randomUUID();
			await committedInsert(owner, applications, {
				[applications.columns.displayName]: displayName,
				[applications.columns.id]: id,
				[applications.columns.registeredAt]: new Date(),
				[applications.columns.registeredBy]: steward,
			});
			return id;
		};
		const kept = (table: NamedTable, row: Row): Promise<readonly Row[]> => rowsWhere(owner, table, row);
		// The person's own identity goes first, in the same transaction, so a refusal is the case's
		// reference alone.
		const userDelete = (id: string): Promise<unknown> =>
			inTransactionAs(owner, SYSTEM_ACTOR, async () => {
				await owner.query(
					`DELETE FROM ${qualified(userIdentities)} WHERE ${userIdentities.columns.userId} = $1`,
					[id],
				);
				await owner.query(`DELETE FROM ${qualified(users)} WHERE ${users.columns.id} = $1`, [id]);
			});
		const roleDelete = (id: string): Promise<unknown> =>
			committedQuery(owner, `DELETE FROM ${qualified(roles)} WHERE ${roles.columns.id} = $1`, [id]);
		const categoryDelete = (id: string): Promise<unknown> =>
			committedQuery(owner, `DELETE FROM ${qualified(categories)} WHERE ${categories.columns.id} = $1`, [id]);
		const applicationDelete = (id: string): Promise<unknown> =>
			committedQuery(owner, `DELETE FROM ${qualified(applications)} WHERE ${applications.columns.id} = $1`, [id]);
		const byId = (
			table: NamedTable & { columns: { id: string } },
			row: Row,
		): Readonly<Record<string, unknown>> => ({
			[table.columns.id]: row[table.columns.id],
		});

		const cases: readonly {
			arrange: () => Promise<{
				attempt: () => Promise<unknown>;
				reference: () => Promise<readonly Row[]>;
			}>;
			label: string;
		}[] = [
			{
				arrange: async () => {
					const target = await newUser('referenced-as-holder');
					const grant = await committedInsert(
						owner,
						grants,
						grantRow({
							grantedBy: steward,
							holderUserId: target,
							recordCategoryId: unmarked,
							resourceId: studyA1,
							roleId: viewer,
						}),
					);
					return {
						attempt: () => userDelete(target),
						reference: () => kept(grants, byId(grants, grant)),
					};
				},
				label: 'a principal as holder',
			},
			{
				arrange: async () => {
					const target = await newUser('referenced-as-granter');
					const grant = await committedInsert(
						owner,
						grants,
						grantRow({
							grantedBy: target,
							holderUserId: seededId(seeded.users, 'cy'),
							recordCategoryId: unmarked,
							resourceId: studyB2,
							roleId: viewer,
						}),
					);
					return {
						attempt: () => userDelete(target),
						reference: () => kept(grants, byId(grants, grant)),
					};
				},
				label: 'a principal as granter',
			},
			{
				arrange: async () => {
					const target = await newUser('referenced-as-revoker');
					const grant = await committedInsert(
						owner,
						grants,
						grantRow({
							grantedBy: steward,
							holderUserId: seededId(seeded.users, 'cy'),
							recordCategoryId: unmarked,
							resourceId: seededId(seeded.resources, 'study.c_3'),
							revoked: { at: new Date(), by: target },
							roleId: viewer,
						}),
					);
					return {
						attempt: () => userDelete(target),
						reference: () => kept(grants, byId(grants, grant)),
					};
				},
				label: 'a principal as revoker',
			},
			{
				arrange: async () => {
					const target = await newUser('referenced-as-decider');
					const decision = await committedInsert(
						owner,
						grantDecisions,
						decisionRow({
							decision: 'rejected',
							grantId: anaViews,
							userId: target,
						}),
					);
					return {
						attempt: () => userDelete(target),
						reference: () => kept(grantDecisions, byId(grantDecisions, decision)),
					};
				},
				label: 'a principal as decider',
			},
			{
				arrange: async () => {
					const target = await newUser('referenced-as-revoked');
					const revocation = await committedInsert(
						owner,
						principalRevocations,
						revocationRow({ revokedBy: steward, userId: target }),
					);
					return {
						attempt: () => userDelete(target),
						reference: () => kept(principalRevocations, byId(principalRevocations, revocation)),
					};
				},
				label: 'a principal as the one revoked',
			},
			{
				arrange: async () => {
					const target = await newUser('referenced-as-lifter');
					const revocation = await committedInsert(
						owner,
						principalRevocations,
						revocationRow({
							lifted: { at: new Date(), by: target },
							revokedBy: steward,
							userId: seededId(seeded.users, 'bo'),
						}),
					);
					return {
						attempt: () => userDelete(target),
						reference: () => kept(principalRevocations, byId(principalRevocations, revocation)),
					};
				},
				label: 'a principal as lifter',
			},
			{
				arrange: async () => {
					const target = await newUser('referenced-as-registrar');
					const resource = await committedInsert(owner, resources, resourceRow('STUDY-R1', target));
					return {
						attempt: () => userDelete(target),
						reference: () => kept(resources, byId(resources, resource)),
					};
				},
				label: 'a principal as resource registrar',
			},
			{
				arrange: async () => {
					const target = await newUser('referenced-as-application-registrar');
					const registered = await committedInsert(owner, applications, {
						[applications.columns.displayName]: 'Registered',
						[applications.columns.id]: randomUUID(),
						[applications.columns.registeredAt]: new Date(),
						[applications.columns.registeredBy]: target,
					});
					return {
						attempt: () => userDelete(target),
						reference: () => kept(applications, byId(applications, registered)),
					};
				},
				label: 'a principal as application registrar',
			},
			{
				arrange: async () => {
					const target = await newUser('referenced-as-inviter');
					const invitation = await committedInsert(
						owner,
						invitations,
						invitationRow({
							email: 'invited@example.org',
							invitedBy: target,
							recordCategoryId: unmarked,
							resourceId: studyA1,
							roleId: viewer,
						}),
					);
					return {
						attempt: () => userDelete(target),
						reference: () => kept(invitations, byId(invitations, invitation)),
					};
				},
				label: 'a principal as inviter',
			},
			{
				arrange: async () => {
					const target = await newUser('referenced-as-group-creator');
					const group = await committedInsert(owner, groups, {
						[groups.columns.createdAt]: new Date(),
						[groups.columns.createdBy]: target,
						[groups.columns.name]: 'creators',
						[groups.columns.resourceId]: studyA1,
					});
					return {
						attempt: () => userDelete(target),
						reference: () => kept(groups, byId(groups, group)),
					};
				},
				label: 'a principal as group creator',
			},
			{
				arrange: async () => {
					const target = await newRole('granted-role');
					const grant = await committedInsert(
						owner,
						grants,
						grantRow({
							grantedBy: steward,
							holderUserId: seededId(seeded.users, 'ana'),
							recordCategoryId: unmarked,
							resourceId: studyB2,
							roleId: target,
						}),
					);
					return {
						attempt: () => roleDelete(target),
						reference: () => kept(grants, byId(grants, grant)),
					};
				},
				label: 'a role by a grant',
			},
			{
				arrange: async () => {
					const target = await newRole('invited-role');
					const invitation = await committedInsert(
						owner,
						invitations,
						invitationRow({
							email: 'role@example.org',
							invitedBy: steward,
							recordCategoryId: unmarked,
							resourceId: studyA1,
							roleId: target,
						}),
					);
					return {
						attempt: () => roleDelete(target),
						reference: () => kept(invitations, byId(invitations, invitation)),
					};
				},
				label: 'a role by an invitation',
			},
			{
				arrange: async () => {
					const target = await newRole('permitted-role');
					const recordView = await capabilityId(owner, 'record.view');
					const pairing = {
						[rolePermissions.columns.capabilityId]: recordView,
						[rolePermissions.columns.roleId]: target,
					};
					await committedInsert(owner, rolePermissions, pairing);
					return {
						attempt: () => roleDelete(target),
						reference: () => kept(rolePermissions, pairing),
					};
				},
				label: 'a role by a permission',
			},
			{
				arrange: async () => {
					const target = String(
						(
							await committedInsert(owner, capabilities, {
								[capabilities.columns.action]: 'probe',
								[capabilities.columns.displayName]: 'Probe records',
								[capabilities.columns.entity]: 'record',
								[capabilities.columns.plane]: 'data',
							})
						)[capabilities.columns.id],
					);
					const pairing = {
						[rolePermissions.columns.capabilityId]: target,
						[rolePermissions.columns.roleId]: viewer,
					};
					await committedInsert(owner, rolePermissions, pairing);
					return {
						attempt: () =>
							committedQuery(
								owner,
								`DELETE FROM ${qualified(capabilities)} WHERE ${capabilities.columns.id} = $1`,
								[target],
							),
						reference: () => kept(rolePermissions, pairing),
					};
				},
				label: 'a capability by a permission',
			},
			{
				arrange: async () => {
					const target = await newCategory('granted-category');
					const grant = await committedInsert(
						owner,
						grants,
						grantRow({
							grantedBy: steward,
							holderUserId: seededId(seeded.users, 'bo'),
							recordCategoryId: target,
							resourceId: studyB2,
							roleId: viewer,
						}),
					);
					return {
						attempt: () => categoryDelete(target),
						reference: () => kept(grants, byId(grants, grant)),
					};
				},
				label: 'a global category by a grant',
			},
			{
				arrange: async () => {
					const target = await newCategory('invited-category');
					const invitation = await committedInsert(
						owner,
						invitations,
						invitationRow({
							email: 'category@example.org',
							invitedBy: steward,
							recordCategoryId: target,
							resourceId: studyA1,
							roleId: viewer,
						}),
					);
					return {
						attempt: () => categoryDelete(target),
						reference: () => kept(invitations, byId(invitations, invitation)),
					};
				},
				label: 'a global category by an invitation',
			},
			{
				arrange: async () => {
					const target = await newCategory('offered-category');
					const offering = {
						[resourceCategories.columns.categoryId]: target,
						[resourceCategories.columns.resourceId]: studyB2,
					};
					await committedInsert(owner, resourceCategories, offering);
					return {
						attempt: () => categoryDelete(target),
						reference: () => kept(resourceCategories, offering),
					};
				},
				label: 'a global category by an offering',
			},
			{
				arrange: async () => {
					const target = await newApplication('ims-serving');
					const serving = {
						[applicationResources.columns.applicationId]: target,
						[applicationResources.columns.resourceId]: studyB2,
					};
					await committedInsert(owner, applicationResources, serving);
					return {
						attempt: () => applicationDelete(target),
						reference: () => kept(applicationResources, serving),
					};
				},
				label: 'an application by its served set',
			},
			{
				arrange: async () => {
					const target = await newApplication('ims-notified');
					const notice = await committedInsert(
						owner,
						notices,
						noticeRow({ audience: target, kind: 'servedResources' }),
					);
					return {
						attempt: () => applicationDelete(target),
						reference: () =>
							kept(notices, {
								[notices.columns.position]: notice[notices.columns.position],
							}),
					};
				},
				label: 'an application by a servedResources notice',
			},
			{
				arrange: async () => {
					const target = await newUser('referenced-as-identity-holder');
					return {
						attempt: () =>
							committedQuery(owner, `DELETE FROM ${qualified(users)} WHERE ${users.columns.id} = $1`, [
								target,
							]),
						reference: () =>
							kept(userIdentities, {
								[userIdentities.columns.userId]: target,
							}),
					};
				},
				label: "a principal as an identity's holder",
			},
			{
				arrange: async () => {
					const target = await newUser('referenced-as-identity-adder');
					const identity = await inTransactionAs(owner, SYSTEM_ACTOR, async () => {
						const person = await insertRow(owner, users, userRow());
						return insertRow(
							owner,
							userIdentities,
							identityRow(
								String(person[users.columns.id]),
								'identity-added-by-a-target',
								DEFAULT_FIXTURE_ISSUER,
								target,
							),
						);
					});
					return {
						attempt: () => userDelete(target),
						reference: () => kept(userIdentities, byId(userIdentities, identity)),
					};
				},
				label: 'a principal as who added an identity',
			},
		];

		const outcomes = await inTurn(cases, async ({ arrange, label }) => {
			const { attempt, reference } = await arrange();
			const before = await reference();
			const outcome = await writeOutcome(attempt());
			return {
				kept: before.length === 1 && JSON.stringify(await reference()) === JSON.stringify(before),
				label,
				outcome: RESTRICTED_DELETE_CODES.has(outcome) ? REFUSED_BY_ITS_KEY : outcome,
			};
		});

		assert.deepEqual(
			outcomes,
			cases.map(({ label }) => ({
				kept: true,
				label,
				outcome: REFUSED_BY_ITS_KEY,
			})),
		);
	});
});
