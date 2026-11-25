import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import pg from 'pg';

import type { ManagementRoute } from './admin.js';
import type { LogCapture } from './controller.js';
import { POLICY_TABLES, qualified } from './policy.js';
import { eventually } from './waiting.js';

/** `audit-events.md`, whose Events table the tests read their expectations from (G29). */
export const AUDIT_EVENTS_DOCUMENT = new URL('../../../../.dev/design/audit-events.md', import.meta.url);

/** The prefix every event type carries on the wire, which the table leaves out. */
export const EVENT_TYPE_PREFIX = 'bio.overture.';

/**
 * Every event type the tests name, by a name for it, without the prefix: the Controller's rows of
 * the Events table.
 */
export const AUDIT_EVENT_TYPES = Object.freeze({
	adminNomination: 'admin.nomination',
	adminNominationDecision: 'admin.nominationDecision',
	adminNominationRevocation: 'admin.nominationRevocation',
	adminOverride: 'admin.override',
	adminRemoval: 'admin.removal',
	admissionShareExceededTally: 'admission.shareExceededTally',
	applicationKeyConfirmation: 'applicationKey.confirmation',
	applicationKeyIssuance: 'applicationKey.issuance',
	applicationKeyRevocation: 'applicationKey.revocation',
	applicationKeyUnreadable: 'applicationKey.unreadable',
	applicationRegistration: 'application.registration',
	applicationServedResourcesChange: 'application.servedResourcesChange',
	auditRead: 'audit.read',
	categoryCreation: 'category.creation',
	categoryDescriptionChange: 'category.descriptionChange',
	channelAssertionRejection: 'channelAssertion.rejection',
	channelAssertionRejectionTally: 'channelAssertion.rejectionTally',
	grantCreation: 'grant.creation',
	grantDecision: 'grant.decision',
	grantExtension: 'grant.extension',
	grantRateExceeded: 'grant.rateExceeded',
	grantReduction: 'grant.reduction',
	grantRequest: 'grant.request',
	grantRequestDecision: 'grant.requestDecision',
	grantRevocation: 'grant.revocation',
	grantRulesChange: 'grantRules.change',
	grantSelfCreation: 'grant.selfCreation',
	identityProviderConfigurationChange: 'identityProvider.configurationChange',
	identityRevocation: 'identity.revocation',
	identityRevocationLift: 'identity.revocationLift',
	identitySignOut: 'identity.signOut',
	identitySignOutEveryone: 'identity.signOutEveryone',
	invitationClaim: 'invitation.claim',
	invitationCreation: 'invitation.creation',
	invitationLapse: 'invitation.lapse',
	logoutTokenRefusal: 'logoutToken.refusal',
	logoutTokenRefusalTally: 'logoutToken.refusalTally',
	managementTokenRefusal: 'managementToken.refusal',
	managementTokenRefusalTally: 'managementToken.refusalTally',
	importRun: 'import.run',
	ownershipTransfer: 'ownership.transfer',
	resourceDeletion: 'resource.deletion',
	resourceDetailsUpdate: 'resource.detailsUpdate',
	resourceOrphaned: 'resource.orphaned',
	resourceRegistration: 'resource.registration',
	resourceRestoration: 'resource.restoration',
	resourceRetirement: 'resource.retirement',
	resourceRevocation: 'resource.revocation',
	resourceSuppression: 'resource.suppression',
	settingsChange: 'settings.change',
	settingsSeeding: 'settings.seeding',
	tokenExchange: 'token.exchange',
	tokenExchangeRefusalTally: 'token.exchangeRefusalTally',
} as const);

/** An event type the tests name, without the prefix. */
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[keyof typeof AUDIT_EVENT_TYPES];

/**
 * The event of a grant's role change (ruled), without the prefix. The Events table has no row for it,
 * so it is kept apart from {@link AUDIT_EVENT_TYPES}, which holds its rows.
 */
export const RULED_GRANT_EVENT_TYPES = Object.freeze({
	grantRoleChange: 'grant.roleChange',
} as const);

/** A ruled grant event's type, without the prefix. */
export type RuledGrantEventType = (typeof RULED_GRANT_EVENT_TYPES)[keyof typeof RULED_GRANT_EVENT_TYPES];

/** An event's type a test reads, without the prefix: a row of the Events table, or a ruled one. */
export type RecordedEventType = AuditEventType | RuledGrantEventType;

/**
 * The Bridge's events, the keys of its catalogue. The Bridge keeps the catalogue internal, so its
 * names are copied here; when the Bridge adds one, add it. Follows `events.ts` `EVENT_CATALOGUE`.
 */
export const BRIDGE_EVENT_TYPES: readonly string[] = Object.freeze([
	'bridge.exchangeTimeoutShort',
	'bridge.internalError',
	'bridge.startRefusal',
	'catalogue.filterLimit',
	'catalogue.renderingMismatch',
	'catalogue.resourceListMissing',
	'category.unenforced',
	'category.unknown',
	'category.unmapped',
	'credential.malformed',
	'credential.refusal',
	'notice.applied',
	'revocationChannel.failure',
	'revocationChannel.malformed',
	'revocationChannel.modeChange',
	'revocationChannel.pushReconnect',
	'revocationChannel.reset',
	'token.exchangeFailure',
	'token.overtaken',
	'token.rejection',
]);

/** The rows `audit-events.md`'s Open items name post-MVP, which nothing emits in the first release. */
export const POST_MVP_EVENT_TYPES: readonly string[] = Object.freeze([
	'custodianship.assignment',
	'custodianship.removal',
	'grant.unguarded',
]);

/**
 * The Controller's rows written by the schema migration command rather than by a request, so no operation of the
 * Controller's emits them: the migration command records them in the store before the Controller starts.
 */
export const MIGRATION_EVENT_TYPES: readonly string[] = Object.freeze(['settings.seeding']);

/** A severity, as the table and the Bridge name them. */
export type Severity = 'critical' | 'error' | 'info' | 'warning';

/** One row of the Events table, each cell as written, the event type without its backticks. */
export interface EventsTableRow {
	actor: string;
	description: string;
	event: string;
	fields: string;
	severity: string;
}

/**
 * The field names a row registers, by when an event of its type carries them, as the clauses of its
 * fields cell say: always; only under a condition a clause states; or on success or on refusal alone,
 * as its `on success` and `on refusal` clauses say.
 */
export interface EventFieldSets {
	always: readonly string[];

	/**
	 * Fields carried only under the condition their clause states with `when` or `for`, such as
	 * `applicationId` when the assertion names a registered application.
	 */
	conditional: readonly string[];

	/**
	 * The members of each entry of a collection field, one per `each X` clause. Absent when no clause names any.
	 */
	entryMembers?: readonly EntryMembers[];

	onRefusal: readonly string[];
	onSuccess: readonly string[];
}

/**
 * The members each entry of a collection field carries, as an `each X` clause names them: `entries` is the
 * field X, carried always as a field of its own, and `names` are the members of each of its entries.
 */
export interface EntryMembers {
	entries: string;
	names: readonly string[];
}

/**
 * A row's severity, as its cell names it: one severity; one that follows the event's `result`; one
 * chosen by a field's value, as the key revocation's is by `reason`, the mode change's by `toMode`
 * and the import run's by `result`; category.unmapped's two, told apart by whether the event carries
 * a field; or two told apart by whether the start recording them is the store's first, which no field
 * carries. One severity or one chosen by value may give a denied result a
 * severity of its own, read before anything else.
 */
