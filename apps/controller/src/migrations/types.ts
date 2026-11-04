/** What a migration run is told: the migration command's arguments, given as they were read. */
export interface MigrationOptions {
  /** A connection URL under the migration role, which owns the database and the schema. */
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

  /** The last migration to apply, by name; every migration when absent. */
  target?: string;
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
