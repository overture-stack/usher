import type pg from 'pg';

import type { AuditTrail } from '../eventLog/index.js';
import type { Problem } from '../http/index.js';
import type { StoreReader } from '../managementApi/index.js';
import type {
  ResourceStanding,
  StandingLock,
} from '../resourceStanding/index.js';
import type { ControllerSettings } from '../settings/index.js';

/** A grant's holder as a request names one: a person by subject, or by address. */
export type NamedHolder =
  { email: string; kind: 'address' } | { kind: 'subject'; subject: string };

/** What reading a holder gave: the person named, or the refusal the value earned. */
export type HolderReading =
  { holder: NamedHolder; kind: 'read' } | { kind: 'refused'; problem: Problem };

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

  /** The role's name. */
  role: string;

  /** Where the caller stands on the resource named, or none for a resource that does not exist. */
  standing: ResourceStanding | undefined;
}

/**
 * The decision of a grant's authority, by its kind: issue the grant, or refuse it with its problem
 * and, where it differs from the code answered, the reason its event records.
 */
export type GrantAuthority =
  | { kind: 'issue' }
  | { kind: 'refuse'; problem: Problem; recordedReason?: string };

/** A grant's latest answer by its holder, as an answer shows it. */
export interface StoredDecision {
  /** The capabilities shown, as `entity.action` names. */
  capabilities: readonly string[];

  decidedAt: Date;
  decision: 'accepted' | 'rejected';
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

  /** Whether its holder granted it to themself. */
  selfGrant: boolean;
}

/** A grant as the grant operations read it in a change's transaction. */
export interface StoredGrant extends ViewedGrant {
  /** The holder's person, whose id never leaves the store's own statements. */
  holderUserId: string;

  /** Its resource's id, which never leaves the store's own statements. */
  resourceId: string;

  /** Whether its resource is retired. */
  resourceRetired: boolean;
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

  /** The granter's person. */
  grantedBy: string;
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

  /** How many counted owners of a resource there are besides the holder of one grant. */
  countedOwnersBesides(question: {
    grantId: string;
    now: Date;
    resourceId: string;
  }): Promise<number>;

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
  findOfferedCategory(
    scopedName: string,
    resourceId: string,
  ): Promise<string | undefined>;

  /**
   * The person holding a subject's identity under the trusted issuer, recorded on first meeting
   * them.
   */
  findOrRecordPerson(subject: string, now: Date): Promise<string>;

  /** The person holding a subject's identity under the trusted issuer, or `undefined` for none. */
  findPerson(subject: string): Promise<string | undefined>;

  /** The role a name names exactly, or `undefined` for none. */
  findRole(name: string): Promise<StoredRole | undefined>;

  /**
   * Writes a grant, unless its holder holds one on the same terms neither revoked nor ended: a
   * creation racing another for the same terms waits until that one ends, and writes nothing once
   * it commits.
   *
   * @returns its id, or `undefined` when such a grant is held already.
   */
  insertGrant(grant: NewGrant): Promise<string | undefined>;

  /**
   * Where a grant held by a person stands: its resource's id and externalId, read without a lock.
   *
   * @param grantId an id in the form the store gives one.
   * @returns them, or `undefined` when no grant held by a person has the id.
   */
  locateGrant(
    grantId: string,
  ): Promise<{ externalId: string; resourceId: string } | undefined>;

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

  /** Where a principal stands on the resource holding an externalId, its row locked as asked. */
  readStanding(question: {
    externalId: string;
    lock: StandingLock;
    now: Date;
    subject: string;
  }): Promise<ResourceStanding | undefined>;

  /** Records a grant's revocation, at the instant given and by the person given. */
  revokeGrant(revocation: {
    grantId: string;
    now: Date;
    revokedBy: string;
  }): Promise<void>;
}

/** What the grant operations are created from. */
export interface GrantOperationsSettings {
  /**
   * The grant store over one transaction's connection.
   *
   * @param connection the transaction's connection.
   */
  grantStoreOf(connection: pg.PoolClient): GrantStore;

  /**
   * Whether a grant is accepted at its creation, the clock each time written is read from, the
   * schema, the trusted issuer, and the instance's submitter category.
   */
  settings: Pick<
    ControllerSettings,
    | 'clock'
    | 'databaseSchema'
    | 'grantAutoAccept'
    | 'identityProviderIssuer'
    | 'submitterCategory'
  >;

  /**
   * Where a refused request's event reads what it names, outside any transaction, on the control
   * pool.
   */
  store: StoreReader;

  /** Where each change runs, on the control pool, recording its events. */
  trail: Pick<AuditTrail<pg.PoolClient>, 'inTransaction'>;
}