export type EventSeverity =
	| {
			field: string;
			kind: 'byField';
			withField: Severity;
			withoutField: Severity;
	  }
	| { atFirstStart: Severity; kind: 'byFirstStart'; otherwise: Severity }
	| {
			byValue: Readonly<Record<string, Severity>>;
			field: string;
			kind: 'byValue';
			otherwise: Severity;
			whenDenied?: Severity;
	  }
	| { kind: 'fixed'; severity: Severity; whenDenied?: Severity }
	| { kind: 'followsResult' }
	| {
			/**
			 * Each name a change of the event's `changes` list may name. General, not for one event: a severity by which
			 * names changed is `severity` when any of `names` is among the changes, `otherwise` when none is.
			 */
			kind: 'byChangedName';
			names: readonly string[];
			otherwise: Severity;
			severity: Severity;
			whenDenied?: Severity;
	  };

/**
 * A row's actor: `system` or `anonymous`, the two the Actor column names as `actorType` does, or the
 * roles it names otherwise (`Custodian, owner or admin`), which no `actorType` matches.
 */
export type EventActor = { kind: 'anonymous' | 'system' } | { kind: 'roles'; roles: readonly string[] };

/** Whose event a row is: the Bridge's, or the Controller's, every row neither the Bridge's nor post-MVP. */
export type EventOwner = 'bridge' | 'controller';

/**
 * What one row registers, read, with the note's rule for a refused request applied to every
 * Controller row whose Actor cell names a role: the principal whose request the Controller answers.
 * Such an event, refused, carries `reason` and records at `warning`, unless its cells say otherwise.
 */
export interface AuditEventRegistration {
	actor: EventActor;
	event: string;
	fields: EventFieldSets;
	owner: EventOwner;
	row: EventsTableRow;
	severity: EventSeverity;
}

const SEVERITIES: readonly Severity[] = ['critical', 'error', 'info', 'warning'];

/**
 * The severity cells telling their cases apart in prose rather than by a value a fields cell lists:
 * category.unmapped's, by whether the event carries the resource, which only a resource category's
 * does; and the mode change's, by the mode it enters. The Bridge's two follow its `events.test.ts`
 * `PER_CASE_SEVERITIES`.
 */
const PROSE_CASE_SEVERITIES: readonly {
	cell: string;
	severity: EventSeverity;
}[] = [
	{
		cell: '`critical` for a global category, `error` for a resource category',
		severity: {
			field: 'resourceId',
			kind: 'byField',
			withField: 'error',
			withoutField: 'critical',
		},
	},
	{
		cell: '`critical` into cold or uncertain, `info` into normal',
		severity: {
			byValue: { cold: 'critical', normal: 'info', uncertain: 'critical' },
			field: 'toMode',
			kind: 'byValue',
			otherwise: 'critical',
		},
	},
];

const FOLLOWS_RESULT = 'follows `result`';

const ON_REFUSAL = 'on refusal';

const ON_SUCCESS = 'on success';

// The field an action's outcome is carried in, and the values it takes.
const RESULT_FIELD = 'result';

const RESULT_VALUES: readonly string[] = ['denied', 'failed', 'succeeded'];

// The word opening the condition a field is carried under, as in "`count` when overloaded" or
// "`resourceId` for a resource category".
const CONDITION = /\b(?:for|when)\b/u;

// A fields clause naming no field of its own, for the names the event's note below the table lists.
const LISTED_BELOW = 'listed below the table';

// A list of backticked names in prose: "`a`, `b` and `c`".
const NAME_LIST = /`\w+`(?:, `\w+`)* and `\w+`/u;

// The clauses of a severity cell naming a severity per case: "`warning` when refused", "`critical` for
// `compromised`", with one value or several, and "else `info`".
const DENIED_CLAUSE = /^`(\w+)` when refused$/u;

const VALUE_CLAUSE = /^`(\w+)` for (`\w+`(?:(?:, | or )`\w+`)*)$/u;

const OTHERWISE_CLAUSE = /^else `(\w+)`$/u;

// A severity cell by which names changed: "`critical` when `a`, `b` or `c` changed; `warning` otherwise".
const CHANGED_NAMES_CELL = /^`(\w+)` when (`\w+`(?:(?:, | or )`\w+`)*) changed; `(\w+)` otherwise$/u;

// A severity by which names changed, beside a refusal's: "`warning` when refused; " and then the changed-names cell.
const REFUSED_CHANGED_NAMES_CELL = /^`(\w+)` when refused; (.+)$/u;

/**
 * The note's rule for a refused Management API request: the operation's own event, `denied`, carrying
 * the code answered as `reason`, at `warning`, whether it was refused for authority or for content.
 */
const REFUSED_REQUEST = Object.freeze({
	reasonMember: 'reason',
	severity: 'warning',
} as const);

const unreadable = (what: string, cell: string): never => {
	throw new Error(`no ${what} can be read from "${cell}"`);
};

// The lines under the `## Events` heading, up to the next heading of its level.
const eventsSection = (markdown: string): readonly string[] => {
	const lines = markdown.split('\n');
	const section = lines.slice(lines.indexOf('## Events') + 1);
	const end = section.findIndex((line) => line.startsWith('## '));
	return section.slice(0, end === -1 ? section.length : end);
};

/**
 * The rows of the table under the `## Events` heading of a markdown document, each cell found by its
 * column's header, and each event type without its backticks. Follows `events.test.ts` `eventRows`.
 *
 * @param markdown the document.
 */
export const eventsTableRows = (markdown: string): readonly EventsTableRow[] => {
	const table = eventsSection(markdown)
		.filter((line) => line.startsWith('|'))
		.map((line) =>
			line
				.split('|')
				.slice(1, -1)
				.map((cell) => cell.trim()),
		);
	const header = table[0] ?? [];
	const cellOf = (cells: readonly string[], column: string): string =>
		cells[header.indexOf(column)] ?? unreadable(`${column} cell`, cells.join(' | '));
	return table.slice(2).map((cells) => ({
		actor: cellOf(cells, 'Actor'),
		description: cellOf(cells, 'Description'),
		event: cellOf(cells, 'Event type').replaceAll('`', ''),
		fields: cellOf(cells, 'Additional required fields'),
		severity: cellOf(cells, 'Severity'),
	}));
};

// The paragraphs of the Events section outside its table, each on one line.
const notesIn = (markdown: string): readonly string[] =>
	eventsSection(markdown)
		.filter((line) => !line.startsWith('|'))
		.join('\n')
		.split(/\n\s*\n/u)
		.map((paragraph) => paragraph.replaceAll('\n', ' ').trim());

const withoutParentheses = (text: string): string => text.replaceAll(/\([^)]*\)/gu, '');

const backtickedIn = (text: string): readonly string[] =>
	Array.from(text.matchAll(/`(\w+)`/gu), ([, name]) => name ?? '');

// The names listed in the note below the table whose bold lead opens with an event's type, such as
// `import.run`'s counts.
const namesListedFor = (notes: readonly string[], event: string): readonly string[] =>
	backtickedIn(notes.find((note) => note.startsWith(`**\`${event}\``))?.match(NAME_LIST)?.[0] ?? '');

// A clause's items, split at its commas once its parentheses, which hold values its fields may take,
// are gone. Follows `events.test.ts` `fieldNamesIn` in leaving those values out.
const itemsOf = (clause: string): readonly string[] =>
	withoutParentheses(clause)
		.split(',')
		.map((item) => item.trim());

