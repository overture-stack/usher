import type pg from 'pg';

import type { Directory } from '../directory/index.js';
import type { AuditTrail, JsonValue } from '../eventLog/index.js';
import type { GrantRate } from '../grantRate/index.js';
import type { Problem } from '../http/index.js';
import type { OperationOutcome, StoreReader } from '../managementApi/index.js';
import type { ResourceStanding, StandingLock } from '../resourceStanding/index.js';
import type { ControllerSettings } from '../settings/index.js';

/** A grant's holder as a request names one: a person by subject, or by address. */
export type NamedHolder = { email: string; kind: 'address' } | { kind: 'subject'; subject: string };

/** What reading a holder gave: the person named, or the refusal the value earned. */
export type HolderReading = { holder: NamedHolder; kind: 'read' } | { kind: 'refused'; problem: Problem };

/** An address lookup as read from its body: the address, in an address's form, as given. */
export interface AddressLookup {
	email: string;
}

/** A grant's creation as read from its body, every rule of its form kept. */
export interface GrantCreation {
	/** The scoped record category named, as sent; none when left out. */
	category: string | undefined;

	/** None for a grant that never expires. */
	expiresAt: Date | undefined;

	holder: NamedHolder;

	/** The externalId, as sent. */
	resource: string;

	/** The role's name, as sent. */
	role: string;
}

/** A self-grant's creation as read from its body, every rule of its form kept. */
export interface SelfGrantCreation {
	/** The scoped record category named, as sent; none when left out. */
	category: string | undefined;

	/** When the self-grant ends, in the future and within the longest self-grant life. */
	expiresAt: Date;

	/** The externalId, as sent. */
	resource: string;

	/** The role's name, as sent. */
	role: string;
}

/** A grant's change, as read from its JSON Merge Patch: each member left out is kept. */
export interface GrantChange {
	/** The new expiry, or `null` to remove it. */
	expiresAt?: Date | null;

	/** The new role's name, as sent. */
	role?: string;
}

/** What a grant's change is judged from, once the grant and its new role are read. */
export interface GrantChangeQuestion {
	/**
	 * The caller's authority on the grant's resource: a counted owner's, or a platform
	 * administrator's who is not one.
	 */
	authority: 'administrator' | 'owner';

	change: GrantChange;

	/** The grant as it stands. */
	current: Pick<StoredGrant, 'endedAt' | 'expiresAt' | 'revokedAt'> & {
		role: StoredRole;

		/**
		 * When a self-grant was asked for, the end it may reach being counted from it: its request's
		 * instant for one a request asked for, its grant's for one its holder granted themself; `null`
		 * for any other grant.
		 */
		selfGrantSince: Date | null;
	};

	/** Whether the caller is the person holding the grant. */
	holderIsCaller: boolean;

	/** The longest a self-grant lives, in seconds. */
	maximumSeconds: number;

	/**
	 * The role the change names, as the store defines it; none for one it does not define, or for a
	 * change naming none.
	 */
	newRole: StoredRole | undefined;

	/** The change's instant. */
	now: Date;
}

/**
 * The judgement of a grant's change: the end and the role the grant takes, with how its end moved
 * and whether its role widened, or the refusal it earned.
 */
export type GrantChangeJudgement =
	| {
			/** `later` for an end moved later or removed, `earlier` for one moved earlier. */
			endMoved: 'earlier' | 'kept' | 'later';

			expiresAt: Date | null;
			kind: 'change';
			role: StoredRole;

			/** `wider` for a role conferring anything the grant's did not, `narrower` for any other. */
			roleMoved: 'kept' | 'narrower' | 'wider';
	  }
	| { kind: 'refuse'; problem: Problem };

/** A decision on a grant request, as read from its body. */
export interface GrantRequestDecision {
	decision: 'granted' | 'refused';
}

/** The grant request listing's page, as read from its query. */
export interface GrantRequestListing {
	/** The id of the request the page begins after; none for the first page. */
	after: string | undefined;

	/** The most requests on the page. */
	limit: number;
}

/** A grant listing's page, as read from its query. */
export interface GrantListing {
	/** The id of the grant the page begins after; none for the first page. */
	after: string | undefined;

