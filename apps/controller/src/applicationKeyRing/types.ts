import type { KeyObject } from 'node:crypto';

import type pg from 'pg';

/** The subkeys derived from one application key, each for one use, as the bridge derives them. */
export interface ApplicationSubkeys {
  /** Verifies the channel assertion: HMAC-SHA256. */
  channelAssertion: KeyObject;

  /** Encrypts pushed notices: AES-256-GCM. */
  notice: KeyObject;

  /** Encrypts poll answers: AES-256-GCM. */
  pollAnswer: KeyObject;

  /** Tags a subject as principal notices name it: HMAC-SHA256. */
  subjectTag: KeyObject;
}

/** One live application key, as its subkeys alone. */
export interface LiveApplicationKey extends ApplicationSubkeys {
  applicationId: string;
  keyId: string;
}

/** The live application keys an instance holds in memory, read from the store. */
export interface ApplicationKeyRing {
  /** Whether the ring holds a key as live. */
  holds(key: Pick<LiveApplicationKey, 'applicationId' | 'keyId'>): boolean;

  /**
   * An application's live keys, in order of issue: `undefined` when no application is registered
   * under the id, and none for one holding no live key.
   */
  liveKeysOf(applicationId: string): readonly LiveApplicationKey[] | undefined;

  /**
   * Reads the live keys again, resolving once a read begun after the call has ended. It never
   * rejects: a read that fails keeps the keys held, and is written to the log.
   */
  reload(): Promise<void>;

  /**
   * Reads the live keys a first time, then reads them again at every reload interval until stopped.
   *
   * @throws {StoreTimeout} when the store does not answer the first read within the store timeout;
   *   otherwise whatever the store throws.
   */
  start(): Promise<void>;

  /** Stops reading, settling once a read in flight has ended. */
  stop(): Promise<void>;
}

/** How the key ring opens a stored key, sealed under the key-encryption key. */
export interface SealedKeyOpener {
  /**
   * Opens a sealed key, bound to the application and the key it was sealed for.
   *
   * @returns the key's bytes, or `undefined` for a sealed key altered, of another form, or bound to
   *   another application or key.
   */
  open(
    identity: { applicationId: string; keyId: string },
    sealed: Uint8Array,
  ): Buffer | undefined;
}

/** Where the key ring reads the store: one statement at a time, each within the store timeout. */
export interface KeyStore {
  /**
   * Runs one statement on a connection of its own, within the store timeout.
   *
   * @param text the statement, every value bound.
   * @param values the values bound to it.
   */
  query<Row extends pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<Row>>;
}

/** Where the key ring writes its lines, each named by its message. */
export interface KeyRingLog {
  /** Writes a line at error. */
  error(message: string, fields?: Readonly<Record<string, string>>): void;
}

/** What the key ring is created from. */
export interface ApplicationKeyRingSettings {
  /** Called after a read that changed which keys are live. */
  changed(): void;

  /** Opens each sealed key. */
  cipher: SealedKeyOpener;

  /** Where a stored key that does not open, and a read that fails, are written. */
  log: KeyRingLog;

  /** The controller's schema. */
  schema: string;

  /** Where the keys are read, within the store timeout. */
  store: KeyStore;
}