// An item's field names, and whether a condition carries them. A condition's names are those before
// its `when` or `for`: a name after that word is part of the condition, as the `sub` a length is
// measured on.
const fieldsOfItem = (item: string): { conditional: boolean; names: readonly string[] } => {
	const condition = item.search(CONDITION);
	return condition === -1
		? { conditional: false, names: backtickedIn(item) }
		: { conditional: true, names: backtickedIn(item.slice(0, condition)) };
};

// An item leading with `each` names no field of its own: it may name a field the event carries already,
// or a count the table leaves to prose.
const EACH_ITEM = /^each\b/u;

// An item leading with `each` and a backticked name opens the members of each entry of the field before it.
const EACH_ENTRY_ITEM = /^each `\w+`/u;

// A clause's items before its first `each X` item, and the items from it on: the members of each entry of X.
const splitAtEachEntry = (clause: string): { fields: readonly string[]; members: readonly string[] } => {
	const items = itemsOf(clause);
	const start = items.findIndex((item) => EACH_ENTRY_ITEM.test(item));
	return start === -1
		? { fields: items, members: [] }
		: { fields: items.slice(0, start), members: items.slice(start) };
};

/**
 * The field names a fields cell registers, by the clauses its semicolons divide it into and the items
 * its commas divide each clause into. An `on success` or `on refusal` clause's names are carried on
 * that result alone, and every other clause's are carried always. An item naming a condition with
 * `when` or `for` carries the names before that word only under the condition, in any clause. An item
 * naming no field and pointing below the table takes the names listed there. An `each X` clause's names
 * are the members of each entry of X, which X, the field before it, carries always. A cell reading `none`
 * registers no field.
 *
 * @param cell the cell.
 * @param listedBelow the names the event's note below the table lists: none by default.
 * @throws when the cell names no field and is not `none`, points below the table and nothing is listed
 * there, or has an `each X` clause outside a clause carried always.
 */
export const fieldSetsIn = (cell: string, listedBelow: readonly string[] = []): EventFieldSets => {
	const clauses = cell.split(';').map((clause) => clause.trim());
	const namesOf = (items: readonly string[], underCondition: boolean): readonly string[] =>
		items
			.filter((item) => !EACH_ITEM.test(item))
			.flatMap((item) => {
				const { conditional, names } = fieldsOfItem(item);
				if (conditional !== underCondition) {
					return [];
				}
				if (names.length === 0 && item.includes(LISTED_BELOW)) {
					return listedBelow.length > 0 ? listedBelow : unreadable('field name listed below the table', cell);
				}
				return names;
			});
	const byResult = (clause: string): boolean => clause.startsWith(ON_SUCCESS) || clause.startsWith(ON_REFUSAL);
	const fieldsOfClause = (clause: string): readonly string[] => splitAtEachEntry(clause).fields;
	const namesWhere = (holds: (clause: string) => boolean): readonly string[] =>
		clauses.filter(holds).flatMap((clause) => namesOf(fieldsOfClause(clause), false));
	const entryMembersOf = (clause: string): readonly EntryMembers[] => {
		const { fields, members } = splitAtEachEntry(clause);
		if (members.length === 0) {
			return [];
		}
		if (byResult(clause)) {
			return unreadable('each clause outside a clause carried always', cell);
		}
		const entries = namesOf(fields, false).at(-1);
		const names = members.flatMap((item) => {
			const { conditional, names: memberNames } = fieldsOfItem(item);
			return conditional ? unreadable('member of an each clause under a condition', cell) : memberNames;
		});
		return [{ entries: entries ?? unreadable('field an each clause belongs to', cell), names }];
	};
	const fieldSets: EventFieldSets = {
		always: namesWhere((clause) => !byResult(clause)),
		conditional: clauses.flatMap((clause) => namesOf(fieldsOfClause(clause), true)),
		onRefusal: namesWhere((clause) => clause.startsWith(ON_REFUSAL)),
		onSuccess: namesWhere((clause) => clause.startsWith(ON_SUCCESS)),
	};
	const entryMembers = clauses.flatMap((clause) => entryMembersOf(clause));
	const readFieldSets = entryMembers.length > 0 ? { ...fieldSets, entryMembers } : fieldSets;
	return Object.values(fieldSets).flat().length > 0 || cell === 'none'
		? readFieldSets
		: unreadable('field name', cell);
};

// One clause of a severity cell naming a severity per case.
type SeverityClause =
	| { kind: 'denied' | 'otherwise'; severity: Severity }
	| { kind: 'values'; severity: Severity; values: readonly string[] };

const severityNamed = (name: string | undefined, cell: string): Severity =>
	SEVERITIES.find((severity) => severity === name) ?? unreadable('severity', cell);

const severityClauseIn = (clause: string, cell: string): SeverityClause => {
	const denied = DENIED_CLAUSE.exec(clause);
	if (denied !== null) {
		return { kind: 'denied', severity: severityNamed(denied[1], cell) };
	}
	const otherwise = OTHERWISE_CLAUSE.exec(clause);
	if (otherwise !== null) {
		return { kind: 'otherwise', severity: severityNamed(otherwise[1], cell) };
	}
	const values = VALUE_CLAUSE.exec(clause);
	if (values !== null) {
		return {
			kind: 'values',
			severity: severityNamed(values[1], cell),
			values: backtickedIn(values[2] ?? ''),
		};
	}
	return unreadable('severity', cell);
};

// The field a fields cell lists a value for, in the parentheses after its name.
const fieldListing = (fieldsCell: string, value: string): string | undefined =>
	Array.from(fieldsCell.matchAll(/`(\w+)` \(([^)]*)\)/gu)).find(([, , listed]) =>
		backtickedIn(listed ?? '').includes(value),
	)?.[1];

// The field a value of a `for` clause belongs to: the one the fields cell lists it for, or `result`
// for a value of `result` the cell lists for no field.
const fieldOfValue = (fieldsCell: string, value: string): string | undefined =>
	fieldListing(fieldsCell, value) ?? (RESULT_VALUES.includes(value) ? RESULT_FIELD : undefined);

// A severity cell naming a severity per case, each value's field found by `fieldOfValue`.
const casedSeverityIn = (cell: string, fieldsCell: string): EventSeverity => {
	const clauses = cell.split(';').map((clause) => severityClauseIn(clause.trim(), cell));
	const severityOf = (kind: SeverityClause['kind']): Severity | undefined =>
		clauses.find((clause) => clause.kind === kind)?.severity;
	const otherwise = severityOf('otherwise') ?? unreadable('severity for every other case', cell);
	const whenDenied = severityOf('denied');
	const denied = whenDenied === undefined ? {} : { whenDenied };
	const byValue = Object.fromEntries(
		clauses.flatMap((clause) =>
			clause.kind === 'values' ? clause.values.map((value): [string, Severity] => [value, clause.severity]) : [],
		),
	);
	const fields = [
		...new Set(
			Object.keys(byValue).map(
				(value) => fieldOfValue(fieldsCell, value) ?? unreadable(`field listing \`${value}\``, cell),
			),
		),
	];
	const [field, ...others] = fields;
	if (field === undefined) {
		return { kind: 'fixed', severity: otherwise, ...denied };
	}
	return others.length === 0
		? { byValue, field, kind: 'byValue', otherwise, ...denied }
		: unreadable('severity chosen by one field', cell);
};

