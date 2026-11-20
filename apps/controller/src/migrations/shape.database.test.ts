import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import { USHER_SCHEMA } from '../../testing/harness/database.js';
import {
	administratorRow,
	auditEntryRow,
	BASE_FIXTURE,
	checksOn,
	connectInTimeZone,
	decisionRow,
	grantRow,
	identityRow,
	insertRow,
	invitationRow,
	nominationRow,
	noticeRow,
	openDatabase,
	openSeededDatabase,
	readColumns,
	resourceRow,
	revocationRow,
	SECOND_ISSUER,
	selectRows,
	shapeProblems,
	stewardOf,
	userRow,
} from '../../testing/fixtures/database.js';
import {
	DEFAULT_FIXTURE_ISSUER,
	GRANT_OPERATIONS,
	inTransactionAs,
	inTurn,
	NOTICE_KINDS,
	type PolicyFixture,
	POLICY_TABLES,
	qualified,
	seededId,
	SELF_GRANT_NOTIFICATION,
	SELF_GRANT_REQUEST,
	SYSTEM_ACTOR,
} from '../../testing/harness/policy.js';

const {
	administrators,
	applicationKeys,
	applications,
	auditLog,
	capabilities,
	categories,
	changeRecords,
	exchangedSids,
	globalRevocations,
	grantDecisions,
	grantRequests,
	grants,
	groups,
	invitations,
	keyFingerprints,
	nominations,
	notices,
	notificationOutbox,
	principalRevocations,
	resources,
	roles,
	identityProviderConfiguration,
	settings,
	schemaMigrations,
	sidSignOuts,
	subjectSignOuts,
	usedChannelAssertions,
	userIdentities,
	users,
} = POLICY_TABLES;

const VERSION_4_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const UUID_KEYED_TABLES = [
	applicationKeys,
	applications,
	auditLog,
	capabilities,
	categories,
	changeRecords,
	globalRevocations,
	grantDecisions,
	GRANT_OPERATIONS,
	grantRequests,
	grants,
	groups,
	invitations,
	nominations,
	notificationOutbox,
	principalRevocations,
	POLICY_TABLES.resourceFields,
	resources,
	roles,
	userIdentities,
	users,
].map(({ name }) => name);

// Two rows in each table keyed by a generated uuid, none of them given an id. Seeding gives an
// application the id derived from its label, so the test writes its two applications itself.
const TWO_OF_EACH: PolicyFixture = {
	...BASE_FIXTURE,
	applications: {},
	decisions: [
		{ decision: 'accepted', grant: 'anaViews' },
		{ decision: 'accepted', grant: 'boOwns' },
	],
	fields: {
		funder: { description: 'Who funds the study' },
		organization: { description: 'Who holds the data' },
	},
	groups: {
		curators: { members: ['cy'], resource: 'STUDY-A1' },
		readers: { members: ['ana'], resource: 'STUDY-A1' },
	},
	revocations: [
		{ lifted: {}, reason: 'account reported compromised', user: 'cy' },
		{ reason: 'account reported compromised', user: 'cy' },
	],
};

// Toronto holds the hour from 01:00 twice on 2026-11-01, as daylight saving time ends; with the
// -04:00 offset, a minute of it is the first of the two, at 05:mm UTC. Each column gets its own
// minute, in the order the times occur, so no check of one time against another is crossed.
const inRepeatedHour = (minute: number): string => `2026-11-01T01:${String(minute).padStart(2, '0')}:00-04:00`;

const secondsSinceEpoch = (minute: number): number =>
	Date.parse(`2026-11-01T05:${String(minute).padStart(2, '0')}:00Z`) / 1000;

// The times the store writes itself, which no caller gives: a change record's, an applied migration's and the
// seed row's, each stamped by the store's own clock when the store writes it.
const WRITTEN_BY_THE_STORE: ReadonlySet<string> = new Set([
	`${changeRecords.name}.${changeRecords.columns.recordedAt}`,
	`${schemaMigrations.name}.${schemaMigrations.columns.appliedAt}`,
	'settings_seed.seeded_at',
]);

