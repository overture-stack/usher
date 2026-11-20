import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { suite, test } from 'node:test';

import {
	type AuditEventRegistration,
	type AuditEventType,
	AUDIT_EVENT_TYPES,
	AUDIT_EVENTS_DOCUMENT,
	auditRows,
	auditRowTexts,
	awaitEventData,
	awaitEventsOfType,
	BRIDGE_EVENT_TYPES,
	CAUSED_BY_MEMBER,
	CHANNEL_ASSERTION_REJECTION_REASONS,
	CHANNEL_ASSERTION_TALLY_REASONS,
	CHANNEL_ASSERTION_VERIFIED_REJECTION_REASONS,
	cloudEventsIn,
	credentialRefusalsElsewhere,
	dataOf,
	DRY_RUN_LOG_LINE,
	dryRunLogLines,
	emittedType,
	EVENT_INSTANT_FORM,
	eventDataOf,
	eventsIn,
	eventsTableRows,
	EXCHANGE_REFUSAL_REASONS,
	FAULT_REASONS,
	fieldSetsIn,
	jsonObjectOf,
	MANAGEMENT_TOKEN_REFUSAL_REASONS,
	UNVERIFIED_MANAGEMENT_CREDENTIAL_REASONS,
	managementTokenRefusal,
	managementTokenRefusalsIn,
	IMPORT_ORIGIN_EVENT_TYPES,
	IMPORT_RUN_COUNTS,
	NOT_EMITTED_IN_THIS_EPIC,
	ofType,
	POST_MVP_EVENT_TYPES,
	readAuditEvents,
	REFUSED_SUBJECT_MAXIMUM_LENGTH,
	REFUSED_SUBJECT_MEMBER,
	PER_TOKEN_WINDOW_LIMIT,
	REFUSAL_WINDOW_CEILING_MILLISECONDS,
	REFUSAL_WINDOW_COOLDOWN_MILLISECONDS,
	refusalTalliesIn,
	severityIn,
	severityOfChanges,
	TOKEN_CAP_EVENT,
} from './auditEvents.js';
import { captureLog } from './controller.js';
import { createTestDatabase } from './database.js';

const FIXTURE = [
	'## Events and the permissions that produce them',
	'',
	'| Event type | Actor |',
	'| --- | --- |',
	'| `grant.creation` | Custodian |',
	'',
	'## Events',
	'',
	'| Event type | Description | Actor | Affected entity | Additional required fields | Severity |',
	'| --- | --- | --- | --- | --- | --- |',
	'| `token.exchange` | Usher token issued, or refused | User | Usher token | `userId`, `result`; on success `tokenTtl` and `rules` (the names of the rules); on refusal `reason` | follows `result` |',
	'| `grant.revocation` | Category grant revoked | Custodian, owner or admin | User + category | `actorId`, `grantId`, `reason`; `causedBy` when a retirement ended it | `info` |',
	'| `resource.orphaned` | Resource has no owner | System | Resource | `resourceId`, `lastOwnerId` | `critical` |',
	'| `grant.unguarded` | A grant took effect without a custodian |  |  |  |  |',
	'| `applicationKey.revocation` | Application key revoked | Admin | Application key | `actorId`, `keyId`; `reason` (`rotated`, `compromised` or `retired`) when given | `warning` when refused; `critical` for `compromised`; else `info` |',
	'| `import.run` | EGO import run | Admin | Resources and grants | `actorId`; on success, the counts listed below the table | follows `result` |',
	'| `revocationChannel.reset` | Bridge dropped every entry | System | All active sessions | none | `warning` |',
	'| `category.unmapped` | Bridge denied a result | System | Catalogue | `catalogue`, `category`, `resourceId` | `critical` for a global category, `error` for a resource category |',
	'',
	'**`token.exchange` names no grant.** It carries `tokenTtl`, `grantCount` and',
	'`rules` alone.',
	'',
	'**`import.run` records each real run.** A real run that succeeds records it at `info`, with',
	'`studiesReported`, `grantsWritten` and `resourcesWithoutOwner`.',
	'',
	'## Open items',
].join('\n');

const KEY_REVOCATION_FIELDS =
	'`actorId`, `applicationId`, `keyId`; `reason` (`rotated`, `compromised` or `retired`) when given';