/**
 * The severity a severity cell registers: one backticked severity; one that follows `result`; one of
 * the cells telling their cases apart in prose; or one per case, by the clauses its semicolons divide
 * it into, `when refused` for a denied result, `for` values of one field, and `else` for every other
 * case, as `` `warning` when refused; `critical` for `compromised`; else `info` `` reads. A `for`
 * clause's value belongs to the field its fields cell lists it for, and a value of `result`
 * (`succeeded`, `denied` or `failed`) the cell lists for no field belongs to `result`, which every
 * action carries, so `` `error` for `failed`; else `warning` `` is chosen by `result`.
 *
 * @param cell the cell.
 * @param fieldsCell the row's fields cell, naming the field each value of a `for` clause belongs to:
 * none by default.
 * @throws for any other cell, for a value no field lists that is not a value of `result`, or for
 * values of two fields.
 */
export const severityIn = (cell: string, fieldsCell: string = ''): EventSeverity => {
	const single = SEVERITIES.find((severity) => cell === `\`${severity}\``);
	if (single !== undefined) {
		return { kind: 'fixed', severity: single };
	}
	if (cell === FOLLOWS_RESULT) {
		return { kind: 'followsResult' };
	}
	const refused = REFUSED_CHANGED_NAMES_CELL.exec(cell);
	const changed = CHANGED_NAMES_CELL.exec(refused?.[2] ?? cell);
	if (changed !== null) {
		return {
			kind: 'byChangedName',
			names: backtickedIn(changed[2] ?? ''),
			otherwise: severityNamed(changed[3], cell),
			severity: severityNamed(changed[1], cell),
			...(refused === null ? {} : { whenDenied: severityNamed(refused[1], cell) }),
		};
	}
	return (
		PROSE_CASE_SEVERITIES.find((perCase) => perCase.cell === cell)?.severity ?? casedSeverityIn(cell, fieldsCell)
	);
};

/**
 * The actor an Actor cell names: `system` or `anonymous`, or the roles it lists, lower-cased.
 *
 * @param cell the cell, such as `Custodian, owner or admin`.
 */
export const actorIn = (cell: string): EventActor => {
	const kind = cell.toLowerCase();
	if (kind === 'system' || kind === 'anonymous') {
		return { kind };
	}
	return {
		kind: 'roles',
		roles: kind
			.split(/,|\bor\b/u)
			.map((role) => role.trim())
			.filter((role) => role.length > 0),
	};
};

/**
 * Whose event a type is, or `undefined` for a post-MVP row: the Bridge's when its catalogue names it,
 * the Controller's otherwise. The table partitions the same way where every Bridge row's description
 * begins "Bridge", as the Bridge's copy of it does.
 *
 * @param event the event type, without the prefix.
 */
export const ownerOf = (event: string): EventOwner | undefined => {
	if (POST_MVP_EVENT_TYPES.includes(event)) {
		return undefined;
	}
	return BRIDGE_EVENT_TYPES.includes(event) ? 'bridge' : 'controller';
};

// A refusable row's field sets, carrying `reason` on refusal unless they carry it already.
const withRefusalReason = (fields: EventFieldSets): EventFieldSets =>
	[...fields.always, ...fields.onRefusal].includes(REFUSED_REQUEST.reasonMember)
		? fields
		: {
				...fields,
				onRefusal: [...fields.onRefusal, REFUSED_REQUEST.reasonMember],
			};

// A refusable row's severity, giving a denied result its own unless its cell gives one or its
// severity follows `result`.
const withRefusalSeverity = (severity: EventSeverity): EventSeverity =>
	(severity.kind === 'fixed' || severity.kind === 'byValue') && severity.whenDenied === undefined
		? { ...severity, whenDenied: REFUSED_REQUEST.severity }
		: severity;

/**
 * What every row of the Events table registers, read, the post-MVP rows left out, and the note's rule
 * for a refused request applied as {@link AuditEventRegistration} says.
 *
 * @param markdown the document: `audit-events.md` by default.
 * @throws naming the cell, when a row's fields, severity or actor cannot be read.
 */
export const readAuditEvents = (
	markdown: string = readFileSync(AUDIT_EVENTS_DOCUMENT, 'utf8'),
): readonly AuditEventRegistration[] => {
	const notes = notesIn(markdown);
	return eventsTableRows(markdown).flatMap((row) => {
		const owner = ownerOf(row.event);
		if (owner === undefined) {
			return [];
		}
		const actor = actorIn(row.actor);
		const fields = fieldSetsIn(row.fields, namesListedFor(notes, row.event));
		const severity = severityIn(row.severity, row.fields);
		const refusable = owner === 'controller' && actor.kind === 'roles';
		return [
			{
				actor,
				event: row.event,
				fields: refusable ? withRefusalReason(fields) : fields,
				owner,
				row,
				severity: refusable ? withRefusalSeverity(severity) : severity,
			},
		];
	});
};

/**
 * An event type as it is emitted: with the prefix.
 *
 * @param event the event type, as the table names it.
 */
export const emittedType = (event: string): string => `${EVENT_TYPE_PREFIX}${event}`;

/**
 * The counts an `import.run` event carries on success, as the note below the Events table lists
 * them, each by the member naming it: the holdings of an all-study policy the report lists, one a
 * holding as its `allStudyAccess` lists them; the studies holding data without a policy; the grants
 * the run wrote; the resources it registered without an owner; the memberships naming the
 * administrator running the run, which are never written; and the studies it registered, reported
 * and skipped. The dry run's operational line ({@link DRY_RUN_LOG_LINE}) carries the same ones.
 */
export const IMPORT_RUN_COUNTS = Object.freeze({
	allStudyHoldings: 'allStudyHoldings',
	dataWithoutPolicy: 'dataWithoutPolicy',
	grantsWritten: 'grantsWritten',
	resourcesWithoutOwner: 'resourcesWithoutOwner',
	selfGrantsRefused: 'selfGrantsRefused',
	studiesRegistered: 'studiesRegistered',
	studiesReported: 'studiesReported',
	studiesSkipped: 'studiesSkipped',
} as const);

/**
 * The Controller's rows of the Events table no operation of this epic produces, each with why, so a
 * table-driven suite tells them from a row nothing scripts.
 */
export const NOT_EMITTED_IN_THIS_EPIC: Readonly<Partial<Record<AuditEventType, string>>> = Object.freeze({
	'admin.override': 'no operation bypassing an instance restriction is defined',
	'invitation.claim': 'no invitation operation exists in this epic',
	'invitation.creation': 'no invitation operation exists in this epic',
	'invitation.lapse': 'no invitation operation exists in this epic',
	'ownership.transfer': 'admin.ts holds no ownership transfer operation (#214 Q14)',
	'resource.orphaned': 'post-MVP in the first release (#214 Q20)',
});

/**
 * The severity a `byChangedName` severity gives an event whose `changes` list names each change's `name`:
 * `severity` when any of the severity's names is among them, `otherwise` when none is.
 *
 * @param severity the severity, read from its cell by {@link severityIn}.
 * @param data the event's data; a `changes` list of `{ name, ... }` entries, or none.
 */
export const severityOfChanges = (
	severity: Extract<EventSeverity, { kind: 'byChangedName' }>,
	data: Readonly<Record<string, unknown>>,
): Severity => {
	const changed = Array.isArray(data['changes'])
		? data['changes'].map((change: unknown) =>
				change !== null && typeof change === 'object' ? String(Reflect.get(change, 'name')) : '',
			)
		: [];
	return severity.names.some((name) => changed.includes(name)) ? severity.severity : severity.otherwise;
};

