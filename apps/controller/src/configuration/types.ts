import type { Writable } from 'node:stream';

import type { RecordAction } from '@overture-stack/usher-types';

/** A source of the current time, in milliseconds since the Unix epoch. */
export interface Clock {
  now(): number;
}

/** The environment a configuration is read from: a plain record of variables, as `process.env` holds them. */
export type ConfigurationEnvironment = Readonly<
  Record<string, string | undefined>
>;

/**
 * The Controller's configuration: what it is created from. Every field but the clock and the log
 * stream is read from an environment variable of its own; a default named below is taken when the
 * environment leaves that variable unset, and a field naming none is required.
 */
export interface ControllerConfiguration {
  /**
   * The client used by the API documentation page at `/api-docs` to sign people in, which must be one
   * of the management clients exactly; empty, the default, for no page.
   */
  apiDocsClient: string;

  /** The `aud` values a back-channel logout token may carry: the platform's client identifiers. */
  backChannelLogoutAudiences: readonly string[];

  /** The Controller's wall clock, which every duration it measures runs on; never read from the environment. */
  clock: Clock;

  /** The key cursors are encrypted under, shared by every instance: 32 bytes as 43 base64url characters in canonical form. */
  cursorKey: string;

  /**
   * Whether a database connection that does not verify the server it reaches is allowed: off by
   * default, so a connection leaving the host must set `sslmode=verify-full`, or `sslmode=verify-ca`
   * with `sslrootcert`. On, every start writes a line at warning naming its variable.
   */
  databaseAllowUnverifiedConnection: boolean;

  /**
   * The store connections each instance holds for everything but the token exchange and readiness:
   * the Management API, the back-channel logout, the notice channel, the key reloads, the tallies and
   * the start; 5 by default.
   */
  databaseControlConnections: number;

  /**
   * The store connections each instance holds for the token exchange: its own transactions, its key
   * confirmations and its recordings of refused channel assertions; 10 by default. Each application's
   * admission share divides them.
   */
  databaseExchangeConnections: number;

  /** The runtime role's PostgreSQL password, read from a variable of its own and never shown. */
  databasePassword: string;

  /** The schema the Controller's tables live in. */
  databaseSchema: string;

  /** A connection URL under the Controller's runtime role, which it names, carrying no password. */
  databaseUrl: string;

  /** The host the Controller listens on. */
  host: string;

  /** The identity provider's issuer, exactly as its tokens carry it: https, or http to a loopback host only. */
  identityProviderIssuer: string;

  /** This instance's name, carried by every event it emits; unique among the instances sharing the store. */
  instanceName: string;

  /**
   * The key-encryption key encrypting every stored application key, shared by every instance: 32 bytes
   * as 43 base64url characters in canonical form, read with any whitespace around it left out.
   */
  keyEncryptionKey: string;

  /** Where the Controller writes its structured log lines; the process's standard output by default, never read from the environment. */
  logStream: Writable;

  /** The `aud` a management token must name: the Policy Management API's identifier at the identity provider. */
  managementAudience: string;

  /** The clients a management token's `azp` may name: the management screens' client identifiers. */
  managementClients: readonly string[];

  /** The port the Controller listens on; 0 asks for any free port. */
  port: number;

  /**
   * The identity provider realm role marking its holder's token as a service account's,
   * `usher-service-account` by default; the start refuses it when it names the first user's realm role.
   */
  serviceAccountRole: string;

  /** How long the Controller waits on the store for one request before answering it unavailable, in milliseconds; 5,000 by default. */
  storeTimeoutMilliseconds: number;

  /** The addresses and CIDR ranges whose `X-Forwarded-For` the Controller believes; none by default. */
  trustedProxies: readonly string[];
}

/** A configuration field the environment sets: every one but the clock and the log stream. */
export type FieldWithVariable = Exclude<
  keyof ControllerConfiguration,
  'clock' | 'logStream'
>;

/**
 * The schema migration command's configuration: what a migration run is given. Its connection is
 * read from variables of its own, which the Controller never reads; the runtime role it grants to,
 * the schema and whether an unverified database connection is allowed are read from the Controller's
 * own variables, alike, so the two never disagree.
 */
export interface SchemaMigrationConfiguration {
  /**
   * The seed file the first run seeds the settings from, as the path given, or `./seed.json` when the
   * variable is unset: relative paths resolve against the command's working directory.
   */
  seedFile: string;

  /** Whether a database connection that does not verify the server it reaches is allowed, as the Controller reads it. */
  databaseAllowUnverifiedConnection: boolean;

  /** The schema migration role's PostgreSQL password, read from a variable of its own and never shown. */
  databasePassword: string;

  /** A connection URL under the schema migration role, which owns the database and the schema, carrying no password. */
  databaseUrl: string;

  /**
   * The Controller's runtime role, created before the run, to which the migrations grant: the
   * database role the Controller's own URL names.
   */
  runtimeRole: string;

  /** The schema the Controller's tables live in. */
  schema: string;
}

/** A field of the schema migration command's configuration read from a variable of the command's own. */
export type SchemaMigrationFieldWithVariable =
  'seedFile' | 'databasePassword' | 'databaseUrl';