suite("reading audit-events.md's Events table", () => {
	test("reads a severity chosen by a field's value: the mode change's by toMode, and the key revocation's by result and then by a value its fields cell lists for reason", () => {
		assert.deepEqual(severityIn('`critical` into cold or uncertain, `info` into normal'), {
			byValue: { cold: 'critical', normal: 'info', uncertain: 'critical' },
			field: 'toMode',
			kind: 'byValue',
			otherwise: 'critical',
		});
		assert.deepEqual(
			severityIn('`warning` when refused; `critical` for `compromised`; else `info`', KEY_REVOCATION_FIELDS),
			{
				byValue: { compromised: 'critical' },
				field: 'reason',
				kind: 'byValue',
				otherwise: 'info',
				whenDenied: 'warning',
			},
		);
	});

	test('reads a severity by which names changed: one severity when any listed name is among the changes, another otherwise, and judges an event for both outcomes', () => {
		const severity = severityIn(
			'`critical` when `identityProviderIssuer`, `managementAudience`, `managementClients` or `serviceAccountRole` changed; `warning` otherwise',
		);
		if (severity.kind !== 'byChangedName') {
			assert.fail('the cell is not a severity by which names changed');
		}
		assert.deepEqual(severity, {
			kind: 'byChangedName',
			names: ['identityProviderIssuer', 'managementAudience', 'managementClients', 'serviceAccountRole'],
			otherwise: 'warning',
			severity: 'critical',
		});
		assert.equal(
			severityOfChanges(severity, {
				changes: [
					{ name: 'apiDocsClient', previousValue: '', value: 'a' },
					{ name: 'managementClients', previousValue: [], value: ['b'] },
				],
			}),
			'critical',
		);
		assert.equal(
			severityOfChanges(severity, {
				changes: [{ name: 'apiDocsClient', previousValue: '', value: 'a' }],
			}),
			'warning',
		);
	});

	test('reads a severity by which names changed beside a refusal, the refusal before the changes', () => {
		const severity = severityIn(
			'`warning` when refused; `critical` when `grantAutoAccept` or `submitterCategory` changed; `warning` otherwise',
		);
		assert.deepEqual(severity, {
			kind: 'byChangedName',
			names: ['grantAutoAccept', 'submitterCategory'],
			otherwise: 'warning',
			severity: 'critical',
			whenDenied: 'warning',
		});
	});

	test('reads a severity per case from a clause naming several values, and from a refusal and every other case alone', () => {
		assert.deepEqual(
			severityIn(
				'`critical` for `compromised` or `stolen`; else `info`',
				'`keyId`, `reason` (`compromised`, `rotated` or `stolen`)',
			),
			{
				byValue: { compromised: 'critical', stolen: 'critical' },
				field: 'reason',
				kind: 'byValue',
				otherwise: 'info',
			},
		);
		assert.deepEqual(severityIn('`warning` when refused; else `info`'), {
			kind: 'fixed',
			severity: 'info',
			whenDenied: 'warning',
		});
	});

	test("reads a for clause naming a value of result as a severity chosen by result when the fields cell lists that value for no field, and as the field's when it lists it for one", () => {
		assert.deepEqual(
			severityIn(
				'`error` for `failed`; else `warning`',
				'`actorId`; on success, the counts listed below the table',
			),
			{
				byValue: { failed: 'error' },
				field: 'result',
				kind: 'byValue',
				otherwise: 'warning',
			},
		);
		assert.deepEqual(severityIn('`info` for `succeeded`; `error` for `denied` or `failed`; else `warning`'), {
			byValue: { denied: 'error', failed: 'error', succeeded: 'info' },
			field: 'result',
			kind: 'byValue',
			otherwise: 'warning',
		});
		assert.deepEqual(
			severityIn('`error` for `failed`; else `warning`', '`actorId`, `stage` (`failed` or `passed`)'),
			{
				byValue: { failed: 'error' },
				field: 'stage',
				kind: 'byValue',
				otherwise: 'warning',
			},
		);
	});

	test('refuses a severity cell any of whose cases cannot be read', () => {
		const fields = '`reason` (`compromised` or `rotated`), `mode` (`cold`)';

		assert.throws(
			() => severityIn('`critical` for `compromised`', fields),
			/no severity for every other case can be read/u,
		);
		assert.throws(
			() => severityIn('`critical` for `stolen`; else `info`', fields),
			/no field listing `stolen` can be read/u,
		);
		assert.throws(
			() => severityIn('`critical` for `compromised` or `cold`; else `info`', fields),
			/no severity chosen by one field can be read/u,
		);
		assert.throws(
			() => severityIn('`critical` for `compromised` or `failed`; else `info`', fields),
			/no severity chosen by one field can be read/u,
		);
		assert.throws(() => severityIn('`loud` when refused; else `info`'), /no severity can be read/u);
		assert.throws(() => severityIn('`warning` now and then; else `info`'), /no severity can be read/u);
	});

	test('reads a field carried only under a condition its clause names with when or for, a condition inside parentheses naming none', () => {
		assert.deepEqual(fieldSetsIn(KEY_REVOCATION_FIELDS), {
			always: ['actorId', 'applicationId', 'keyId'],
			conditional: ['reason'],
			onRefusal: [],
			onSuccess: [],
		});
		assert.deepEqual(fieldSetsIn('`catalogue`, `category`; `resourceId` for a resource category'), {
			always: ['catalogue', 'category'],
			conditional: ['resourceId'],
			onRefusal: [],
			onSuccess: [],
		});
		assert.deepEqual(fieldSetsIn('`origin` (`controller` when refused)'), {
			always: ['origin'],
			conditional: [],
			onRefusal: [],
			onSuccess: [],
		});
	});

	test('reads a condition named inside a list as carrying only the names before its when or for, in any clause, and a name after it as part of the condition', () => {
		assert.deepEqual(
			fieldSetsIn(
				'`reason` (`a` or `b`), `refusedSubject` when its `sub` is short, `route`; on refusal `cause`, `subject` when it verified, and `heldCount` and `size` when over the cap',
			),
			{
				always: ['reason', 'route'],
				conditional: ['refusedSubject', 'subject', 'heldCount', 'size'],
				onRefusal: ['cause'],
				onSuccess: [],
			},
		);
	});

	test('takes the names listed below the table for a clause pointing there, and refuses one when nothing is listed', () => {
		const cell = '`actorId`; on success, the counts listed below the table';

		assert.deepEqual(fieldSetsIn(cell, ['grantsWritten', 'studiesSkipped']), {
			always: ['actorId'],
			conditional: [],
			onRefusal: [],
			onSuccess: ['grantsWritten', 'studiesSkipped'],
		});
		assert.throws(() => fieldSetsIn(cell), /no field name listed below the table can be read/u);
	});

	test("reads field sets by result and by condition, the severity of each case, the Actor column's roles and whose each row is, a principal's row refused carrying reason at warning", () => {
		const read = readAuditEvents(FIXTURE);

		assert.deepEqual(
			read.map(({ actor, event, fields, owner, severity }) => ({
				actor,
				event,
				fields,
				owner,
				severity,
			})),
			[
				{
					actor: { kind: 'roles', roles: ['user'] },
					event: 'token.exchange',
					fields: {
						always: ['userId', 'result'],
						conditional: [],
						onRefusal: ['reason'],
						onSuccess: ['tokenTtl', 'rules'],
					},
					owner: 'controller',
					severity: { kind: 'followsResult' },
				},
				{
					actor: { kind: 'roles', roles: ['custodian', 'owner', 'admin'] },
					event: 'grant.revocation',
					fields: {
						always: ['actorId', 'grantId', 'reason'],
						conditional: ['causedBy'],
						onRefusal: [],
						onSuccess: [],
					},
					owner: 'controller',
					severity: { kind: 'fixed', severity: 'info', whenDenied: 'warning' },
				},
				{
					actor: { kind: 'system' },
					event: 'resource.orphaned',
					fields: {
						always: ['resourceId', 'lastOwnerId'],
						conditional: [],
						onRefusal: [],
						onSuccess: [],
					},
					owner: 'controller',
					severity: { kind: 'fixed', severity: 'critical' },
				},
				{
					actor: { kind: 'roles', roles: ['admin'] },
					event: 'applicationKey.revocation',
					fields: {
						always: ['actorId', 'keyId'],
						conditional: ['reason'],
						onRefusal: ['reason'],
						onSuccess: [],
					},
					owner: 'controller',
					severity: {
						byValue: { compromised: 'critical' },
						field: 'reason',
						kind: 'byValue',
						otherwise: 'info',
						whenDenied: 'warning',
					},
				},
				{
					actor: { kind: 'roles', roles: ['admin'] },
					event: 'import.run',
					fields: {
						always: ['actorId'],
						conditional: [],
						onRefusal: ['reason'],
						onSuccess: ['studiesReported', 'grantsWritten', 'resourcesWithoutOwner'],
					},
					owner: 'controller',
					severity: { kind: 'followsResult' },
				},
				{
					actor: { kind: 'system' },
					event: 'revocationChannel.reset',
					fields: { always: [], conditional: [], onRefusal: [], onSuccess: [] },
					owner: 'bridge',
					severity: { kind: 'fixed', severity: 'warning' },
				},
				{
					actor: { kind: 'system' },
					event: 'category.unmapped',
					fields: {
						always: ['catalogue', 'category', 'resourceId'],
						conditional: [],
						onRefusal: [],
						onSuccess: [],
					},
					owner: 'bridge',
					severity: {
						field: 'resourceId',
						kind: 'byField',
						withField: 'error',
						withoutField: 'critical',
					},
				},
			],
		);
	});

	test('reads every row of the document, the post-MVP rows left out, and finds a row for every event type the tests name and every one no operation of this epic emits', () => {
		const read = readAuditEvents();
		const rows = eventsTableRows(readFileSync(AUDIT_EVENTS_DOCUMENT, 'utf8'));
		const controllerRows = read.filter(({ owner }) => owner === 'controller').map(({ event }) => event);
		const named: readonly string[] = Object.values(AUDIT_EVENT_TYPES);

		assert.equal(read.length + POST_MVP_EVENT_TYPES.length, rows.length);
		assert.ok(
			read.filter(({ owner }) => owner === 'bridge').every(({ event }) => BRIDGE_EVENT_TYPES.includes(event)),
		);
		assert.deepEqual(
			controllerRows.filter((event) => !named.includes(event)),
			[],
		);
		assert.deepEqual(
			named.filter((event) => !controllerRows.includes(event)),
			[],
		);
		assert.deepEqual(
			Object.keys(NOT_EMITTED_IN_THIS_EPIC).filter((event) => !controllerRows.includes(event)),
			[],
		);
	});

	test("names each post-MVP row in the document's Open items", () => {
		const document = readFileSync(AUDIT_EVENTS_DOCUMENT, 'utf8');
		const openItems = document.slice(document.indexOf('## Open items'));

		assert.ok(POST_MVP_EVENT_TYPES.every((event) => openItems.includes(`\`${event}\``)));
	});

	test("gives an event type as it is emitted, with the organization's prefix", () => {
		assert.equal(emittedType(AUDIT_EVENT_TYPES.grantDecision), 'bio.overture.grant.decision');
	});
});

