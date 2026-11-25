import type pg from 'pg';

import type { ControllerConfiguration } from '../configuration/index.js';
import type { AdministratorStore } from '../administrators/index.js';
import type { AuditTrail } from '../eventLog/index.js';
import type { StoreReader } from '../managementApi/index.js';

/** A principal's revocation as the store holds it: its instant and reason, its lift's instant once lifted. */
export interface PrincipalRevocationRecord {
	reason: string;
	revokedAt: Date;
}

/** A principal revocation written: the row's person, reason and instant, and who wrote it. */
export interface NewPrincipalRevocation {
	reason: string;
	revokedAt: Date;
	revokedBy: string;

	/** The `users.id` of the person revoked. */
	userId: string;
}

/** A sign-out of everyone written: its reason, its instant and who recorded it. */
export interface NewSignOutEveryone {
	reason: string;
	signedOutAt: Date;
	signedOutBy: string;
}

/** The reads and writes of revocations, run over one transaction's connection where a change makes them. */
export interface RevocationStore {
	/** Writes a principal revocation, unless the person already holds a standing one: then nothing is written, and `false` is answered. */
	recordPrincipal(revocation: NewPrincipalRevocation): Promise<boolean>;

	/** Writes a sign-out of everyone. */
	recordSignOutEveryone(signOut: NewSignOutEveryone): Promise<void>;

	/**
	 * Lifts the standing revocation of a person, keeping its row, and answers the revocation lifted; `undefined`
	 * when the person holds none standing, and nothing is written.
	 */
	liftPrincipal(
		userId: string,
		lift: { liftedAt: Date; liftedBy: string },
	): Promise<PrincipalRevocationRecord | undefined>;

	/** Reads the standing revocation of a person, or `undefined` when none stands. */
	standingOf(userId: string): Promise<PrincipalRevocationRecord | undefined>;
}

/** What the revocation operations are built on: the administrator and revocation stores over a transaction, the store reader, the configuration and the trail. */
export interface RevocationOperationsSettings {
	/** The administrator store over a transaction's connection, which the live-administrator checks read through. */
	administratorStoreOf(
		connection: pg.ClientBase,
	): Pick<AdministratorStore, 'countAdministrators' | 'findOrRecordPerson' | 'findPerson' | 'isAdministrator'>;

	/** The revocation store over a transaction's connection, which a change writes through. */
	revocationStoreOf(connection: pg.ClientBase): RevocationStore;

	/** The configuration the operations read: the clock, the schema and the trusted issuer. */
	settings: Pick<ControllerConfiguration, 'clock' | 'databaseSchema' | 'identityProviderIssuer'>;

	/** The store, read outside any transaction. */
	store: StoreReader;

	/** The trail each change is made in, with its event. */
	trail: Pick<AuditTrail<pg.PoolClient>, 'inTransaction'>;
}