	/** Whether revoked grants are listed, which a platform administrator alone asks for. */
	includeRevoked: boolean;

	/** The most grants on the page. */
	limit: number;
}

/** A listing of a person's grants, as read from its body and its query. */
export interface PersonGrantListing extends AddressLookup, GrantListing {}

/**
 * The grants on a page of resources, as an administrator's resource listing shows them: each
 * resource's, by its id; or the answer of a directory that cannot answer for a holder.
 */
export type GrantsOnResources =
	| {
			/**
			 * The grants on one resource of the page, none for a resource holding none.
			 *
			 * @param resourceId the resource's id.
			 */
			grantsOf(resourceId: string): readonly JsonValue[];

			kind: 'listed';
	  }
	| { kind: 'unavailable'; outcome: OperationOutcome };

/** A holder's answer to a grant, as read from its body. */
export interface GrantAnswer {
	/** The capabilities shown to the holder, as sent. */
	capabilities: readonly string[];

	decision: 'accepted' | 'rejected';
}

/** A revocation as read from its body. */
export interface GrantRevocation {
	/** The reason given, or `unspecified` for none. */
	reason: string;
}

/** What a grant's authority is decided from. */
export interface GrantAuthorityQuestion {
	/** Whether the caller is a platform administrator. */
	administrator: boolean;

	/** Whether the holder named is the caller, named by the caller's own subject. */
	holderIsCaller: boolean;

	/**
	 * Whether the resource named has no counted owner, which decides only a platform administrator's
	 * grant of a role other than `submitter` and `owner`; `false` where it was not read.
	 */
	orphaned: boolean;

	/** The role's name. */
	role: string;

	/** Where the caller stands on the resource named, or none for a resource that does not exist. */
	standing: ResourceStanding | undefined;
}

/**
 * The decision of a grant's authority, by its kind: issue the grant, take it as a request of kind
 * `orphanedResource` someone else decides, or refuse it with its problem and, where it differs from
 * the code answered, the reason its event records.
 */
export type GrantAuthority =
	{ kind: 'issue' } | { kind: 'refuse'; problem: Problem; recordedReason?: string } | { kind: 'request' };

/** What a self-grant's authority is decided from. */
export interface SelfGrantAuthorityQuestion {
	/** Whether the caller is a platform administrator. */
	administrator: boolean;

	/** Where the caller stands on the resource named, or none for a resource that does not exist. */
	standing: ResourceStanding | undefined;
}

/**
 * The decision of a self-grant's authority, by its kind: issue the grant at once, take it as a
 * request someone else decides, or refuse it with its problem and, where it differs from the code
 * answered, the reason its event records.
 */
export type SelfGrantAuthority =
	{ kind: 'issue' } | { kind: 'refuse'; problem: Problem; recordedReason?: string } | { kind: 'request' };

/** A grant's latest answer by its holder, as an answer shows it. */
export interface StoredDecision {
	/** The capabilities shown, as `entity.action` names. */
	capabilities: readonly string[];

	decidedAt: Date;
	decision: 'accepted' | 'rejected';
}

/** A capability as the principal's own listing shows what a grant would let them use. */
export interface ListedCapability {
	/** `null` where the store holds none. */
	description: string | null;

	displayName: string;

	/** As `entity.action`. */
	name: string;
}

/** A grant as an answer shows it, each person by subject and its resource by externalId. */
export interface ViewedGrant {
	/** The scoped record category; `null` for a grant on the whole resource. */
	category: string | null;

	/** Its holder's latest answer, or `null` while they have given none. */
	decision: StoredDecision | null;

	/** When a grant on its terms replaced it once it had expired; never shown. */
	endedAt: Date | null;

	expiresAt: Date | null;
	grantedAt: Date;
	granterSubject: string;
	holderSubject: string;
	id: string;

	/** The externalId. */
	resource: string;

	revokedAt: Date | null;
	revokerSubject: string | null;
	role: string;

	/** Whether its holder granted it to themself, or asked for it in a request someone granted. */
	selfGrant: boolean;
}