suite('reading the log stream as CloudEvents', () => {
	const event = (data: object): string =>
		JSON.stringify({
			data,
			id: '7c9e2a14-3b6d-4f81-9a2e-5d4c3b2a1f09',
			severity: 'info',
			source: 'https://usher.example.org/controller',
			specversion: '1.0',
			time: '2026-10-23T12:00:00Z',
			type: 'bio.overture.grant.creation',
		});

	test('reads every event among the lines, leaving out the lines that are no event', () => {
		const events = cloudEventsIn([
			event({ actorId: 'admin-0001', grantId: 'g-1' }),
			JSON.stringify({ level: 'info', message: 'listening' }),
		]);

		assert.deepEqual(
			events.map(({ data, type }) => ({ data, type })),
			[
				{
					data: { actorId: 'admin-0001', grantId: 'g-1' },
					type: 'bio.overture.grant.creation',
				},
			],
		);
	});

	test('refuses a line repeating a member, at any depth and however its name is escaped', () => {
		assert.throws(() => cloudEventsIn([event({}).replace('{', '{"time":"2026-10-23T11:00:00Z",')]), {
			message: 'log line 1: the line repeats the member "time"',
		});
		assert.throws(() => jsonObjectOf('{"data":{"actorId":"a","actorId":"b"}}'), {
			message: 'the line repeats the member "actorId"',
		});
		assert.throws(() => jsonObjectOf('{"time":"a","\\u0074ime":"b"}'), {
			message: 'the line repeats the member "time"',
		});
		assert.deepEqual(jsonObjectOf('{"list":[{"a":1},{"a":2}],"empty":{}}'), {
			empty: {},
			list: [{ a: 1 }, { a: 2 }],
		});
	});

	test('refuses a line that is not one JSON object', () => {
		assert.throws(() => jsonObjectOf('[1, 2]'), {
			message: 'the line is not one JSON object',
		});
		assert.throws(() => jsonObjectOf('{"a":1} {"b":2}'), /not well-formed JSON at character 8/u);
		assert.throws(() => jsonObjectOf('{"a":01}'), /not well-formed JSON/u);
		assert.throws(() => cloudEventsIn(['plain text']), {
			message: 'log line 1: the line is not one JSON object',
		});
	});
});