/**
 * The CloudEvents extension attribute an event's line carries its severity in (#214 Q2), as the
 * Bridge names it.
 */
export const SEVERITY_ATTRIBUTE = 'severity';

/**
 * The member of a log line naming the logger's level, at which a critical event is written as the
 * logger's error level (#214 Q2).
 */
export const LOG_LEVEL_MEMBER = 'level';

/**
 * How every instant in an event is written, `time` and any instant in `data` alike (ruled): RFC 3339
 * in UTC, with the `Z` designator and any fraction of a second.
 */
export const EVENT_INSTANT_FORM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

/**
 * The member of a `grant.revocation` naming the event that caused it (ruled). A retirement emits one
 * `resource.retirement`, its `grantCount` counting the owner grants it ended and naming none, and one
 * `grant.revocation` per owner grant it ended, its reason the system-assigned `resourceRetired`
 * (admin.ts's `SYSTEM_ASSIGNED_REASONS`), its actor the retiring administrator, and this member holding
 * the `resource.retirement` event's CloudEvents `id`, so who lost access and when is answerable from
 * the trail itself.
 */
export const CAUSED_BY_MEMBER = 'causedBy';

/**
 * The member marking an event as the EGO import's, and its value (ruled, #216 Q8 option 2 and Q15),
 * named here alone: `resource.registration`, `grant.creation` and `grant.decision` carry `origin`
 * `import` for each write an import's real run makes, the imported submitters' recorded
 * acceptances included, whose actor is the administrator who ran it. An event of a write made through
 * any other operation carries no `origin` (assumed). The decision row's own mark is policy.ts's
 * `DECISION_ORIGIN_COLUMN`, holding the same value.
 */
export const IMPORT_ORIGIN = Object.freeze({
	member: 'origin',
	value: 'import',
} as const);

/**
 * The events carrying {@link IMPORT_ORIGIN} for the import's writes (ruled, #216 Q15), each also
 * carrying {@link CAUSED_BY_MEMBER} holding the CloudEvents `id` of the `import.run` event of the run
 * that wrote it (ruled, "#216's export details, member reasons and the run's event" 3), so every
 * registration, grant and decision a run writes is answerable from the trail to that run.
 */
export const IMPORT_ORIGIN_EVENT_TYPES: readonly AuditEventType[] = Object.freeze([
	'grant.creation',
	'grant.decision',
	'resource.registration',
]);

/**
 * The one operational log line a dry run of the EGO import writes (ruled: at info, naming the
 * administrator and the counts, since the directory read leaves a trace; the member names assumed): a
 * line carrying no CloudEvents envelope, its `message` naming it, its `level` the logger's info,
 * `actorId` the administrator's subject, and the run's counts under {@link IMPORT_RUN_COUNTS}' names.
 */
export const DRY_RUN_LOG_LINE = Object.freeze({
	actorMember: 'actorId',
	message: Object.freeze({
		member: 'message',
		value: 'egoImport.dryRun',
	} as const),
} as const);

/**
 * The operational line a start writes, at warning, for each grant its database role holds beyond
 * the writes the release's migrations grant it (the name assumed): its `message` naming it, the
 * grant's `object` and `privilege`, and its `column` for a grant on one column.
 */
export const GRANT_BEYOND_USE_LOG_LINE = Object.freeze({
	message: Object.freeze({
		member: 'message',
		value: 'store.grantBeyondUse',
	} as const),
} as const);

/**
 * How the exchange's event names a token past the Bridge's response cap (ruled, "#215's role route
 * and the held-grant scale" 2: the limit, the principal's held count and the token's size, never an
 * id; the names assumed until Usher's docs pass): the `token.exchange` event, its `reason` this limit's
 * fixed code, with the principal's held resource count and the token's size in bytes, never a
 * resource's id.
 */
export const TOKEN_CAP_EVENT = Object.freeze({
	heldCountMember: 'heldResourceCount',
	reason: 'tokenOverResponseCap',
	sizeMember: 'tokenBytes',
	type: AUDIT_EVENT_TYPES.tokenExchange,
} as const);

/**
 * The reasons a refused `token.exchange` records (ruled), each a fixed code naming the credential's
 * fault, never a value from it. A malformed sign-in token, one shaped like a JWT that can't be read, is
 * `unreadableToken`. An opaque credential, which is not a JWT, goes to an API key verifier, and with
 * none configured it is refused as `apiKeyVerifierNotConfigured`, a code naming the configuration's
 * state rather than the credential, so the verifier's own reasons can sit beside it when API keys land. A
 * token verifying under the trusted issuer and naming no `exp` is `missingExpiry` (ruled), not
 * `expiredToken`: the fault is an identity provider issuing tokens with no lifetime, not a clock or a
 * session's length, and the exchange and the Management API name it alike. One naming no `iat` is
 * `missingIssuedAt`, and one whose `exp` falls more than the configured maximum lifetime after its
 * `iat` is `excessiveLifetime`, at both (ruled), each judged after the `exp` and before any standing
 * is read. A token issued before a sign-out of everyone is `signedOutEveryone` at both. A `credential`
 * holding empty text is `missingCredential`. A token not marked as an access token by its identity provider's
 * connector is `otherType`, one naming no `sub` is `missingSubject`, and one whose `sub` or `sid`
 * holds text that cannot be stored is `unrepresentableSubject`, each read from the token's contents
 * and naming no subject. A service account's token is `serviceAccountNotPermitted`, as at the
 * Management API. A token whose signing key is not confirmed yet is `signingKeyUnconfirmed`,
 * denied rather than failed, since a made-up key id or a routine key rotation produces it.
 */
export const EXCHANGE_REFUSAL_REASONS = Object.freeze({
	apiKeyVerifierNotConfigured: 'apiKeyVerifierNotConfigured',
	excessiveLifetime: 'excessiveLifetime',
	expiredToken: 'expiredToken',
	invalidSignature: 'invalidSignature',
	missingCredential: 'missingCredential',
	missingExpiry: 'missingExpiry',
	missingIssuedAt: 'missingIssuedAt',
	missingSubject: 'missingSubject',
	notYetValid: 'notYetValid',
	otherAudience: 'otherAudience',
	otherIssuer: 'otherIssuer',
	otherType: 'otherType',
	revokedPrincipal: 'revokedPrincipal',
	serviceAccountNotPermitted: 'serviceAccountNotPermitted',
	signedOutEveryone: 'signedOutEveryone',
	signedOutSession: 'signedOutSession',
	signingKeyUnconfirmed: 'signingKeyUnconfirmed',
	unreadableToken: 'unreadableToken',
	unrepresentableSubject: 'unrepresentableSubject',
} as const);

/**
 * The reasons a `managementToken.refusal` records for a management token that verifies under the
 * trusted issuer and is still refused (ruled), in the order the table lists them. Each is one of
 * {@link EXCHANGE_REFUSAL_REASONS}. A refused `token.exchange` names the token's subject, in
 * {@link REFUSED_SUBJECT_MEMBER}, for each of them but `missingSubject`, `otherType` and
 * `unrepresentableSubject`.
 */