/**
 * What a grant request asks for: `selfGrant`, a grant to the principal asking for it, and
 * `orphanedResource`, a platform administrator's grant to someone else on a resource with no
 * counted owner. A kind joins here as one more member, with its own branch wherever a request is
 * judged.
 */
export type GrantRequestKind = 'orphanedResource' | 'selfGrant';

/**
 * A grant request as an answer shows it, the principal who asked for it and its holder by subject,
 * and its resource by externalId.
 * by externalId.
 */
export interface ViewedGrantRequest {
	/** The scoped record category; `null` for one on the whole resource. */
	category: string | null;

	/** When it was decided; `null` while undecided. */
	decidedAt: Date | null;

	decision: 'granted' | 'refused' | null;

	/** When the grant would end, and when the request lapses while undecided. */
	expiresAt: Date;

	/** The grant written by granting it; `null` unless granted. */
	grantId: string | null;

	/** Who would hold the grant: the principal asking for a self-grant, the person named for any other. */
	holderSubject: string;

	id: string;
	kind: GrantRequestKind;
	requestedAt: Date;
	requestedBySubject: string;

	/** The externalId. */
	resource: string;

	role: string;
}

/** A grant request as the grant operations read it in a change's transaction. */
export interface StoredGrantRequest extends ViewedGrantRequest {
	/** What the principal asking was shown of the role's capabilities, as `entity.action` names. */
	capabilities: readonly string[];

	/** The holder's person, whose id never leaves the store's own statements. */
	holderUserId: string;

	/** The record category's id; `null` for one on the whole resource. */
	recordCategoryId: string | null;

	/** The principal who asked for it, whose id never leaves the store's own statements. */
	requestedBy: string;

	/** Its resource's id, which never leaves the store's own statements. */
	resourceId: string;

	/** Whether its resource is retired. */
	resourceRetired: boolean;

	/** The role's id, which never leaves the store's own statements. */
	roleId: string;
}

/** A grant request to write: what is asked for, by whom, and what they were shown. */
export interface NewGrantRequest extends GrantTerms {
	/** What the principal asking was shown of the role's capabilities, as `entity.action` names. */
	capabilities: readonly string[];

	/** When the grant would end, and when the request lapses while undecided. */
	expiresAt: Date;

	kind: GrantRequestKind;
	requestedAt: Date;

	/** The principal asking for it. */
	requestedBy: string;
}

/** A decision on a grant request to record. */
export interface NewRequestDecision {
	decidedAt: Date;

	/** The person deciding. */
	decidedBy: string;

	decision: 'granted' | 'refused';

	/** The grant written by granting the request; `null` for a refusal. */
	grantId: string | null;

	requestId: string;
}

/**
 * What tells a resource's owners of a self-grant or a grant request on it: one row of the owner
 * notification outbox for each recipient, naming the grant or the request its kind tells of.
 */
export interface NewNotifications {
	createdAt: Date;
	kind: 'grantRequest' | 'selfGrant';

	/** The people told. */
	recipients: readonly string[];

	/** The grant's id for `selfGrant`, the request's for `grantRequest`. */
	reference: string;
}

/** A grant as the grant operations read it in a change's transaction. */
export interface StoredGrant extends ViewedGrant {
	/** The holder's person, whose id never leaves the store's own statements. */
	holderUserId: string;

	/** Its resource's id, which never leaves the store's own statements. */
	resourceId: string;

	/** Whether its resource is retired. */
	resourceRetired: boolean;

	/**
	 * When a self-grant was asked for: its request's instant for one a request asked for, its own
	 * grant's instant for one its holder granted themself; `null` for any other grant.
	 */
	selfGrantSince: Date | null;
}

/** A role as the store defines it. */
export interface StoredRole {
	/** What it confers now, as `entity.action` names, sorted. */
	capabilities: readonly string[];

	/** Its id, which never leaves the store's own statements. */
	id: string;

	name: string;
	plane: 'control' | 'data';
}

/** What makes one grant: its holder's person, its resource, its record category and its role. */
export interface GrantTerms {
	holderUserId: string;

	/** The record category's id; `null` for the whole resource. */
	recordCategoryId: string | null;