// What the document registers for an event the tests name.
const registered = (event: AuditEventType): AuditEventRegistration =>
	readAuditEvents().find((registration) => registration.event === event) ??
	assert.fail(`the document holds no row for ${event}`);

// The values a fields cell lists for a field, in the parentheses after its name.
const valuesListedFor = (cell: string, field: string): readonly string[] =>
	Array.from(
		(cell.match(new RegExp(`\`${field}\` \\(([^)]*)\\)`, 'u'))?.[1] ?? '').matchAll(/`(\w+)`/gu),
		([, value]) => value ?? '',
	);

suite("the controller's events, as the document registers them", () => {
	test("reads a refused channel assertion's two events as the system's at warning, the rejection always naming its application and the tally counting one only when registered, their reasons splitting the codes between them", () => {
		const rejection = registered(AUDIT_EVENT_TYPES.channelAssertionRejection);
		const tally = registered(AUDIT_EVENT_TYPES.channelAssertionRejectionTally);

		assert.deepEqual(
			[rejection, tally].map(({ actor, fields, severity }) => ({
				actor,
				fields,
				severity,
			})),
			[
				{
					actor: { kind: 'system' },
					fields: {
						always: ['reason', 'applicationId'],
						conditional: [],
						onRefusal: [],
						onSuccess: [],
					},
					severity: { kind: 'fixed', severity: 'warning' },
				},
				{
					actor: { kind: 'system' },
					fields: {
						always: ['reason', 'count'],
						conditional: ['applicationId'],
						onRefusal: [],
						onSuccess: [],
					},
					severity: { kind: 'fixed', severity: 'warning' },
				},
			],
		);
		assert.deepEqual(
			[...CHANNEL_ASSERTION_VERIFIED_REJECTION_REASONS, ...CHANNEL_ASSERTION_TALLY_REASONS].toSorted(),
			Object.values(CHANNEL_ASSERTION_REJECTION_REASONS).toSorted(),
		);
	});

	test("reads a refused management credential's two events, the refusal opening a window anonymous and naming the subject only under its condition, with every reason its row lists, and the closing the system's, naming its opening only once committed and no subject", () => {
		const refusal = registered(AUDIT_EVENT_TYPES.managementTokenRefusal);
		const tally = registered(AUDIT_EVENT_TYPES.managementTokenRefusalTally);

		assert.deepEqual(
			[refusal, tally].map(({ actor, fields, severity }) => ({
				actor,
				fields,
				severity,
			})),
			[
				{
					actor: { kind: 'anonymous' },
					fields: {
						always: ['reason', 'method', 'route'],
						conditional: [REFUSED_SUBJECT_MEMBER],
						onRefusal: [],
						onSuccess: [],
					},
					severity: { kind: 'fixed', severity: 'warning' },
				},
				{
					actor: { kind: 'system' },
					fields: {
						always: ['reason', 'count', 'firstSeenAt', 'lastSeenAt'],
						conditional: ['windowId'],
						onRefusal: [],
						onSuccess: [],
					},
					severity: { kind: 'fixed', severity: 'warning' },
				},
			],
		);
		assert.deepEqual(valuesListedFor(refusal.row.fields, 'reason'), [
			...MANAGEMENT_TOKEN_REFUSAL_REASONS,
			...UNVERIFIED_MANAGEMENT_CREDENTIAL_REASONS,
		]);
		assert.equal(REFUSED_SUBJECT_MEMBER, 'refusedSubject');
		assert.equal(REFUSED_SUBJECT_MAXIMUM_LENGTH, 255);
	});

	test("reads each route's window closing as the system's at warning, naming its reason, its count, its first and latest refusals, its opening only once committed, and at the exchange the application of credentials that did not verify", () => {
		const closings = [
			registered(AUDIT_EVENT_TYPES.managementTokenRefusalTally),
			registered(AUDIT_EVENT_TYPES.logoutTokenRefusalTally),
			registered(AUDIT_EVENT_TYPES.tokenExchangeRefusalTally),
		];

		assert.deepEqual(
			closings.map(({ actor, fields, severity }) => ({
				actor,
				fields,
				severity,
			})),
			[['windowId'], ['windowId'], ['windowId', 'applicationId']].map((conditional) => ({
				actor: { kind: 'system' },
				fields: {
					always: ['reason', 'count', 'firstSeenAt', 'lastSeenAt'],
					conditional,
					onRefusal: [],
					onSuccess: [],
				},
				severity: { kind: 'fixed', severity: 'warning' },
			})),
		);
		assert.deepEqual(
			[REFUSAL_WINDOW_COOLDOWN_MILLISECONDS, REFUSAL_WINDOW_CEILING_MILLISECONDS, PER_TOKEN_WINDOW_LIMIT],
			[600_000, 3_600_000, 10_000],
		);
	});

	test('reads a key revocation as naming its reason only when given, recorded at warning when refused, critical for compromised and info otherwise', () => {
		const { fields, row, severity } = registered(AUDIT_EVENT_TYPES.applicationKeyRevocation);

		assert.deepEqual(
			{ fields, severity },
			{
				fields: {
					always: ['actorId', 'applicationId', 'keyId'],
					conditional: ['reason'],
					onRefusal: ['reason'],
					onSuccess: [],
				},
				severity: {
					byValue: { compromised: 'critical' },
					field: 'reason',
					kind: 'byValue',
					otherwise: 'info',
					whenDenied: 'warning',
				},
			},
		);
		assert.deepEqual(valuesListedFor(row.fields, 'reason'), ['rotated', 'compromised', 'retired']);
	});

	test("reads a sign-out relayed by the identity provider as the system's, naming its result and the person signed out when known, and a served resource's change as added or removed", () => {
		const signOut = registered(AUDIT_EVENT_TYPES.identitySignOut);
		const served = registered(AUDIT_EVENT_TYPES.applicationServedResourcesChange);

		assert.deepEqual(
			{
				actor: signOut.actor,
				fields: signOut.fields,
				severity: signOut.severity,
			},
			{
				actor: { kind: 'system' },
				fields: {
					always: ['result'],
					conditional: ['signedOutUserId'],
					onRefusal: [],
					onSuccess: [],
				},
				severity: { kind: 'fixed', severity: 'info' },
			},
		);
		assert.deepEqual(served.fields.always, ['actorId', 'applicationId', 'resourceId', 'change']);
		assert.deepEqual(valuesListedFor(served.row.fields, 'change'), ['added', 'removed']);
	});

	test("reads a grant's revocation as naming the event that caused it only when a retirement ended it", () => {
		const { fields } = registered(AUDIT_EVENT_TYPES.grantRevocation);

		assert.deepEqual(fields.conditional, [CAUSED_BY_MEMBER]);
		assert.equal(fields.always.includes(CAUSED_BY_MEMBER), false);
	});

	test("reads the first administrator's nomination as the first user's at warning and its acceptance as the nominee's at critical, each refused at warning carrying reason, and what each carries on success alone", () => {
		const nomination = registered(AUDIT_EVENT_TYPES.adminNomination);
		const acceptance = registered(AUDIT_EVENT_TYPES.adminAcceptance);

		assert.deepEqual(
			[nomination, acceptance].map(({ actor, fields, owner, severity }) => ({
				actor,
				fields,
				owner,
				severity,
			})),
			[
				{
					actor: { kind: 'roles', roles: ['first user'] },
					fields: {
						always: ['actorId'],
						conditional: [],
						onRefusal: ['reason'],
						onSuccess: ['nomineeId', 'nominationId'],
					},
					owner: 'controller',
					severity: {
						kind: 'fixed',
						severity: 'warning',
						whenDenied: 'warning',
					},
				},
				{
					actor: { kind: 'roles', roles: ['nominee'] },
					fields: {
						always: ['actorId'],
						conditional: ['nominationId'],
						onRefusal: ['reason'],
						onSuccess: ['nominatedById'],
					},
					owner: 'controller',
					severity: {
						kind: 'fixed',
						severity: 'critical',
						whenDenied: 'warning',
					},
				},
			],
		);
	});

	test("reads each event's severity as its row names it: a lift of an identity's revocation at warning, a revocation of the whole platform or of a resource at critical", () => {
		const levels = (
			[
				'application.registration',
				'application.servedResourcesChange',
				'applicationKey.confirmation',
				'applicationKey.issuance',
				'applicationKey.unreadable',
				'audit.read',
				'category.creation',
				'grant.decision',
				'identity.revocationLift',
				'platform.revocation',
				'resource.deletion',
				'resource.detailsUpdate',
				'resource.retirement',
				'resource.revocation',
			] as const
		).map((event) => {
			const { severity } = registered(event);
			return [event, severity.kind === 'fixed' ? severity.severity : severity];
		});

		assert.deepEqual(Object.fromEntries(levels), {
			'application.registration': 'info',
			'application.servedResourcesChange': 'info',
			'applicationKey.confirmation': 'info',
			'applicationKey.issuance': 'info',
			'applicationKey.unreadable': 'critical',
			'audit.read': 'info',
			'category.creation': 'info',
			'grant.decision': 'info',
			'identity.revocationLift': 'warning',
			'platform.revocation': 'critical',
			'resource.deletion': 'info',
			'resource.detailsUpdate': 'info',
			'resource.retirement': 'info',
			'resource.revocation': 'critical',
		});
	});

	test("records a principal's refused request as its operation's event carrying reason at warning, and applies that to no row of the system's or an anonymous actor's", () => {
		const controllerRows = readAuditEvents().filter(({ owner }) => owner === 'controller');
		const principals = controllerRows.filter(({ actor }) => actor.kind === 'roles');
		const others = controllerRows.filter(({ actor }) => actor.kind !== 'roles');

		assert.ok(principals.length > 0);
		principals.forEach(({ event, fields, severity }) => {
			assert.ok(
				[...fields.always, ...fields.onRefusal].includes('reason'),
				`${event} carries no reason when refused`,
			);
			assert.ok(
				severity.kind === 'followsResult' || ('whenDenied' in severity && severity.whenDenied === 'warning'),
				`${event} records a refusal at another severity than warning`,
			);
		});
		assert.deepEqual(
			others.filter(({ severity }) => 'whenDenied' in severity).map(({ event }) => event),
			[],
		);
		assert.deepEqual(
			others.filter(({ fields }) => fields.onRefusal.length > 0).map(({ event }) => event),
			[],
		);
	});

	test("reads a refused management token's events and tallies apart from the events carrying a credential's reason elsewhere", () => {
		const line = (type: string, data: object): string =>
			JSON.stringify({
				data,
				id: randomUUID(),
				severity: 'warning',
				source: 'https://usher.example.org/controller',
				specversion: '1.0',
				time: '2026-11-04T12:00:00Z',
				type: emittedType(type),
			});
		const refusal = managementTokenRefusal(
			{ method: 'DELETE', route: '/admin/grants/{id}' },
			'expiredToken',
			'subject-of-the-refused-token',
		);
		const events = cloudEventsIn([
			line('managementToken.refusal', { ...refusal, sourceIp: '127.0.0.1' }),
			line('managementToken.refusalTally', {
				actorId: null,
				actorType: 'system',
				count: 3,
				firstSeenAt: '2026-11-04T11:55:00.000Z',
				lastSeenAt: '2026-11-04T11:58:00.000Z',
				reason: 'otherIssuer',
				windowId: 'the-opening-event',
			}),
			line('token.exchange', { reason: 'expiredToken', result: 'denied' }),
			line('grant.revocation', { reason: 'expiredToken', result: 'denied' }),
			line('grant.revocation', { reason: 'grantNotFound', result: 'denied' }),
		]);

		assert.deepEqual(refusal, {
			actorId: null,
			actorType: 'anonymous',
			method: 'DELETE',
			reason: 'expiredToken',
			refusedSubject: 'subject-of-the-refused-token',
			result: 'denied',
			route: '/admin/grants/{id}',
		});
		assert.deepEqual(managementTokenRefusalsIn(events), [refusal]);
		assert.deepEqual(refusalTalliesIn(events), [
			{
				actorId: null,
				actorType: 'system',
				carriesSubject: false,
				count: 3,
				reason: 'otherIssuer',
				windowId: 'the-opening-event',
			},
		]);
		assert.deepEqual(
			credentialRefusalsElsewhere(events).map(({ type }) => type),
			[emittedType('grant.revocation')],
		);
	});

	test('writes every instant in UTC, and names each refusal and fault reason by a fixed code', () => {
		assert.match('2026-10-23T12:00:00Z', EVENT_INSTANT_FORM);
		assert.match('2026-10-23T12:00:00.123456789Z', EVENT_INSTANT_FORM);
		assert.doesNotMatch('2026-10-23T12:00:00+00:00', EVENT_INSTANT_FORM);
		assert.doesNotMatch('2026-10-23T12:00:00', EVENT_INSTANT_FORM);
		assert.ok(
			[CHANNEL_ASSERTION_REJECTION_REASONS, EXCHANGE_REFUSAL_REASONS, FAULT_REASONS]
				.flatMap((reasons) => Object.entries(reasons))
				.every(([name, reason]) => name === reason),
		);
		assert.deepEqual(Object.values(FAULT_REASONS).toSorted(), [
			'cacheUnavailable',
			'directoryNotConfigured',
			'directoryUnavailable',
			'identityProviderUnavailable',
			'storeUnavailable',
		]);
		assert.deepEqual(Object.values(EXCHANGE_REFUSAL_REASONS).toSorted(), [
			'apiKeyVerifierNotConfigured',
			'excessiveLifetime',
			'expiredToken',
			'invalidSignature',
			'missingCredential',
			'missingExpiry',
			'missingIssuedAt',
			'missingSubject',
			'notYetValid',
			'otherAudience',
			'otherIssuer',
			'otherType',
			'revokedPlatform',
			'revokedPrincipal',
			'serviceAccountNotPermitted',
			'signedOutSession',
			'signingKeyUnconfirmed',
			'unreadableToken',
			'unrepresentableSubject',
		]);
		assert.deepEqual(Object.values(CHANNEL_ASSERTION_REJECTION_REASONS).toSorted(), [
			'excessiveLifetime',
			'expiredAssertion',
			'invalidSignature',
			'missingAssertion',
			'noLiveKey',
			'notYetValid',
			'otherAudience',
			'reusedAssertion',
			'unknownApplication',
			'unreadableAssertion',
		]);
	});
});

