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
 * The controller's configuration: what it is created from. Every field but the clock and the log
 * stream is read from an environment variable of its own; a default named below is taken when the
 * environment leaves that variable unset, and a field naming none is required.
 */
export interface ControllerConfiguration {
  /** The identity provider realm role making its holder a platform administrator; `usher-platform-admin` by default. */
  administratorRole: string;

  /** The `aud` values a back-channel logout token may carry: the platform's client identifiers. */
  backChannelLogoutAudiences: readonly string[];

  /** The record actions the baseline confers on everyone, anonymous visitors included; count, view and export by default. */
  baseline: readonly RecordAction[];

  /** The controller's wall clock, which every duration it measures runs on; never read from the environment. */
  clock: Clock;

  /** The key cursors are encrypted under, shared by every instance: 32 bytes as 43 base64url characters in canonical form. */
  cursorKey: string;

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

  /** The schema the controller's tables live in. */
  databaseSchema: string;

  /** A connection URL under the controller's runtime role, which it names, carrying no password. */
  databaseUrl: string;

  /** The CloudEvents `source` every event carries: the same on every instance sharing the store, never one per instance. */
  eventSource: string;

  /** How long an open notice stream may stay silent before a heartbeat, in milliseconds; 10,000 by default. */
  heartbeatMilliseconds: number;

  /** The host the controller listens on. */
  host: string;

  /** The identity provider's issuer, exactly as its tokens carry it: https, or http to a loopback host only. */
  identityProviderIssuer: string;

  /** This instance's name, carried by every event it emits; unique among the instances sharing the store. */
  instanceName: string;

  /** The controller's own issuer: every Usher token's `iss`. */
  issuer: string;

  /**
   * The key-encryption key encrypting every stored application key, shared by every instance: 32 bytes
   * as 43 base64url characters in canonical form, read with any whitespace around it left out.
   */
  keyEncryptionKey: string;

  /** Where the controller writes its structured log lines; the process's standard output by default, never read from the environment. */
  logStream: Writable;

  /** The `aud` a management token must name: the Policy Management API's identifier at the identity provider. */
  managementAudience: string;

  /** The clients a management token's `azp` may name: the management screens' client identifiers. */
  managementClients: readonly string[];

  /** The most notices one poll answer carries before it names a next page; 500 by default. */
  noticePageLimit: number;

  /** How often each instance reads the notice stream again with no wake-up, in milliseconds; 2,000 by default. */
  noticeRereadMilliseconds: number;

  /** The port the controller listens on; 0 asks for any free port. */
  port: number;

  /** The grace period the notice retention floor counts beyond the token lifetime, in seconds; 60 by default. */
  retentionGraceSeconds: number;

  /** The margin the notice retention floor adds beyond the token lifetime and the grace period, in seconds; 30 by default. */
  retentionMarginSeconds: number;

  /** The identity provider realm role marking its holder's token as a service account's; a role other than the administrator role, `usher-service-account` by default. */
  serviceAccountRole: string;

  /** The longest lifetime of a sign-in token the controller accepts, in seconds. */
  signInTokenMaximumLifetimeSeconds: number;

  /** The record actions the signed-in rule confers on every signed-in principal; count, view and export by default. */
  signedInRule: readonly RecordAction[];

  /** How long the controller waits on the store for one request before answering it unavailable, in milliseconds; 5,000 by default. */
  storeTimeoutMilliseconds: number;

  /** The push streams one audience may hold open on one instance; 64 by default. */
  streamLimitPerAudience: number;

  /** The longest a notice stream stays open, in seconds; 900 by default, and never below 60. */
  streamMaximumLifetimeSeconds: number;

  /** The notices queued for one stream before a stream whose reader stopped reading is closed; 1,000 by default. */
  streamQueueLimit: number;

  /** How long an Usher token lives, in seconds; 300 by default. */
  tokenLifetimeSeconds: number;

  /** The addresses and CIDR ranges whose `X-Forwarded-For` the controller believes; none by default. */
  trustedProxies: readonly string[];
}

/** A configuration field the environment sets: every one but the clock and the log stream. */
export type FieldWithVariable = Exclude<
  keyof ControllerConfiguration,
  'clock' | 'logStream'
>;

/**
 * The schema migration command's configuration: what a migration run is given. Its connection is
 * read from variables of its own, which the controller never reads; the runtime role it grants to,
 * the schema and the durations the retention floor is made of are read from the controller's own
 * variables, alike, so the two never disagree.
 */
export interface SchemaMigrationConfiguration {
  /** The schema migration role's PostgreSQL password, read from a variable of its own and never shown. */
  databasePassword: string;

  /** A connection URL under the schema migration role, which owns the database and the schema, carrying no password. */
  databaseUrl: string;

  /** The notice retention floor, in seconds: the token lifetime plus the grace period and the margin. */
  retentionFloorSeconds: number;

  /**
   * The controller's runtime role, created before the run, to which the migrations grant: the
   * database role the controller's own URL names.
   */
  runtimeRole: string;

  /** The schema the controller's tables live in. */
  schema: string;
}

/** A field of the schema migration command's configuration read from a variable of the command's own. */
export type SchemaMigrationFieldWithVariable =
  'databasePassword' | 'databaseUrl';

/** The durations the notice retention floor is made of, read alike by the controller and its schema migration command. */
export type RetentionDurations = Pick<
  ControllerConfiguration,
  'retentionGraceSeconds' | 'retentionMarginSeconds' | 'tokenLifetimeSeconds'
>;
