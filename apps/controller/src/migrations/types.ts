import type { Clock } from '../configuration/index.js';
import type { EventLog } from '../eventLog/index.js';
import type { StartProblem } from '../failures/index.js';
import type { Settings } from '../settings/index.js';

/**
 * What the seed file gave a run: the text of the file at its path, nothing when no file is there, or the reason
 * the file cannot be read, which is the error's code, or 'unknown' when it carries none.
 */
export type SeedFile = { kind: 'absent' } | { kind: 'present'; text: string } | { kind: 'unreadable'; reason: string };

/**
 * What a run did with the seed file: a first run seeded the settings from it; a later run compared its members
 * with the ones the first run stored, which changed nothing, and named each top-level key that differs; no file
 * was there to compare; or a later run could not compare it, the file being unreadable, with the reason, or not
 * one JSON object, with the problem its text breaks. A later run changes nothing in any of these cases.
 */
export type SeedFileOutcome =
	| { kind: 'absent' }
	| { kind: 'changed'; added: readonly string[]; changed: readonly string[]; removed: readonly string[] }
	| { kind: 'invalid'; problem: string }
	| { kind: 'seeded' }
	| { kind: 'unchanged' }
	| { kind: 'unreadable'; reason: string };

/**
 * What a migration run is told: the schema migration command's arguments, given as they were read.
 * The command names no connection timeout and no target, which a test may.
 */
export interface MigrationOptions {
	/**
	 * Reads the seed file at the run's path, once, before anything is written: the text it holds, nothing when no
	 * file is there, or the reason it cannot be read. A first run reads it as the settings to seed, and a later run
	 * compares it with the members the first run stored, changing nothing either way.
	 */
	seed: () => Promise<SeedFile>;

	/** The clock the seeding event's time is read from. */
	clock: Clock;

	/** Where the seeding event's line is written. */
	eventLog: Pick<EventLog, 'error' | 'writeEvent'>;

  /**
   * How long the run waits to connect and sign in before it gives up, in milliseconds; 30,000 by
   * default. Statements have no limit, since a migration's changes to the schema may run long.
   */
  connectionTimeoutMilliseconds?: number;

  /**
   * The schema migration role's password, read from a variable of its own; when absent, the URL's
   * own, if it carries one.
   */
  databasePassword?: string;

  /** A connection URL under the schema migration role, which owns the database and the schema. */
  databaseUrl: string;

  /**
   * The Controller's runtime role, created before the run, to which the migrations grant, and the
   * run grants reading the record of applied migrations.
   */
  runtimeRole: string;

  /** The schema the tables live in, created by the run when absent. */
  schema: string;

  /**
   * Stops the run once aborted: once connected, the run ends its connection, which rolls back the
   * migration in flight and releases the run's lock, and rejects saying it was stopped. Every
   * migration it committed before the stop stays applied. A stop while connecting takes effect once
   * the connection is made or refused.
   */
  signal?: AbortSignal;

  /** The last migration to apply, by name; every migration when absent. */
  target?: string;
}

/** What a migration run did. */
export interface MigrationOutcome {
  /** The migrations the run applied, by name, in order; none on a database already current. */
  applied: readonly string[];

	/** Whether the run seeded the settings: true on a first run, false on a run against a database already holding them. */
	settingsSeeded: boolean;

	/** What the run did with the seed file. */
	seedFile: SeedFileOutcome;
}

/** One numbered migration, as read from its file. */
export interface Migration {
  /** The SHA-256 of the file's bytes, in hex, which the record of an applied migration keeps. */
  checksum: string;

  /** The file's name without its extension, such as `0001_policy_store`; names sort in order. */
  name: string;

  /** The file's statements, naming the schema as `:"schema"` and the runtime role as `:"runtime_role"`. */
  sql: string;
}

/** A migration the database records as applied. */
export interface AppliedMigration {
  checksum: string;
  name: string;
}

/** The names a migration's statements are given, each an identifier quoted where it is placed. */
export interface MigrationNames {
  runtimeRole: string;
  schema: string;
}

/** An option of a migration run that a refusal can be laid on. */
export type RefusedOption = 'databaseUrl' | 'runtimeRole' | 'schema' | 'seedFile';

/**
 * A migration the database records as applied that this release does not know, as a line or a
 * refusal names it.
 */
export interface UnknownMigration {
  /**
   * Whether this release holds a migration of that name, whose checksum differs from the record's.
   */
  checksumDiffers: boolean;

  /**
   * The recorded name when it is in migration form, and otherwise a fixed phrase saying it is not,
   * so no other value the database holds is ever written.
   */
  name: string;
}

/** What refused because the database records a migration this release does not know. */
export type UnknownMigrationRefusal = 'readiness' | 'start';