const loggedEvent = (type: string, data: unknown, extra: Readonly<Record<string, unknown>> = {}): string =>
	JSON.stringify({
		...extra,
		data,
		id: '7c9e2a14-3b6d-4f81-9a2e-5d4c3b2a1f09',
		severity: 'info',
		source: 'https://usher.example.org/controller',
		specversion: '1.0',
		time: '2026-10-23T12:00:00Z',
		type: emittedType(type),
	});

suite('reading the events a log stream holds', () => {
	test('reads the events of a type from a mark on, and their data', () => {
		const log = captureLog();
		log.stream.write(`${loggedEvent('grant.creation', { grantId: 'g-1' })}\n`);
		log.stream.write(`${JSON.stringify({ level: 'info', message: 'listening' })}\n`);
		log.stream.write(`${loggedEvent('grant.revocation', { grantId: 'g-1' })}\n`);
		log.stream.write(`${loggedEvent('grant.creation', { grantId: 'g-2' })}\n`);

		assert.equal(eventsIn(log).length, 3);
		assert.equal(eventsIn(log, 2).length, 2);
		assert.deepEqual(ofType(eventsIn(log), 'grant.creation').map(dataOf), [{ grantId: 'g-1' }, { grantId: 'g-2' }]);
		assert.deepEqual(eventDataOf(log, 'grant.creation', 1), [{ grantId: 'g-2' }]);
		assert.throws(() => dataOf({ data: ['not', 'an', 'object'] }), {
			message: "an event's data is not an object",
		});
	});

	test('waits for the events of a type to arrive, and fails naming the wait when they never do', async () => {
		const log = captureLog();
		setTimeout(() => {
			log.stream.write(`${loggedEvent('grant.creation', { grantId: 'g-1' })}\n`);
			log.stream.write(`${loggedEvent('grant.creation', { grantId: 'g-2' })}\n`);
		}, 50);

		const events = await awaitEventsOfType(log, 'grant.creation', { count: 2 });
		const data = await awaitEventData(log, 'grant.creation', { since: 1 });

		assert.equal(events.length, 2);
		assert.deepEqual(data, [{ grantId: 'g-2' }]);
		await assert.rejects(awaitEventData(log, 'grant.revocation', { timeoutMs: 150 }), {
			message: /never reached the log stream within 150 ms/u,
		});
	});

	test("finds the dry run's operational line, never an event naming the same message", () => {
		const log = captureLog();
		const counts = Object.fromEntries(Object.values(IMPORT_RUN_COUNTS).map((name, index) => [name, index]));
		const line = {
			[DRY_RUN_LOG_LINE.actorMember]: 'admin-0001',
			[DRY_RUN_LOG_LINE.message.member]: DRY_RUN_LOG_LINE.message.value,
			level: 'info',
			...counts,
		};
		log.stream.write(`${JSON.stringify(line)}\n`);
		log.stream.write(
			`${loggedEvent('import.run', counts, {
				[DRY_RUN_LOG_LINE.message.member]: DRY_RUN_LOG_LINE.message.value,
			})}\n`,
		);

		assert.deepEqual(dryRunLogLines(log), [line]);
	});
});