export const MANAGEMENT_TOKEN_REFUSAL_REASONS: readonly string[] = Object.freeze([
	EXCHANGE_REFUSAL_REASONS.excessiveLifetime,
	EXCHANGE_REFUSAL_REASONS.expiredToken,
	EXCHANGE_REFUSAL_REASONS.missingExpiry,
	EXCHANGE_REFUSAL_REASONS.missingIssuedAt,
	EXCHANGE_REFUSAL_REASONS.missingSubject,
	EXCHANGE_REFUSAL_REASONS.notYetValid,
	EXCHANGE_REFUSAL_REASONS.otherAudience,
	EXCHANGE_REFUSAL_REASONS.otherType,
	EXCHANGE_REFUSAL_REASONS.revokedPrincipal,
	EXCHANGE_REFUSAL_REASONS.signedOutEveryone,
	EXCHANGE_REFUSAL_REASONS.signedOutSession,
	EXCHANGE_REFUSAL_REASONS.unrepresentableSubject,
]);

/**
 * The reasons a `managementToken.refusal` records for a management credential it could not read or
 * verify (ruled), in the order the table lists them after {@link MANAGEMENT_TOKEN_REFUSAL_REASONS}:
 * a credential that cannot be read, `malformedCredential`, as two `Authorization` headers or one sent
 * in the query cannot, which the Management API alone names; or one that cannot be verified, each of
 * those one of {@link EXCHANGE_REFUSAL_REASONS}. Such a refusal names no subject.
 */
export const UNVERIFIED_MANAGEMENT_CREDENTIAL_REASONS: readonly string[] = Object.freeze([
	'malformedCredential',
	EXCHANGE_REFUSAL_REASONS.unreadableToken,
	EXCHANGE_REFUSAL_REASONS.otherIssuer,
	EXCHANGE_REFUSAL_REASONS.invalidSignature,
]);

/**
 * The member naming a refused token's subject (ruled): the `sub` of a sign-in or management token
 * whose signature verifies under the trusted issuer and which is refused anyway. It is a member of its
 * own and never the actor, which stays anonymous with a `null` `actorId`. It holds a `sub` of up to
 * {@link REFUSED_SUBJECT_MAXIMUM_LENGTH} characters whole, and is left out for a longer one, never
 * truncated. Within that length, a `managementToken.refusal` carries it for `excessiveLifetime`,
 * `expiredToken`, `missingExpiry`, `missingIssuedAt`, `notYetValid`, `otherAudience`, `otherType`,
 * `revokedPrincipal`, `signedOutEveryone` and `signedOutSession`, and a refused `token.exchange` for
 * `excessiveLifetime`, `expiredToken`, `missingExpiry`, `missingIssuedAt`, `notYetValid`,
 * `otherAudience`, `revokedPrincipal`, `signedOutEveryone`, `signedOutSession` and
 * `serviceAccountNotPermitted` alone, once the token's signature verifies. Neither carries it for
 * `missingSubject` or `unrepresentableSubject`, and `otherType` names it at the Management API alone.
 * A refusal of a credential whose signature does not verify (`unreadableToken`, `otherIssuer`,
 * `invalidSignature`, and at the Management API `malformedCredential`), or at the exchange of an
 * opaque credential (`apiKeyVerifierNotConfigured`), leaves it out, never empty and never `null`, so
 * a forged token cannot put anyone's subject in the trail. No window's closing event carries a
 * subject, and neither does the Bridge's `credential.refusal`.
 */
export const REFUSED_SUBJECT_MEMBER = 'refusedSubject';

/**
 * The longest `sub` {@link REFUSED_SUBJECT_MEMBER} records, in characters (ruled): 255; a longer one
 * leaves the member out, never truncated.
 */
export const REFUSED_SUBJECT_MAXIMUM_LENGTH = 255;

/**
 * How long a window of refusals stays open once its key goes without a refusal (ruled): 10 minutes,
 * measured on the Controller's configured clock, as is every duration measured by the Controller.
 */
export const REFUSAL_WINDOW_COOLDOWN_MILLISECONDS = 600_000;

/** How long after it opened a window of refusals closes, however often refusals come (ruled): 60 minutes. */
export const REFUSAL_WINDOW_CEILING_MILLISECONDS = 3_600_000;

/** The most windows one instance holds open for single tokens at once (ruled). */
export const PER_TOKEN_WINDOW_LIMIT = 10_000;

/**
 * How soon after a test moves the Controller's clock past a window's close it expects the window's
 * closing event, in real time: 5 s, since nothing fixes how often the Controller reads its clock
 * (assumed).
 */
export const WINDOW_CLOSED_WITHIN_MS = 5_000;

/**
 * What a test compares of a `managementToken.refusal`: its actor, result, reason, the refused token's
 * subject and the operation.
 */
export interface ManagementTokenRefusal {
	actorId: unknown;
	actorType: unknown;
	method: unknown;
	reason: unknown;
	refusedSubject: unknown;
	result: unknown;
	route: unknown;
}

/**
 * The `managementToken.refusal` a refused management credential records as it opens a window
 * (ruled): no actor but an anonymous one, `denied`, the reason, a verified token's subject as
 * {@link REFUSED_SUBJECT_MEMBER}, none for a credential that did not verify, and the operation's
 * method and route.
 *
 * @param operation the operation matched, as admin.ts's `managementRouteOfOperation` reads it.
 * @param reason one of {@link MANAGEMENT_TOKEN_REFUSAL_REASONS} or
 *   {@link UNVERIFIED_MANAGEMENT_CREDENTIAL_REASONS}.
 * @param refusedSubject the refused token's `sub`, for a token that verified.
 */
export const managementTokenRefusal = (
	{ method, route }: ManagementRoute,
	reason: string,
	refusedSubject?: string,
): ManagementTokenRefusal => ({
	actorId: null,
	actorType: 'anonymous',
	method,
	reason,
	refusedSubject,
	result: 'denied',
	route,
});

/**
 * The `managementToken.refusal` events among some, in their order, each as a test compares it.
 *
 * @param events the events.
 */
export const managementTokenRefusalsIn = (events: readonly CloudEvent[]): readonly ManagementTokenRefusal[] =>
	ofType(events, AUDIT_EVENT_TYPES.managementTokenRefusal)
		.map(dataOf)
		.map(({ actorId, actorType, method, reason, refusedSubject, result, route }) => ({
			actorId,
			actorType,
			method,
			reason,
			refusedSubject,
			result,
			route,
		}));

/**
 * The `managementToken.refusalTally` events among some, in their order, each a window's closing:
 * its actor, reason and count, the opening event it names as `windowId`, and whether it carries a
 * subject, which none does (ruled).
 *
 * @param events the events.
 */
export const refusalTalliesIn = (events: readonly CloudEvent[]): readonly Readonly<Record<string, unknown>>[] =>
	ofType(events, AUDIT_EVENT_TYPES.managementTokenRefusalTally)
		.map(dataOf)
		.map((data) => ({
			actorId: data['actorId'],
			actorType: data['actorType'],
			carriesSubject: Object.hasOwn(data, REFUSED_SUBJECT_MEMBER),
			count: data['count'],
			reason: data['reason'],
			windowId: data['windowId'],
		}));

/**
 * The events among some, the `managementToken.refusal` events aside, carrying a credential refusal's
 * reason: none, since no operation's own event carries one (ruled).
 *
 * @param events the events.
 */
