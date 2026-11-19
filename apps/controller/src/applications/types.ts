import type pg from 'pg';

import type { ControllerConfiguration } from '../configuration/index.js';
import type { AuditTrail } from '../eventLog/index.js';
import type { StoreReader } from '../managementApi/index.js';

/** What a stored application key is bound to: its application's id and its own. */
export interface ApplicationKeyIdentity {
  applicationId: string;
  keyId: string;
}

/** Seals application keys for the store, and opens them again. */
export interface ApplicationKeyCipher {
  /**
   * Opens a sealed key, bound to the identity given.
   *
   * @returns the key's bytes, or `undefined` for a sealed key altered, of another form, or bound to
   *   another application or key.
   */
  open(
    identity: ApplicationKeyIdentity,
    sealed: Uint8Array,
  ): Buffer | undefined;

  /**
   * Seals a 32-byte key, bound to the identity given.
   *
   * @throws {RangeError} for a key of any other length.
   */
  seal(identity: ApplicationKeyIdentity, key: Uint8Array): Buffer;
}

/** What reading a display name gave: the name as stored, or the rule it broke. */
export type DisplayNameReading =
  | { displayName: string; kind: 'read' }
  | { kind: 'refused'; rule: 'blank' | 'tooLong' };

/** An application key as the store holds it, its value never among it. */
export interface StoredApplicationKey {
  confirmedAt: Date | null;
  id: string;
  issuedAt: Date;

  /** The subject of the identity that issued it. */
  issuedBy: string | null;

  revokedAt: Date | null;

  /** The subject of the identity that revoked it, while it is revoked. */
  revokedBy: string | null;
}

/** An application as the store holds it, with every key it was issued, in order of issue. */
export interface StoredApplication {
  description: string | null;
  displayName: string;
  id: string;
  keys: readonly StoredApplicationKey[];
  registeredAt: Date;

  /** The subject of the identity that registered it. */
  registeredBy: string | null;
}

/** An application key as issued: its id, and its value, shown in the answer issuing it alone. */
export interface IssuedApplicationKey {
  id: string;

  /** 32 bytes as 43 base64url characters. */
  value: string;
}

/** What the application operations are created from. */
export interface ApplicationOperationsSettings {
  cipher: ApplicationKeyCipher;

  /** The clock each time written is read from, the schema, and the trusted issuer people are found under. */
  settings: Pick<
    ControllerConfiguration,
    'clock' | 'databaseSchema' | 'identityProviderIssuer'
  >;

  /** Where an application is read. */
  store: StoreReader;

  /** Where each change runs, recording its events. */
  trail: Pick<AuditTrail<pg.PoolClient>, 'inTransaction'>;
}