suite("the import's own event and the over-cap exchange's", () => {
	test('reads import.run as the administrator acting, carrying on success the counts listed below the table and a reason otherwise, at error when it fails and at warning otherwise, its writes caused by it', () => {
		const {
			actor,
			fields: { always, conditional, onRefusal, onSuccess },
			severity,
		} = registered(AUDIT_EVENT_TYPES.importRun);

		assert.deepEqual(
			{ actor, always, conditional, onRefusal, severity },
			{
				actor: { kind: 'roles', roles: ['admin'] },
				always: ['actorId'],
				conditional: [],
				onRefusal: ['reason'],
				severity: {
					byValue: { failed: 'error' },
					field: 'result',
					kind: 'byValue',
					otherwise: 'warning',
					whenDenied: 'warning',
				},
			},
		);
		assert.deepEqual(onSuccess.toSorted(), Object.values(IMPORT_RUN_COUNTS).toSorted());
		assert.equal(CAUSED_BY_MEMBER, 'causedBy');
		assert.deepEqual(IMPORT_ORIGIN_EVENT_TYPES.toSorted(), [
			'grant.creation',
			'grant.decision',
			'resource.registration',
		]);
	});

	test('names a token past the cap on its exchange event by the limit, the held count and the size', () => {
		assert.deepEqual(TOKEN_CAP_EVENT, {
			heldCountMember: 'heldResourceCount',
			reason: 'tokenOverResponseCap',
			sizeMember: 'tokenBytes',
			type: 'token.exchange',
		});
	});
});

