import type { Writable } from 'node:stream';

import type { RecordAction } from '@overture-stack/usher-types';

/** A source of the current time, in milliseconds since the Unix epoch. */
export interface Clock {
  now(): number;
}

/** The least access a resource's records take: open to everyone, to everyone signed in, or by grant alone. */
export type AccessLevel = 'grant' | 'open' | 'registered';

/** The environment a configuration is read from: a plain record of variables, as `process.env` holds them. */
export type ConfigurationEnvironment = Readonly<
  Record<string, string | undefined>
>;

/** When `grant.rateExceeded` fires: more grant operations by one actor than the count within the window. */
export interface GrantRateThreshold {
  operationCount: number;
  windowSeconds: number;
}

/**
 * The controller's configuration: what it is created from. Every field but the clock and the log
 * stream is read from an environment variable of its own; a default named below is taken when the
 * environment leaves that variable unset, and a field naming none is required.
 */
export interface ControllerConfiguration {
  /** The identity provider realm role making its holder a platform administrator; `usher-platform-admin` by default. */
  administratorRole: string;

  /**
   * The characters an instance adds to the default set an externalId may hold, ASCII letters, digits,
   * dot, underscore and hyphen; none by default.
   */
  allowedCharactersExtra: string;

  /** Whether a grant is accepted at creation without its recipient answering it; off by default. */
  autoAccept: boolean;

  /** The `aud` values a back-channel logout token may carry: the platform's client identifiers. */
  backChannelLogoutAudiences: readonly string[];

  /** The record actions the baseline confers on everyone, anonymous visitors included; count, view and export by default. */
  baseline: readonly RecordAction[];

  /** The cache's password, read from a variable of its own and never shown. */
  cachePassword: string;

  /** The cache's URL, carrying no password. */
  cacheUrl: string;

  /** The controller's wall clock, which every duration it measures runs on; never read from the environment. */
  clock: Clock;

  /** The key cursors are encrypted under, shared by every instance: 32 bytes as 43 base64url characters in canonical form. */
  cursorKey: string;

  /** The runtime role's PostgreSQL password, read from a variable of its own and never shown. */
  databasePassword: string;

  /** The schema the controller's tables live in. */
  databaseSchema: string;

  /** A connection URL under the controller's runtime role, carrying no password. */
  databaseUrl: string;

  /** The client id of the service account the controller resolves addresses through. */
  directoryClientId: string;

  /** That service account's secret, which no refusal, log line or answer ever shows. */
  directoryClientSecret: string;

  /** The identity provider realm the directory looks people up in. */
  directoryRealm: string;

  /**
   * The identity provider's base URL, whose admin API the directory reads; empty for none, by default,
   * which answers every operation needing an address as the directory unavailable.
   */
  directoryUrl: string;

  /** The EGO policies granting every study, each by its name, matched as literal text; none by default. */
  egoMigrationAllStudyPolicies: readonly string[];

  /** The base tier of each resource the EGO migration registers; `null`, none, by default. */
  egoMigrationBaseTier: AccessLevel | null;

  /**
   * The prefixes the EGO migration reads a study id after in a policy's name, matched as literal text
   * in their configured letter case; none by default, and never an empty one or one listed twice.
   */
  egoMigrationPrefixes: readonly string[];

  /** The CloudEvents `source` every event carries: the same on every instance sharing the store, never one per instance. */
  eventSource: string;

  /** When `grant.rateExceeded` fires. */
  grantRateThreshold: GrantRateThreshold;

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

  /** The access level a resource registered naming none takes; `registered` by default. */
  platformDefaultAccessLevel: AccessLevel;

  /** The port the controller listens on; 0 asks for any free port. */
  port: number;

  /** The grace period the notice retention floor counts beyond the token lifetime, in seconds; 60 by default. */
  retentionGraceSeconds: number;

  /** The margin the notice retention floor adds beyond the token lifetime and the grace period, in seconds; 30 by default. */
  retentionMarginSeconds: number;

  /** The longest an administrator's self-grant may last, in seconds; 86,400 by default. */
  selfGrantMaximumSeconds: number;

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

  /** The category a submitter grant names, as the payload names it; `global.unmarked` by default. */
  submitterCategory: string;

  /** How long an Usher token lives, in seconds; 300 by default. */
  tokenLifetimeSeconds: number;

  /** The addresses whose `X-Forwarded-For` the controller believes; none by default. */
  trustedProxies: readonly string[];
}

/** A configuration field the environment sets: every one but the clock and the log stream. */
export type FieldWithVariable = Exclude<
  keyof ControllerConfiguration,
  'clock' | 'logStream'
>;