export const credentialRefusalsElsewhere = (events: readonly CloudEvent[]): readonly CloudEvent[] =>
	events.filter(
		(event) =>
			event.type !== emittedType(AUDIT_EVENT_TYPES.managementTokenRefusal) &&
			event.type !== emittedType(AUDIT_EVENT_TYPES.managementTokenRefusalTally) &&
			event.type !== emittedType(AUDIT_EVENT_TYPES.tokenExchange) &&
			[...MANAGEMENT_TOKEN_REFUSAL_REASONS, ...UNVERIFIED_MANAGEMENT_CREDENTIAL_REASONS]
				.map(String)
				.includes(String(dataOf(event)['reason'])),
	);

/**
 * The reasons a refused channel assertion is recorded under (ruled), one fixed code per cause, never a
 * value from the assertion:
 *
 * - `missingAssertion`: no `Authorization` header, or one holding `Bearer` and nothing;
 * - `unreadableAssertion`: a `typ` other than `usher-channel+jwt`, or anything that does not parse;
 * - `unknownApplication`: an application id never registered;
 * - `noLiveKey`: an application holding no live key;
 * - `invalidSignature`: an assertion verified under none of its application's live keys;
 * - `otherAudience`: an `aud` other than `usher:controller`;
 * - `excessiveLifetime`: a lifetime over 60 s;
 * - `expiredAssertion`: an assertion past its `exp`, though signed under a live key;
 * - `notYetValid`: an assertion whose `iat` is ahead of the Controller's clock, though signed under a
 *   live key;
 * - `reusedAssertion`: an assertion presented a second time, which only a copy of it can be;
 * - `unrepresentableJti`: an assertion whose `jti` holds a NUL character or an unpaired surrogate.
 *
 * Every such refusal is answered with one identical 401, so the code is in the Controller's log
 * alone. {@link CHANNEL_ASSERTION_TALLY_REASONS} are always counted, and
 * {@link CHANNEL_ASSERTION_VERIFIED_REJECTION_REASONS} recorded on each instance's first refusal of
 * each assertion and counted on every later one. `unknownApplication` and
 * `invalidSignature` need a forged assertion, so their cases are the developer's own suites'.
 */
export const CHANNEL_ASSERTION_REJECTION_REASONS = Object.freeze({
	excessiveLifetime: 'excessiveLifetime',
	expiredAssertion: 'expiredAssertion',
	invalidSignature: 'invalidSignature',
	missingAssertion: 'missingAssertion',
	noLiveKey: 'noLiveKey',
	notYetValid: 'notYetValid',
	otherAudience: 'otherAudience',
	reusedAssertion: 'reusedAssertion',
	unknownApplication: 'unknownApplication',
	unreadableAssertion: 'unreadableAssertion',
	unrepresentableJti: 'unrepresentableJti',
} as const);

/**
 * The reasons a `channelAssertion.rejection` records (ruled): an assertion that verifies under its
 * application's key and is refused anyway, so it names that application. Each instance records the
 * first refusal of each assertion, and counts every later refusal of it in
 * `channelAssertion.rejectionTally` under its own reason.
 */
export const CHANNEL_ASSERTION_VERIFIED_REJECTION_REASONS: readonly string[] = Object.freeze([
	CHANNEL_ASSERTION_REJECTION_REASONS.expiredAssertion,
	CHANNEL_ASSERTION_REJECTION_REASONS.notYetValid,
	CHANNEL_ASSERTION_REJECTION_REASONS.otherAudience,
	CHANNEL_ASSERTION_REJECTION_REASONS.excessiveLifetime,
	CHANNEL_ASSERTION_REJECTION_REASONS.reusedAssertion,
	CHANNEL_ASSERTION_REJECTION_REASONS.unrepresentableJti,
]);

/**
 * The reasons a `channelAssertion.rejectionTally` always counts by (ruled): an assertion that cannot
 * be verified, which costs nothing to send, counted per reason and per registered application named
 * and recorded once each interval. The tally also counts the reasons
 * of {@link CHANNEL_ASSERTION_VERIFIED_REJECTION_REASONS} for every refusal not recorded one by one.
 */
export const CHANNEL_ASSERTION_TALLY_REASONS: readonly string[] = Object.freeze([
	CHANNEL_ASSERTION_REJECTION_REASONS.missingAssertion,
	CHANNEL_ASSERTION_REJECTION_REASONS.unreadableAssertion,
	CHANNEL_ASSERTION_REJECTION_REASONS.unknownApplication,
	CHANNEL_ASSERTION_REJECTION_REASONS.noLiveKey,
	CHANNEL_ASSERTION_REJECTION_REASONS.invalidSignature,
]);

/** One event as a log line carries it: the CloudEvents envelope and its `data`. */
export interface CloudEvent {
	/** Any other member the line carries, such as `severity`. */
	[member: string]: unknown;

	data: unknown;
	id: string;
	source: string;
	specversion: string;
	time: string;
	type: string;
}

// A JSON grammar's scan, refusing an object whose members repeat a name, since JSON.parse keeps the
// last silently and a second `time` or `level` added by a logging library would shadow the first.
const WHITESPACE = /[\t\n\r ]*/uy;
const SCALAR = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/uy;
const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/uy;

const matchedAt = (pattern: RegExp, text: string, at: number): string | undefined => {
	pattern.lastIndex = at;
	return pattern.exec(text)?.[0];
};

const skipped = (text: string, at: number): number => at + (matchedAt(WHITESPACE, text, at) ?? '').length;

const malformed = (at: number): never => {
	throw new Error(`the line is not well-formed JSON at character ${at}`);
};

const scannedMembers = (text: string, at: number, seen: ReadonlySet<string>): number => {
	const keyAt = skipped(text, at);
	const key = matchedAt(STRING, text, keyAt) ?? malformed(keyAt);
	const name = String(JSON.parse(key));
	if (seen.has(name)) {
		throw new Error(`the line repeats the member ${JSON.stringify(name)}`);
	}
	const colon = skipped(text, keyAt + key.length);
	if (text[colon] !== ':') {
		return malformed(colon);
	}
	const after = skipped(text, scannedValue(text, colon + 1));
	if (text[after] === ',') {
		return scannedMembers(text, after + 1, new Set([...seen, name]));
	}
	return text[after] === '}' ? after + 1 : malformed(after);
};

const scannedElements = (text: string, at: number): number => {
	const after = skipped(text, scannedValue(text, at));
	if (text[after] === ',') {
		return scannedElements(text, after + 1);
	}
	return text[after] === ']' ? after + 1 : malformed(after);
};

const scannedValue = (text: string, at: number): number => {
	const start = skipped(text, at);
	const opening = text[start];
	if (opening === '{') {
		const inside = skipped(text, start + 1);
		return text[inside] === '}' ? inside + 1 : scannedMembers(text, inside, new Set());
	}
	if (opening === '[') {
		const inside = skipped(text, start + 1);
		return text[inside] === ']' ? inside + 1 : scannedElements(text, inside);
	}
	const token = matchedAt(STRING, text, start) ?? matchedAt(SCALAR, text, start) ?? malformed(start);
	return start + token.length;
};

/**
 * One log line read as one JSON object holding each member once, at every depth.
 *
 * @param line the line.
 * @throws when the line is not one JSON object, or an object in it repeats a member's name.
 */
export const jsonObjectOf = (line: string): Readonly<Record<string, unknown>> => {
	const start = skipped(line, 0);
	if (line[start] !== '{') {
		throw new Error('the line is not one JSON object');
	}
	const end = skipped(line, scannedValue(line, start));
	if (end !== line.length) {
		return malformed(end);
	}
	const value: unknown = JSON.parse(line);
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		return value as Readonly<Record<string, unknown>>;
	}
	throw new Error('the line is not one JSON object');
};