	resourceId: string;
	roleId: string;
}

/** A grant to write. */
export interface NewGrant extends GrantTerms {
	/** None for a grant that never expires. */
	expiresAt: Date | null;

	grantedAt: Date;

	/** The granter's person: for a grant asked for in a request, the person who granted it. */
	grantedBy: string;

	/** The principal who asked for the grant in a request; `null` for any other grant. */
	requestedBy: string | null;
}

/** An answer to write. */
export interface NewDecision {
	/** What the holder was shown, as `entity.action` names. */
	capabilities: readonly string[];

	decision: 'accepted' | 'rejected';
	grantId: string;

	/**
	 * The configured clock's instant: the answer's own, unless an earlier answer is not before it.
	 */
	now: Date;

	/** The person answering. */
	userId: string;
}

/**
 * The grant operations' statements, each on one transaction's connection, every value bound. The
 * trusted issuer, under which every person is found, is the store's own.
 */
export interface GrantStore {
	/**
	 * Appends an answer to a grant, timed at the instant given, or a millisecond after the person's
	 * latest answer to it where that is not before it, so their answers stand in order with no tie.
	 *
	 * @returns the instant written.
	 */
	appendDecision(decision: NewDecision): Promise<Date>;

	/** Changes a grant's expiry and its role, as given. */
	changeGrant(change: { expiresAt: Date | null; grantId: string; roleId: string }): Promise<void>;

	/** How many counted owners of a resource there are besides the holder of one grant. */
	countedOwnersBesides(question: { grantId: string; now: Date; resourceId: string }): Promise<number>;

	/** The people who are counted owners of a resource at the instant given. */
	countedOwnersOf(question: { now: Date; resourceId: string }): Promise<readonly string[]>;

	/**
	 * Ends the grant on the terms given that is neither revoked nor ended and has expired at the
	 * instant given, setting its end to that instant; it matches nothing once another change has
	 * ended it.
	 *
	 * @returns whether a grant was ended.
	 */
	endExpiredGrant(terms: GrantTerms, now: Date): Promise<boolean>;

	/**
	 * The id of the category a scoped name names that a resource offers: any global category, and the
	 * resource's own categories; `undefined` for any other name.
	 */
	findOfferedCategory(scopedName: string, resourceId: string): Promise<string | undefined>;

	/**
	 * The person holding a subject's identity under the trusted issuer, recorded on first meeting
	 * them.
	 */
	findOrRecordPerson(subject: string, now: Date): Promise<string>;

	/** The person holding a subject's identity under the trusted issuer, or `undefined` for none. */
	findPerson(subject: string): Promise<string | undefined>;

	/** The role a name names exactly, or `undefined` for none. */
	findRole(name: string): Promise<StoredRole | undefined>;

	/** Whether the holder holds a grant on the terms given that is live at the instant given. */
	holdsLiveGrant(terms: GrantTerms, now: Date): Promise<boolean>;

	/**
	 * Whether the person given asked for a grant on the terms given, by a request of the kind given
	 * that is undecided and has not lapsed at the instant given.
	 */
	holdsPendingRequest(
		question: GrantTerms & {
			kind: GrantRequestKind;
			now: Date;
			requestedBy: string;
		},
	): Promise<boolean>;

	/**
	 * Writes a grant, unless its holder holds one on the same terms neither revoked nor ended: a
	 * creation racing another for the same terms waits until that one ends, and writes nothing once
	 * it commits.
	 *
	 * @returns its id, or `undefined` when such a grant is held already.
	 */
	insertGrant(grant: NewGrant): Promise<string | undefined>;

	/**
	 * Writes a grant request, undecided.
	 *
	 * @returns its id.
	 */
	insertGrantRequest(request: NewGrantRequest): Promise<string>;

	/**
	 * The ids of a person's grants of one role on one resource that are live at the instant given, in
	 * any category, in the order granted, each row locked for update until the transaction ends.
	 */
	liveGrantIdsOf(question: {
		holderUserId: string;
		now: Date;
		resourceId: string;
		roleId: string;
	}): Promise<readonly string[]>;

