import type pg from 'pg';

import type { ControllerConfiguration } from '../configuration/index.js';
import type { Directory } from '../directory/index.js';
import type { AuditTrail } from '../eventLog/index.js';
import type { Problem } from '../http/index.js';
import type { StoreReader } from '../managementApi/index.js';

/** A nomination's request as read from its body: the nominee, by the subject sent. */
export interface NominationRequest {
	nomineeSubject: string;
}

/** What reading a nomination's body gave: the request, or the refusal its shape earned. */
export type NominationReading = { input: NominationRequest; kind: 'read' } | { kind: 'refused'; problem: Problem };

/** A nominee's answer to a nomination, as stored: `accepted` or `declined`, the words sent being `accept` and `decline`. */
export interface NominationAnswer {
	decision: 'accepted' | 'declined';
}

/**
 * A nomination's state, derived from the answers recorded for it, in this order: `accepted` when an
 * administrator names it, `declined`, `revoked`, `replaced` when a later nomination exists, and
 * otherwise `pending`.
 */
export type NominationState = 'accepted' | 'declined' | 'pending' | 'replaced' | 'revoked';

/**
 * A nomination as the API shows it: its nominator and nominee by subject, its state, and the instant
 * of its answer or its revocation where it holds one.
 */
export interface NominationRecord {
	/** When its nominee answered it, `null` while no answer is recorded. */
	decidedAt: Date | null;

	id: string;

	nominatedAt: Date;

	/** The nominator's subject under the trusted issuer, or their first identity's under another. */
	nominatorSubject: string;

	/** The nominee's subject under the trusted issuer, or their first identity's under another. */
	nomineeSubject: string;

	/** When the first user revoked it, `null` while it is not revoked. */
	revokedAt: Date | null;

	state: NominationState;
}

/** A nomination as an answer or a revocation reads it: its record, and the nominee's `users.id`. */
export interface StoredNomination extends NominationRecord {
	/** The nominee's `users.id`, which never leaves the store. */
	nomineeUserId: string;
}

/** A live administrator, as the administrators listing shows one. */
export interface ListedAdministrator {
	/** When the administrator accepted the nomination that made them one. */
	acceptedAt: Date;

	/** The nomination the administrator accepted. */
	nominationId: string;

	/**
	 * Whether the administrator's person holds a standing principal revocation, so they act as no
	 * administrator until it is lifted, though they are listed so another administrator can lift or
	 * remove them.
	 */
	revoked: boolean;

	/** The administrator's subject under the trusted issuer. */
	subject: string;
}

/** A live administrator, as the store reads one by subject: the nomination accepted and the person's `users.id`. */
export interface AdministratorRecord {
	nominationId: string;

	userId: string;
}

/** A pending nomination, as the store lists the ones a person made: its id and its nominee's subject. */
export interface PendingNomination {
	id: string;

	/** The nominee's subject under the trusted issuer, or their first identity's under another. */
	nomineeSubject: string;
}

/** A nomination naming the caller, as their listing shows it. */
export interface ListedNomination {
	id: string;

	nominatedAt: Date;

	/** The nominator's subject under the trusted issuer, or their first identity's under another. */
	nominatorSubject: string;

	state: NominationState;
}

/**
 * Where nominating, answering and revoking read and write, over one transaction's connection. A person
 * is found by the identity of a subject under the trusted issuer.
 */
export interface AdministratorStore {
	/** Whether any live administrator exists: one who has accepted and has not been removed. */
	administratorExists(): Promise<boolean>;

	/**
	 * Appends a nomination, its instant the one given or, where a nomination already holds that one
	 * or a later one, a millisecond after the latest, so the latest is always the last appended.
	 *
	 * @returns its id and the instant it holds.
	 */
	appendNomination(nomination: {
		nominatedBy: string;
		nomineeUserId: string;
		now: Date;
	}): Promise<{ id: string; nominatedAt: Date }>;

	/** The number of live administrators. */
	countAdministrators(): Promise<number>;

	/**
	 * Records a nominee's decline of a nomination, at the instant given.
	 *
	 * @param decline the nomination declined, and when.
	 */
	declineNomination(decline: { nominationId: string; now: Date }): Promise<void>;

	/** Records a person holding the subject's identity on first meeting them, else finds them. */
	findOrRecordPerson(subject: string, now: Date): Promise<string>;

	/** Finds the person holding the subject's identity, or none for a subject never met. */
	findPerson(subject: string): Promise<string | undefined>;

	/** Writes an administrator: the nominee of the nomination accepted. */
	insertAdministrator(administrator: { acceptedAt: Date; nominationId: string; userId: string }): Promise<void>;

	/** Whether the subject names a live administrator under the trusted issuer. */
	isAdministrator(subject: string): Promise<boolean>;

	/**
	 * Waits until no other change to an administrator or a nomination is in progress on any instance,
	 * and holds every later one off until this transaction ends. Every change to administrators or
	 * nominations takes it, exclusively.
	 */
	lockAdministrators(): Promise<void>;

	/**
	 * Finds the id of a pending nomination naming a nominee, by the nominee's `users.id`, or none when
	 * no pending nomination names them.
	 */
	pendingNominationOf(nomineeUserId: string): Promise<string | undefined>;

	/**
	 * Lists the pending nominations a person made, by their `users.id`, each with its nominee's subject.
	 */
	pendingNominationsBy(userId: string): Promise<readonly PendingNomination[]>;

	/**
	 * Finds the live administrator under the trusted issuer holding the subject, or none for a subject
	 * no live administrator holds.
	 */
	readAdministrator(subject: string): Promise<AdministratorRecord | undefined>;

	/**
	 * Reads a nomination by its id, or none for an id naming no nomination.
	 */
	readNomination(id: string): Promise<StoredNomination | undefined>;

	/**
	 * Records the removal of a live administrator, at the instant given, by the person removing them.
	 * The administrator's row is kept.
	 *
	 * @param removal the administrator's nomination, the `users.id` of the person removing them, and when.
	 */
	removeAdministrator(removal: { nominationId: string; removedBy: string; now: Date }): Promise<void>;

	/**
	 * Records the first user's revocation of a nomination, at the instant given.
	 *
	 * @param revocation the nomination revoked, and when.
	 */
	revokeNomination(revocation: { nominationId: string; now: Date }): Promise<void>;
}

/** What the administrator operations are created from. */
export interface AdministratorOperationsSettings {
	/** The administrator store over a transaction's connection. */
	administratorStoreOf(connection: pg.ClientBase): AdministratorStore;

	/** Where a nominee who has not signed in to Usher is read from the identity provider's directory. */
	directory: Pick<Directory, 'accountOf'>;

	/**
	 * The clock each instant written is read from, the schema, and the trusted issuer people are
	 * found under.
	 */
	settings: Pick<ControllerConfiguration, 'clock' | 'databaseSchema' | 'identityProviderIssuer'>;

	/** Where a listing and a refused request's nomination are read. */
	store: StoreReader;

	/** Where each change runs, recording its events. */
	trail: Pick<AuditTrail<pg.PoolClient>, 'inTransaction'>;
}