const isCloudEvent = (value: Readonly<Record<string, unknown>>): value is CloudEvent =>
	['id', 'source', 'specversion', 'time', 'type'].every((member) => typeof value[member] === 'string') &&
	Object.hasOwn(value, 'data');

/**
 * The events among a log stream's lines, such as `captureLog`'s: every line must be one JSON object
 * holding each member once, and the events are those carrying the CloudEvents envelope.
 *
 * @param lines the lines, empty ones left out.
 * @throws naming the line, when one is not one JSON object holding each member once.
 */
export const cloudEventsIn = (lines: readonly string[]): readonly CloudEvent[] =>
	lines.flatMap((line, index) => {
		try {
			const value = jsonObjectOf(line);
			return isCloudEvent(value) ? [value] : [];
		} catch (error) {
			throw new Error(`log line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

/**
 * The reasons an event whose `result` is `failed` records (ruled): the dependency that failed, a fixed
 * code each, never the dependency's own error.
 */
export const FAULT_REASONS = Object.freeze({
	cacheUnavailable: 'cacheUnavailable',
	directoryNotConfigured: 'directoryNotConfigured',
	directoryUnavailable: 'directoryUnavailable',
	identityProviderUnavailable: 'identityProviderUnavailable',
	storeUnavailable: 'storeUnavailable',
} as const);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * An event's `data`, as a log line or an answer of the audit log carries it, failing the test unless
 * it is a JSON object.
 *
 * @param event the event.
 */
export const dataOf = (event: { readonly data?: unknown }): Readonly<Record<string, unknown>> =>
	isRecord(event.data) ? event.data : assert.fail("an event's data is not an object");

/**
 * The events among the lines a log stream holds, from a mark on.
 *
 * @param log the captured log stream.
 * @param since how many lines to pass over: none by default.
 */
export const eventsIn = (log: LogCapture, since: number = 0): readonly CloudEvent[] =>
	cloudEventsIn(log.lines().slice(since));

/**
 * The events of one type, as the table names it.
 *
 * @param events the events.
 * @param type the event type, without the prefix.
 */
export const ofType = (events: readonly CloudEvent[], type: RecordedEventType): readonly CloudEvent[] =>
	events.filter((event) => event.type === emittedType(type));

/**
 * The `data` of every event of one type the log stream holds from a mark on, in order, failing the
 * test unless each is a JSON object.
 *
 * @param log the captured log stream.
 * @param type the event type, without the prefix.
 * @param since how many lines to pass over: none by default.
 */
export const eventDataOf = (
	log: LogCapture,
	type: RecordedEventType,
	since: number = 0,
): readonly Readonly<Record<string, unknown>>[] => ofType(eventsIn(log, since), type).map(dataOf);

/** Where a wait reads from, and for how long. */
export interface AwaitOptions {
	/** Lines to pass over: none by default. */
	since?: number;

	/** The longest wait: 10 s by default. */
	timeoutMs?: number;
}

/**
 * Waits until the log stream's events satisfy a condition, failing the test if they never do, and
 * gives them.
 *
 * @param log the captured log stream.
 * @param condition what the events must satisfy.
 * @param options the mark and the timeout.
 */
export const awaitEvents = async (
	log: LogCapture,
	condition: (events: readonly CloudEvent[]) => boolean,
	{ since = 0, timeoutMs = 10_000 }: AwaitOptions = {},
): Promise<readonly CloudEvent[]> => {
	const held = await eventually(async () => condition(eventsIn(log, since)), timeoutMs);
	assert.ok(held, `the events awaited never reached the log stream within ${timeoutMs} ms`);
	return eventsIn(log, since);
};

/**
 * Waits until the log stream holds at least a number of events of one type, failing the test if it
 * never does, and gives those.
 *
 * @param log the captured log stream.
 * @param type the event type, without the prefix.
 * @param options how many, 1 by default, the mark and the timeout.
 */
export const awaitEventsOfType = async (
	log: LogCapture,
	type: RecordedEventType,
	{ count = 1, ...options }: AwaitOptions & { count?: number } = {},
): Promise<readonly CloudEvent[]> =>
	ofType(await awaitEvents(log, (events) => ofType(events, type).length >= count, options), type);

/**
 * Waits until the log stream holds at least a number of events of one type, failing the test if it
 * never does, and gives their `data`.
 *
 * @param log the captured log stream.
 * @param type the event type, without the prefix.
 * @param options how many, 1 by default, the mark and the timeout.
 */
export const awaitEventData = async (
	log: LogCapture,
	type: RecordedEventType,
	options: AwaitOptions & { count?: number } = {},
): Promise<readonly Readonly<Record<string, unknown>>[]> => (await awaitEventsOfType(log, type, options)).map(dataOf);

/**
 * The dry run's operational lines ({@link DRY_RUN_LOG_LINE}) among a log stream's lines, from a mark
 * on, each read as one JSON object; an event is never one.
 *
 * @param log the captured log stream.
 * @param since how many lines to pass over: none by default.
 */
export const dryRunLogLines = (log: LogCapture, since: number = 0): readonly Readonly<Record<string, unknown>>[] =>
	log
		.lines()
		.slice(since)
		.map(jsonObjectOf)
		.filter(
			(line) =>
				line[DRY_RUN_LOG_LINE.message.member] === DRY_RUN_LOG_LINE.message.value &&
				!Object.hasOwn(line, 'specversion'),
		);

/** One `audit_log` row as a test reads it. */
export interface AuditRow {
	data: unknown;
	dataschema: string | null;
	id: string;

	/**
	 * `occurred_at` in UTC, to the store's microsecond, written `YYYY-MM-DDTHH:MM:SS.ffffff000`: nine
	 * digits of the second, as an event's `time` is compared at.
	 */
	occurredAtKey: string;

	severity: unknown;
	source: string;
	specversion: string;
	type: string;
}

const column = (name: string): string => pg.escapeIdentifier(name);

/**
 * Every `audit_log` row, ordered by when it occurred and then by id.
 *
 * @param client a connection under the migration role.
 */
export const auditRows = async (client: pg.ClientBase): Promise<readonly AuditRow[]> => {
	const { columns } = POLICY_TABLES.auditLog;
	const { rows } = await client.query<AuditRow>(
		`SELECT ${column(columns.data)} AS data, ${column(columns.dataSchema)} AS dataschema, ${column(columns.id)}::text AS id, to_char(${column(columns.occurredAt)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '000' AS "occurredAtKey", ${column(columns.severity)} AS severity, ${column(columns.source)} AS source, ${column(columns.specVersion)} AS specversion, ${column(columns.type)} AS type FROM ${qualified(POLICY_TABLES.auditLog)} ORDER BY ${column(columns.occurredAt)}, ${column(columns.id)}`,
	);
	return rows;
};

/**
 * Every `audit_log` row as JSON text, every column included, for a search of what the trail holds,
 * such as for an address or a name it must never hold.
 *
 * @param client a connection under the migration role.
 */
export const auditRowTexts = async (client: pg.ClientBase): Promise<readonly string[]> => {
	const { rows } = await client.query<{ text: string }>(
		`SELECT to_jsonb(row_held)::text AS text FROM ${qualified(POLICY_TABLES.auditLog)} AS row_held`,
	);
	return rows.map(({ text }) => text);
};