	/**
	 * Where a grant held by a person stands: its resource's id and externalId, read without a lock.
	 *
	 * @param grantId an id in the form the store gives one.
	 * @returns them, or `undefined` when no grant held by a person has the id.
	 */
	locateGrant(grantId: string): Promise<{ externalId: string; resourceId: string } | undefined>;

	/**
	 * Where a grant request stands: its resource's id, read without a lock.
	 *
	 * @param requestId an id in the form the store gives one.
	 * @returns it, or `undefined` when no request has the id.
	 */
	locateGrantRequest(requestId: string): Promise<{ resourceId: string } | undefined>;

	/**
	 * Locks a resource's row against every other lock taken for an update, until the transaction
	 * ends.
	 */
	lockResource(resourceId: string): Promise<void>;

	/**
	 * Reads one grant held by a person, its row locked for update until the transaction ends.
	 *
	 * @param grantId an id in the form the store gives one.
	 * @returns the grant, or `undefined` when no grant held by a person has the id.
	 */
	readGrant(grantId: string): Promise<StoredGrant | undefined>;

	/**
	 * Reads one grant request, its row locked for update until the transaction ends.
	 *
	 * @param requestId an id in the form the store gives one.
	 * @returns the request, or `undefined` when no request has the id.
	 */
	readGrantRequest(requestId: string): Promise<StoredGrantRequest | undefined>;

	/** Where a principal stands on the resource holding an externalId, its row locked as asked. */
	readStanding(question: {
		externalId: string;
		lock: StandingLock;
		now: Date;
		subject: string;
	}): Promise<ResourceStanding | undefined>;

	/** Records the decision on an undecided grant request. */
	recordDecision(decision: NewRequestDecision): Promise<void>;

	/** Records a grant's revocation, at the instant given and by the person given. */
	revokeGrant(revocation: { grantId: string; now: Date; revokedBy: string }): Promise<void>;

	/** Writes one owner notification for each recipient, none for none. */
	writeNotifications(notifications: NewNotifications): Promise<void>;
}

/** A creation's terms once every rule of it but its holder's address is judged. */
export interface JudgedCreation {
	/**
	 * How the grant is written: `issue` at once, or `request`, asked for as a request of kind
	 * `orphanedResource` ending at the expiry given.
	 */
	authority: { expiresAt: Date; kind: 'request' } | { kind: 'issue' };

	/** Its record category, by id and as a payload names it; `null` for the whole resource. */
	category: { id: string; scopedName: string } | null;

	kind: 'judged';

	/** Where the caller stands on its resource, which exists and is not retired. */
	resource: ResourceStanding;

	role: StoredRole;
}

/** What the grant operations are created from. */
export interface GrantOperationsSettings {
	/**
	 * Where an address naming a holder is resolved to the subject of the account holding it, and
	 * where a listing reads each person it names.
	 */
	directory: Pick<Directory, 'accountOf' | 'resolveAddress'>;

	/**
	 * Where each grant write is counted, by its caller: in the transaction committing its change, as
	 * that transaction's last step to take a lock, or with the event recording its refusal or
	 * failure.
	 */
	grantRate: GrantRate;

	/**
	 * The grant store over one transaction's connection.
	 *
	 * @param connection the transaction's connection.
	 */
	grantStoreOf(connection: pg.PoolClient): GrantStore;

	/**
	 * Whether a grant is accepted at its creation, the clock each time written is read from, the
	 * schema, the trusted issuer, the longest a self-grant or a grant asked for on a resource with no
	 * counted owner lives, and the instance's submitter category.
	 */
	settings: Pick<
		ControllerSettings,
		| 'clock'
		| 'databaseSchema'
		| 'grantAutoAccept'
		| 'identityProviderIssuer'
		| 'selfGrantMaximumLifetimeSeconds'
		| 'submitterCategory'
	>;

	/**
	 * Where the listings read their pages, and a refused request's event reads what it names, each
	 * outside any transaction, on the control pool.
	 */
	store: StoreReader;

	/** Where each change runs, on the control pool, recording its events. */
	trail: Pick<AuditTrail<pg.PoolClient>, 'inTransaction'>;
}