suite("the audit log's rows, read", () => {
	test('reads every row in the order the events occurred, and each as JSON text', async (context) => {
		const database = await createTestDatabase();
		context.after(() => database.close());
		const owner = await database.connect('migration');
		await owner.query(
			"INSERT INTO usher.audit_log (id, occurred_at, type, source, spec_version, data_schema, severity, data) VALUES ('00000000-0000-4000-8000-000000000002', '2026-10-23T12:00:01.123456Z', 'bio.overture.grant.revocation', 'https://usher.example.org/controller', '1.0', NULL, 'info', '{\"grantId\": \"g-1\"}'), ('00000000-0000-4000-8000-000000000001', '2026-10-23T12:00:00Z', 'bio.overture.grant.creation', 'https://usher.example.org/controller', '1.0', NULL, 'info', '{\"grantId\": \"g-1\"}')",
		);

		// The template's own seeding event is held too; only the grants this test wrote are its rows.
		const rows = (await auditRows(owner)).filter(({ type }) => type.startsWith('bio.overture.grant.'));
		const texts = (await auditRowTexts(owner)).filter((text) => text.includes('"grantId"'));

		assert.deepEqual(
			rows.map(({ data, occurredAtKey, type }) => ({
				data,
				occurredAtKey,
				type,
			})),
			[
				{
					data: { grantId: 'g-1' },
					occurredAtKey: '2026-10-23T12:00:00.000000000',
					type: 'bio.overture.grant.creation',
				},
				{
					data: { grantId: 'g-1' },
					occurredAtKey: '2026-10-23T12:00:01.123456000',
					type: 'bio.overture.grant.revocation',
				},
			],
		);
		assert.equal(texts.length, 2);
		assert.ok(texts.every((text) => text.includes('"grantId": "g-1"')));
	});
});
