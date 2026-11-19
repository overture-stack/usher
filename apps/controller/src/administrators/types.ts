import type pg from 'pg';

import type { ControllerConfiguration } from '../configuration/index.js';
import type { AuditTrail } from '../eventLog/index.js';
import type { Problem } from '../http/index.js';
import type { StoreReader } from '../managementApi/index.js';

/** A nomination's request as read from its body: the nominee, by the subject sent. */
export interface NominationRequest {
	nomineeSubject: string;
}

/** What reading a nomination's body gave: the request, or the refusal its shape earned. */
export type NominationReading = { input: NominationRequest; kind: 'read' } | { kind: 'refused'; problem: Problem };

/** A nomination as an acceptance reads it. */
export interface StoredNomination {
	id: string;

	/** Whether no later nomination has replaced it. */
	latest: boolean;

	/** The nominator's subject under the trusted issuer, or their first identity's under another. */
	nominatorSubject: string;

	/** The nominee's `users.id`, which never leaves the store. */
	nomineeId: string;
}

/** A nomination naming the caller, as their listing shows it. */
export interface ListedNomination {
	id: string;

	/** Whether no later nomination has replaced it. */
	latest: boolean;

	nominatedAt: Date;

	/** The nominator's subject under the trusted issuer, or their first identity's under another. */
	nominatorSubject: string;
}

/**
 * Where nominating and accepting read and write, over one transaction's connection. A person is
 * found by the identity of a subject under the trusted issuer.
 */
export interface AdministratorStore {
	/** Whether any administrator has accepted. */
	administratorExists(): Promise<boolean>;

	/**
	 * Appends a nomination, its instant the one given or, where a nomination already holds that one
	 * or a later one, a millisecond after the latest, so the latest is always the last appended.
	 *
	 * @returns its id and the instant it holds.
	 */
	appendNomination(nomination: {
		nominatedBy: string;
		nomineeId: string;
		now: Date;
	}): Promise<{ id: string; nominatedAt: Date }>;

	/** Records a person holding the subject's identity on first meeting them, else finds them. */
	findOrRecordPerson(subject: string, now: Date): Promise<string>;

	/** Finds the person holding the subject's identity, or none for a subject never met. */
	findPerson(subject: string): Promise<string | undefined>;

	/** Writes an administrator: the nominee of the nomination accepted. */
	insertAdministrator(administrator: { acceptedAt: Date; nominationId: string; userId: string }): Promise<void>;

	/**
	 * Waits until no other nomination or acceptance is in progress on any instance, and holds every
	 * later one off until this transaction ends.
	 */
	lockNominations(): Promise<void>;

	/** Reads a nomination by its id, or none for an id naming no nomination. */
	readNomination(id: string): Promise<StoredNomination | undefined>;
}

/** What the administrator operations are created from. */
export interface AdministratorOperationsSettings {
	/** The administrator store over a transaction's connection. */
	administratorStoreOf(connection: pg.ClientBase): AdministratorStore;

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
