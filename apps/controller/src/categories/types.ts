import type pg from 'pg';

import type { ControllerConfiguration } from '../configuration/index.js';
import type { AuditTrail } from '../eventLog/index.js';
import type { StoreReader } from '../managementApi/index.js';

/** A global category as the store holds it: its `categories.id`, its bare name and its description. */
export type StoredCategory = {
	description: string | null;

	id: string;

	/** The name without its scope, `controlled` for `global.controlled`. */
	name: string;
};

/** A global category as the API shows it: its scoped name, `global.controlled`, and its description. */
export type CategoryView = {
	description: string | null;

	/** The name with its scope, `global.` and the name, the form every token, mapping and event carries. */
	name: string;
};

/** A category registration as read from its body: the bare name, and the description if one was sent. */
export type CategoryRegistration = {
	description: string | null;

	name: string;
};

/** What writing a registration did: the row written, or the spelling of the global category already holding the name. */
export type Insertion = { id: string; kind: 'inserted' } | { existing: string; kind: 'taken' };

/**
 * A category update as read from its merge patch: the description to set, `null` to clear it, or none when the
 * patch does not name one, which changes nothing.
 */
export type CategoryUpdate = {
	description?: string | null;
};

/** The reads and writes of the global categories, run over one transaction's connection where a change makes them. */
export interface CategoryStore {
	/**
	 * Reads a global category by its bare name in any letter case, answering the spelling it was registered under,
	 * its row locked until the transaction ends.
	 */
	findGlobal(name: string): Promise<StoredCategory | undefined>;

	/**
	 * Writes a global category, unless one holds the same name in any letter case: then nothing is written, and the
	 * answer names the spelling registered. The store decides this itself, so a concurrent registration of the
	 * same name, in any letter case, cannot write a second row.
	 */
	insertGlobal(registration: CategoryRegistration): Promise<Insertion>;

	/** Sets the description of a category by its `categories.id`, `null` to clear it. */
	setDescription(id: string, description: string | null): Promise<void>;
}

/** What the category operations are built on: the store over a transaction, the store reader, the configuration and the trail. */
export interface CategoryOperationsSettings {
	/** The category store over a transaction's connection, which a change writes through. */
	categoryStoreOf(connection: pg.ClientBase): CategoryStore;

	/** The configuration the operations read: the clock, the schema and the trusted issuer. */
	settings: Pick<ControllerConfiguration, 'clock' | 'databaseSchema' | 'identityProviderIssuer'>;

	/** The store, read outside any transaction, one statement at a time. */
	store: StoreReader;

	/** The trail each change is made in, with its event. */
	trail: Pick<AuditTrail<pg.PoolClient>, 'inTransaction'>;
}
