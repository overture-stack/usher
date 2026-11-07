/**
 * What a migration run is told: the schema migration command's arguments, given as they were read.
 * The command names no connection timeout and no target, which a test may.
 */
export interface MigrationOptions {
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
   * The notice retention floor in seconds, the token lifetime plus the grace period and the margin.
   * The run stores it for the trimming function to read, so the controller's own role can never
   * lower it. A whole number of seconds, at least 1.
   */
  retentionFloorSeconds: number;

  /** The controller's runtime role, created before the run, to which the migrations grant. */
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

  /**
   * The retention floor the database holds once the run has stored it, in seconds; absent when the
   * run stopped before the migration creating its table.
   */
  retentionFloorSeconds?: number;
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
export type RefusedOption = 'databaseUrl' | 'runtimeRole' | 'schema';
