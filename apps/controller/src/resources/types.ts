import type pg from 'pg';

import type { Directory } from '../directory/index.js';
import type { AuditTrail } from '../eventLog/index.js';
import type { NamedHolder } from '../grants/index.js';
import type { StoreReader } from '../managementApi/index.js';
import type { AccessLevel } from '../resourceStanding/index.js';
import type { ControllerSettings } from '../settings/index.js';

export type { AccessLevel };

/**
 * Who a resource is answered to: a platform administrator, a counted owner of it, or any other
 * principal who may see it.
 */
export type Reader = 'administrator' | 'owner' | 'signedIn';

/**
 * The rule of an externalId's form a value breaks: its normalization form, its length, its
 * characters, or a filter marker held.
 */
export type ExternalIdRule = 'characters' | 'filterMarker' | 'length' | 'normalization';

/** A registration as read from its body, every rule of its form kept, each text as it is stored. */
export interface Registration {
	accessLevel: AccessLevel;

	/** The ids sent, as sent: whether each names a registered application is the store's to say. */
	applications: readonly string[];

	/** Exactly as given; `null` when none was sent. */
	description: string | null;

	/** Exactly as given. */
	displayName: string;

	externalId: string;

	/** Its first owners, in the order named, each one person by subject or by address, as given. */
	owners: readonly NamedHolder[];
}

/** What the listing reads from its query. */
export interface ListingQuery {
	/** The externalId the page starts after, for a page after the first. */
	after: string | undefined;

	includeRetired: boolean;

	/** The most entries on the page. */
	limit: number;
}

/** A resource as the store holds it, as an answer shows it to a platform administrator. */
export interface StoredResource {
	accessLevel: AccessLevel;

	/** The ids of the applications serving it, sorted. */
	applications: readonly string[];

	/** Its own categories, scoped as `resource.<name>`, sorted. */
	categories: readonly string[];

	description: string | null;
	displayName: string;
	externalId: string;

	/** Its values, by resource field name. */
	fields: Readonly<Record<string, string>>;

	registeredAt: Date;

	/** The subject of the identity that registered it. */
	registeredBy: string | null;

	retired: boolean;
	suppressed: boolean;
	updatedAt: Date;
}

/** What the resource operations are created from. */
export interface ResourceOperationsSettings {
	/** Where an address naming a registration's owner is resolved to the subject of its account. */
	directory: Pick<Directory, 'resolveAddress'>;

	/**
	 * Whether an owner grant written at registration is accepted with it, the clock each time written
	 * is read from, the schema, and the trusted issuer people are found under.
	 */
	settings: Pick<ControllerSettings, 'clock' | 'databaseSchema' | 'grantAutoAccept' | 'identityProviderIssuer'>;

	/** Where a resource is read, on the control pool. */
	store: StoreReader;

	/** Where each change runs, on the control pool, recording its events. */
	trail: Pick<AuditTrail<pg.PoolClient>, 'inTransaction'>;
}