const TIME_TYPES = new Set([
	'date',
	'time with time zone',
	'time without time zone',
	'timestamp with time zone',
	'timestamp without time zone',
]);

interface TimeProbe {
	/** Each time column written, and the minute of the repeated hour written to it. */
	columns: readonly (readonly [string, number])[];

	key: string;
	keyValue: unknown;
	table: { name: string };
}

suite("the schema's shape", () => {
	test('holds every table and column the design names, with its type and nullability', async (context) => {
		const database = await openDatabase(context);
		const owner = await database.connect('migration');

		const problems = await shapeProblems(owner);

		assert.deepEqual(problems, []);
	});

	test('generates every uuid identifier in the database', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context, TWO_OF_EACH);
		const steward = stewardOf(seeded);
		const grantId = seededId(seeded.grants, 'anaViews');
		await inTransactionAs(owner, SYSTEM_ACTOR, async () => {
			const written = await inTurn(['Search portal', 'File index'], (name) =>
				insertRow(owner, applications, {
					[applications.columns.displayName]: name,
					[applications.columns.registeredAt]: new Date(),
					[applications.columns.registeredBy]: steward,
				}),
			);
			await inTurn(written, (application) =>
				insertRow(owner, applicationKeys, {
					[applicationKeys.columns.applicationId]: application[applications.columns.id] ?? null,
					[applicationKeys.columns.encryptedKey]: randomBytes(60),
					[applicationKeys.columns.issuedAt]: new Date(),
					[applicationKeys.columns.issuedBy]: steward,
				}),
			);
			await inTurn(['ana@example.org', 'bo@example.org'], (email) =>
				insertRow(
					owner,
					invitations,
					invitationRow({
						email,
						invitedBy: steward,
						recordCategoryId: seededId(seeded.categories, 'controlled'),
						resourceId: seededId(seeded.resources, 'STUDY-A1'),
						roleId: seededId(seeded.roles, 'viewer'),
					}),
				),
			);
			await inTurn(['securityIncident', 'keyCompromise'], (reasonCode) =>
				insertRow(owner, globalRevocations, {
					[globalRevocations.columns.reasonCode]: reasonCode,
					[globalRevocations.columns.revokedAt]: new Date(),
					[globalRevocations.columns.revokedBy]: steward,
				}),
			);
			await inTurn([1, 2], (days) =>
				insertRow(owner, grantRequests, {
					[grantRequests.columns.capabilities]: ['record.view'],
					[grantRequests.columns.expiresAt]: new Date(Date.now() + days * 86_400_000),
					[grantRequests.columns.holderUserId]: seededId(seeded.users, 'cy'),
					[grantRequests.columns.kind]: SELF_GRANT_REQUEST,
					[grantRequests.columns.recordCategoryId]: seededId(seeded.categories, 'controlled'),
					[grantRequests.columns.requestedAt]: new Date(),
					[grantRequests.columns.requestedBy]: seededId(seeded.users, 'cy'),
					[grantRequests.columns.resourceId]: seededId(seeded.resources, 'STUDY-A1'),
					[grantRequests.columns.roleId]: seededId(seeded.roles, 'viewer'),
				}),
			);
			await insertRow(owner, auditLog, auditEntryRow({ grantId }));
			await insertRow(owner, auditLog, auditEntryRow({ grantId: steward }));
			await inTurn(
				[
					{ at: new Date(Date.now() - 1000), name: 'bo' },
					{ at: new Date(), name: 'cy' },
				],
				({ at, name }) =>
					insertRow(
						owner,
						nominations,
						nominationRow({
							nominatedAt: at,
							nominatedBy: steward,
							nomineeId: seededId(seeded.users, name),
						}),
					),
			);
			await inTurn(['bo', 'cy'], (name) =>
				insertRow(owner, notificationOutbox, {
					[notificationOutbox.columns.createdAt]: new Date(),
					[notificationOutbox.columns.deliveredAt]: null,
					[notificationOutbox.columns.grantId]: grantId,
					[notificationOutbox.columns.kind]: SELF_GRANT_NOTIFICATION,
					[notificationOutbox.columns.recipientUserId]: seededId(seeded.users, name),
				}),
			);
			await inTurn(['subject-ana', 'subject-bo'], (subject) =>
				insertRow(owner, GRANT_OPERATIONS, {
					[GRANT_OPERATIONS.columns.expiresAt]: new Date(Date.now() + 60_000),
					[GRANT_OPERATIONS.columns.idpIssuer]: DEFAULT_FIXTURE_ISSUER,
					[GRANT_OPERATIONS.columns.idpSubjectId]: subject,
					[GRANT_OPERATIONS.columns.occurredAt]: new Date(),
				}),
			);
		});

		const keyedByUuid = (await readColumns(owner))
			.filter(({ column, type }) => column === 'id' && type === 'uuid')
			.map(({ table }) => table);
		const identifiers = await inTurn(keyedByUuid, async (table) => {
			const ids = (
				await selectRows<{ id: string }>(owner, `SELECT id::text AS id FROM ${qualified({ name: table })}`)
			).map(({ id }) => id);
			return {
				distinct: new Set(ids).size === ids.length,
				enough: ids.length >= 2,
				table,
				versionFour: ids.every((id) => VERSION_4_UUID.test(id)),
			};
		});

		assert.deepEqual(
			UUID_KEYED_TABLES.filter((table) => !keyedByUuid.includes(table)),
			[],
		);
		assert.deepEqual(
			identifiers,
			keyedByUuid.map((table) => ({
				distinct: true,
				enough: true,
				table,
				versionFour: true,
			})),
		);
	});

	test('stores every time as an instant, read alike in any session time zone', async (context) => {
		const { database, seeded } = await openSeededDatabase(context);
		const toronto = await connectInTimeZone(database, 'migration', 'America/Toronto');
		const steward = stewardOf(seeded);
		const resourceId = seededId(seeded.resources, 'STUDY-A1');
		const roleId = seededId(seeded.roles, 'viewer');
		const categoryId = seededId(seeded.categories, 'controlled');
		const timed = (columns: readonly (readonly [string, number])[]): Readonly<Record<string, string>> =>
			Object.fromEntries(columns.map(([column, minute]) => [column, inRepeatedHour(minute)]));
		const times = {
			administrators: [[administrators.columns.acceptedAt, 13]],
			applicationKeys: [
				[applicationKeys.columns.confirmedAt, 8],
				[applicationKeys.columns.issuedAt, 7],
				[applicationKeys.columns.revokedAt, 9],
			],
			applications: [[applications.columns.registeredAt, 4]],
			auditLog: [[auditLog.columns.occurredAt, 31]],
			exchangedSids: [[exchangedSids.columns.expiresAt, 57]],
			globalRevocations: [[globalRevocations.columns.revokedAt, 35]],
			grantDecisions: [[grantDecisions.columns.decidedAt, 15]],
			grantOperations: [
				[GRANT_OPERATIONS.columns.expiresAt, 39],
				[GRANT_OPERATIONS.columns.occurredAt, 38],
			],
			grantRequests: [
				[grantRequests.columns.decidedAt, 36],
				[grantRequests.columns.expiresAt, 37],
				[grantRequests.columns.requestedAt, 34],
			],
			grants: [
				[grants.columns.endedAt, 52],
				[grants.columns.expiresAt, 50],
				[grants.columns.grantedAt, 10],
				[grants.columns.revokedAt, 20],
			],
			groups: [[groups.columns.createdAt, 5]],
			invitations: [
				[invitations.columns.expiresAt, 55],
				[invitations.columns.invitedAt, 10],
			],
			keyFingerprints: [[keyFingerprints.columns.recordedAt, 11]],
			nominations: [[nominations.columns.nominatedAt, 12]],
			notices: [[notices.columns.createdAt, 30]],
			notificationOutbox: [
				[notificationOutbox.columns.createdAt, 32],
				[notificationOutbox.columns.deliveredAt, 33],
			],
			principalRevocations: [
				[principalRevocations.columns.liftedAt, 25],
				[principalRevocations.columns.revokedAt, 10],
			],
			resources: [
				[resources.columns.registeredAt, 1],
				[resources.columns.retiredAt, 3],
				[resources.columns.updatedAt, 2],
			],
			identityProviderConfiguration: [[identityProviderConfiguration.columns.recordedAt, 45]],
			settings: [[settings.columns.changedAt, 46]],
			sidSignOuts: [
				[sidSignOuts.columns.expiresAt, 58],
				[sidSignOuts.columns.signedOutAt, 40],
			],
			subjectSignOuts: [
				[subjectSignOuts.columns.expiresAt, 59],
				[subjectSignOuts.columns.signedOutAt, 41],
			],
			usedChannelAssertions: [[usedChannelAssertions.columns.acceptedUntil, 47]],
			userIdentities: [[userIdentities.columns.addedAt, 6]],
			users: [[users.columns.createdAt, 0]],
		} as const;

		const probes = await inTransactionAs(toronto, SYSTEM_ACTOR, async (): Promise<readonly TimeProbe[]> => {
			const user = await insertRow(toronto, users, {
				...userRow(),
				...timed(times.users),
			});
			const userId = String(user[users.columns.id]);
			const identity = await insertRow(toronto, userIdentities, {
				...identityRow(userId, 'instant-probe-subject'),
				...timed(times.userIdentities),
			});
			const nomination = await insertRow(toronto, nominations, {
				...nominationRow({ nominatedBy: steward, nomineeId: userId }),
				...timed(times.nominations),
			});
			await insertRow(toronto, administrators, {
				...administratorRow({
					nominationId: String(nomination[nominations.columns.id]),
					userId,
				}),
				...timed(times.administrators),
			});
			const resource = await insertRow(toronto, resources, {
				...resourceRow('STUDY-T9', steward),
				[resources.columns.retiredBy]: steward,
				...timed(times.resources),
			});
			const application = await insertRow(toronto, applications, {
				[applications.columns.displayName]: 'Instant probe',
				[applications.columns.id]: randomUUID(),
				[applications.columns.registeredBy]: steward,
				...timed(times.applications),
			});
			const applicationKey = await insertRow(toronto, applicationKeys, {
				[applicationKeys.columns.applicationId]: application[applications.columns.id] ?? null,
				[applicationKeys.columns.encryptedKey]: randomBytes(60),
				[applicationKeys.columns.id]: randomUUID(),
				[applicationKeys.columns.issuedBy]: steward,
				[applicationKeys.columns.revokedBy]: steward,
				...timed(times.applicationKeys),
			});
			await insertRow(toronto, keyFingerprints, {
				[keyFingerprints.columns.fingerprint]: randomBytes(32),
				[keyFingerprints.columns.keyName]: 'keyEncryptionKey',
				...timed(times.keyFingerprints),
			});
			const group = await insertRow(toronto, groups, {
				[groups.columns.createdBy]: steward,
				[groups.columns.name]: 'instant-probe',
				[groups.columns.resourceId]: resourceId,
				...timed(times.groups),
			});
			const grant = await insertRow(toronto, grants, {
				...grantRow({
					grantedBy: steward,
					holderUserId: userId,
					recordCategoryId: categoryId,
					resourceId,
					revoked: { at: new Date(), by: steward },
					roleId,
				}),
				...timed(times.grants),
			});
			const grantId = String(grant[grants.columns.id]);
			const decision = await insertRow(toronto, grantDecisions, {
				...decisionRow({ decision: 'accepted', grantId, userId }),
				...timed(times.grantDecisions),
			});
			const request = await insertRow(toronto, grantRequests, {
				[grantRequests.columns.capabilities]: ['record.view'],
				[grantRequests.columns.decidedBy]: steward,
				[grantRequests.columns.decision]: 'refused',
				[grantRequests.columns.holderUserId]: userId,
				[grantRequests.columns.kind]: SELF_GRANT_REQUEST,
				[grantRequests.columns.recordCategoryId]: categoryId,
				[grantRequests.columns.requestedBy]: userId,
				[grantRequests.columns.resourceId]: resourceId,
				[grantRequests.columns.roleId]: roleId,
				...timed(times.grantRequests),
			});
			const revocation = await insertRow(toronto, principalRevocations, {
				...revocationRow({
					lifted: { at: new Date(), by: steward },
					revokedBy: steward,
					userId,
				}),
				...timed(times.principalRevocations),
			});
			const invitation = await insertRow(toronto, invitations, {
				...invitationRow({
					email: 'instant-probe@example.org',
					invitedBy: steward,
					recordCategoryId: categoryId,
					resourceId,
					roleId,
				}),
				...timed(times.invitations),
			});
			const notice = await insertRow(toronto, notices, {
				...noticeRow({ kind: 'baseline' }),
				...timed(times.notices),
			});
			const auditEntry = await insertRow(toronto, auditLog, {
				...auditEntryRow({ grantId }),
				...timed(times.auditLog),
			});
			const outbox = await insertRow(toronto, notificationOutbox, {
				[notificationOutbox.columns.grantId]: grantId,
				[notificationOutbox.columns.kind]: SELF_GRANT_NOTIFICATION,
				[notificationOutbox.columns.recipientUserId]: userId,
				...timed(times.notificationOutbox),
			});
			await insertRow(toronto, sidSignOuts, {
				[sidSignOuts.columns.idpIssuer]: DEFAULT_FIXTURE_ISSUER,
				[sidSignOuts.columns.idpSubjectId]: 'instant-probe-subject',
				[sidSignOuts.columns.sid]: 'instant-probe-sid',
				...timed(times.sidSignOuts),
			});
			await insertRow(toronto, subjectSignOuts, {
				[subjectSignOuts.columns.idpIssuer]: SECOND_ISSUER,
				[subjectSignOuts.columns.idpSubjectId]: 'instant-probe-subject',
				...timed(times.subjectSignOuts),
			});
			await insertRow(toronto, usedChannelAssertions, {
				[usedChannelAssertions.columns.applicationId]: application[applications.columns.id] ?? null,
				[usedChannelAssertions.columns.assertionId]: 'instant-probe-assertion',
				...timed(times.usedChannelAssertions),
			});
			const globalRevocation = await insertRow(toronto, globalRevocations, {
				[globalRevocations.columns.reasonCode]: 'securityIncident',
				[globalRevocations.columns.revokedBy]: steward,
				...timed(times.globalRevocations),
			});
			await insertRow(toronto, exchangedSids, {
				[exchangedSids.columns.idpIssuer]: DEFAULT_FIXTURE_ISSUER,
				[exchangedSids.columns.idpSubjectId]: 'instant-probe-subject',
				[exchangedSids.columns.sid]: 'instant-probe-exchanged-sid',
				...timed(times.exchangedSids),
			});
			await toronto.query(
				`UPDATE ${qualified(identityProviderConfiguration)} SET ${identityProviderConfiguration.columns.value} = '"probe"'::jsonb, ${identityProviderConfiguration.columns.recordedAt} = $1 WHERE ${identityProviderConfiguration.columns.name} = 'managementAudience'`,
				[inRepeatedHour(45)],
			);
			await toronto.query('BEGIN');
			await toronto.query("SELECT set_config('usher.actor_type', 'system', true)");
			await toronto.query(
				`UPDATE ${qualified(settings)} SET ${settings.columns.changedAt} = $1 WHERE ${settings.columns.name} = 'noticePageLimit'`,
				[inRepeatedHour(46)],
			);
			await toronto.query('COMMIT');
			const grantOperation = await insertRow(toronto, GRANT_OPERATIONS, {
				[GRANT_OPERATIONS.columns.idpIssuer]: DEFAULT_FIXTURE_ISSUER,
				[GRANT_OPERATIONS.columns.idpSubjectId]: 'instant-probe-subject',
				...timed(times.grantOperations),
			});
			return [
				{
					columns: times.users,
					key: users.columns.id,
					keyValue: userId,
					table: users,
				},
				{
					columns: times.userIdentities,
					key: userIdentities.columns.id,
					keyValue: identity[userIdentities.columns.id],
					table: userIdentities,
				},
				{
					columns: times.resources,
					key: resources.columns.id,
					keyValue: resource[resources.columns.id],
					table: resources,
				},
				{
					columns: times.applications,
					key: applications.columns.id,
					keyValue: application[applications.columns.id],
					table: applications,
				},
				{
					columns: times.applicationKeys,
					key: applicationKeys.columns.id,
					keyValue: applicationKey[applicationKeys.columns.id],
					table: applicationKeys,
				},
				{
					columns: times.keyFingerprints,
					key: keyFingerprints.columns.keyName,
					keyValue: 'keyEncryptionKey',
					table: keyFingerprints,
				},
				{
					columns: times.groups,
					key: groups.columns.id,
					keyValue: group[groups.columns.id],
					table: groups,
				},
				{
					columns: times.grants,
					key: grants.columns.id,
					keyValue: grantId,
					table: grants,
				},
				{
					columns: times.grantDecisions,
					key: grantDecisions.columns.id,
					keyValue: decision[grantDecisions.columns.id],
					table: grantDecisions,
				},
				{
					columns: times.grantRequests,
					key: grantRequests.columns.id,
					keyValue: request[grantRequests.columns.id],
					table: grantRequests,
				},
				{
					columns: times.principalRevocations,
					key: principalRevocations.columns.id,
					keyValue: revocation[principalRevocations.columns.id],
					table: principalRevocations,
				},
				{
					columns: times.invitations,
					key: invitations.columns.id,
					keyValue: invitation[invitations.columns.id],
					table: invitations,
				},
				{
					columns: times.notices,
					key: notices.columns.position,
					keyValue: notice[notices.columns.position],
					table: notices,
				},
				{
					columns: times.auditLog,
					key: auditLog.columns.id,
					keyValue: auditEntry[auditLog.columns.id],
					table: auditLog,
				},
				{
					columns: times.notificationOutbox,
					key: notificationOutbox.columns.id,
					keyValue: outbox[notificationOutbox.columns.id],
					table: notificationOutbox,
				},
				{
					columns: times.sidSignOuts,
					key: sidSignOuts.columns.sid,
					keyValue: 'instant-probe-sid',
					table: sidSignOuts,
				},
				{
					columns: times.subjectSignOuts,
					key: subjectSignOuts.columns.idpSubjectId,
					keyValue: 'instant-probe-subject',
					table: subjectSignOuts,
				},
				{
					columns: times.usedChannelAssertions,
					key: usedChannelAssertions.columns.assertionId,
					keyValue: 'instant-probe-assertion',
					table: usedChannelAssertions,
				},
				{
					columns: times.identityProviderConfiguration,
					key: identityProviderConfiguration.columns.name,
					keyValue: 'managementAudience',
					table: identityProviderConfiguration,
				},
				{
					columns: times.settings,
					key: settings.columns.name,
					keyValue: 'noticePageLimit',
					table: settings,
				},
				{
					columns: times.globalRevocations,
					key: globalRevocations.columns.id,
					keyValue: globalRevocation[globalRevocations.columns.id],
					table: globalRevocations,
				},
				{
					columns: times.exchangedSids,
					key: exchangedSids.columns.sid,
					keyValue: 'instant-probe-exchanged-sid',
					table: exchangedSids,
				},
				{
					columns: times.nominations,
					key: nominations.columns.id,
					keyValue: nomination[nominations.columns.id],
					table: nominations,
				},
				{
					columns: times.administrators,
					key: administrators.columns.userId,
					keyValue: userId,
					table: administrators,
				},
				{
					columns: times.grantOperations,
					key: GRANT_OPERATIONS.columns.id,
					keyValue: grantOperation[GRANT_OPERATIONS.columns.id],
					table: GRANT_OPERATIONS,
				},
			];
		});
		const readers = await Promise.all(
			['UTC', 'Asia/Kolkata'].map((zone) => connectInTimeZone(database, 'migration', zone)),
		);
		const readings = await Promise.all(
			readers.map((reader) =>
				inTurn(
					probes.flatMap(({ columns, key, keyValue, table }) =>
						columns.map(([column]) => ({ column, key, keyValue, table })),
					),
					async ({ column, key, keyValue, table }) => {
						const [row] = await selectRows<{ epoch: number }>(
							reader,
							`SELECT extract(epoch FROM ${column})::float8 AS epoch FROM ${qualified(table)} WHERE ${key} = $1`,
							[keyValue],
						);
						return { column: `${table.name}.${column}`, epoch: row?.epoch };
					},
				),
			),
		);
		const timeColumns = (await readColumns(readers[0] ?? toronto)).filter(({ type }) => TIME_TYPES.has(type));
		const probed = new Set(
			probes.flatMap(({ columns, table }) => columns.map(([column]) => `${table.name}.${column}`)),
		);

		assert.deepEqual(
			readings,
			readers.map(() =>
				probes.flatMap(({ columns, table }) =>
					columns.map(([column, minute]) => ({
						column: `${table.name}.${column}`,
						epoch: secondsSinceEpoch(minute),
					})),
				),
			),
		);
		assert.deepEqual(
			timeColumns.filter(({ type }) => type !== 'timestamp with time zone'),
			[],
		);
		assert.deepEqual(
			timeColumns
				.map(({ column, table }) => `${table}.${column}`)
				.filter((column) => !probed.has(column) && !WRITTEN_BY_THE_STORE.has(column)),
			[],
		);
	});

	test('holds each fixed vocabulary as text bound by a constraint', async (context) => {
		const database = await openDatabase(context);
		const owner = await database.connect('migration');
		const vocabularies = [
			{
				column: resources.columns.baseTier,
				table: resources,
				values: ['grant', 'open', 'registered'],
			},
			{
				column: categories.columns.scope,
				table: categories,
				values: ['global', 'resource'],
			},
			{
				column: keyFingerprints.columns.keyName,
				table: keyFingerprints,
				values: ['keyEncryptionKey'],
			},
			{
				column: roles.columns.plane,
				table: roles,
				values: ['control', 'data'],
			},
			{
				column: capabilities.columns.plane,
				table: capabilities,
				values: ['control', 'data'],
			},
			{
				column: grantDecisions.columns.decision,
				table: grantDecisions,
				values: ['accepted', 'rejected'],
			},
			{ column: notices.columns.kind, table: notices, values: NOTICE_KINDS },
			{
				column: auditLog.columns.severity,
				table: auditLog,
				values: ['critical', 'error', 'info', 'warning'],
			},
		];

		const enumTypes = await selectRows<{ name: string }>(
			owner,
			`SELECT type.typname AS name FROM pg_type type JOIN pg_namespace namespace ON namespace.oid = type.typnamespace WHERE type.typtype = 'e' AND namespace.nspname = $1
       UNION
       SELECT format_type(attribute.atttypid, attribute.atttypmod) AS name
         FROM pg_attribute attribute
         JOIN pg_class relation ON relation.oid = attribute.attrelid
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         JOIN pg_type type ON type.oid = attribute.atttypid
        WHERE namespace.nspname = $1 AND type.typtype = 'e'`,
			[USHER_SCHEMA],
		);
		const columns = await readColumns(owner);
		const bound = await inTurn(vocabularies, async ({ column, table, values }) => {
			const checks = await checksOn(owner, table, column);
			return {
				column: `${table.name}.${column}`,
				namesEveryValue: checks.some((definition) =>
					values.every((value) => definition.includes(`'${value}'`)),
				),
				type: columns.find((candidate) => candidate.table === table.name && candidate.column === column)?.type,
			};
		});

		assert.deepEqual(enumTypes, []);
		assert.deepEqual(
			bound,
			vocabularies.map(({ column, table }) => ({
				column: `${table.name}.${column}`,
				namesEveryValue: true,
				type: 'text',
			})),
		);
	});

	test('stores no email address or display name for a principal', async (context) => {
		const database = await openDatabase(context);
		const owner = await database.connect('migration');

		const columns = await readColumns(owner);

		assert.deepEqual(
			columns
				.filter(({ table }) => table === users.name)
				.map(({ column }) => column)
				.sort(),
			Object.values(users.columns).sort(),
		);
		assert.deepEqual(
			columns
				.filter(({ column }) => /mail|address/iu.test(column))
				.map(({ column, table }) => `${table}.${column}`),
			[`${invitations.name}.${invitations.columns.email}`],
		);
	});
});
