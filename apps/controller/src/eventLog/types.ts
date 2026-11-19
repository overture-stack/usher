import type { Deadline } from '../storeTimeout/index.js';
import type { ControllerSettings } from '../settings/index.js';

/** A value JSON can hold, as a line's field or an event's data carries it. */
export type JsonValue =
  | boolean
  | number
  | string
  | null
  | readonly JsonValue[]
  | { readonly [member: string]: JsonValue };

/**
 * An operational line's fields. The log writes `level`, `message` and `time` itself, and a field of
 * one of those names is left out rather than written twice.
 */
export type LineFields = Readonly<Record<string, JsonValue>>;

/** How serious an event is, as the Severity column of `audit-events.md` names it. */
export type Severity = 'critical' | 'error' | 'info' | 'warning';

/**
 * One event as its line and its row hold it: the CloudEvents envelope, with the severity as an
 * extension attribute beside the standard's own.
 */
export interface EventEnvelope {
  data: { readonly [member: string]: JsonValue };

  /** Which definition of `data` applies, where one is published; absent otherwise. */
  dataschema?: string;

  /** Unique per event: the row's key, and how a line and its row are matched. */
  id: string;

  severity: Severity;

  /** Where it was emitted from: the same on every instance sharing the store, never one per instance. */
  source: string;

  specversion: string;

  /** When it happened: RFC 3339 in UTC, with the `Z` designator. */
  time: string;

  /** What happened, with the `bio.overture.` prefix. */
  type: string;
}

/**
 * The Controller's log stream: one JSON object per line, each member once, an event's line holding
 * its envelope and any other line operational. Every line carries the logger's numeric level in
 * `level`. Nothing written throws: a line the stream cannot take is dropped, and the log reports
 * itself unwritable from then on, since a stream that has failed a write takes nothing more.
 */
export interface EventLog {
  /**
   * Stops writing, dropping any line given after, and lets go of the stream once the lines already
   * written have settled. The stream itself is never ended, since it is the configuration's.
   */
  close(): void;

  /** Writes an operational line at the logger's error level. */
  error(message: string, fields?: LineFields): void;

  /** Writes an operational line at the logger's info level. */
  info(message: string, fields?: LineFields): void;

  /** Whether every line so far has reached the stream: true until one fails, and false after. */
  isWritable(): boolean;

  /** Writes an operational line at the logger's warn level. */
  warning(message: string, fields?: LineFields): void;

  /**
   * Writes an event's line: its envelope, at the level its severity maps to, a critical event at the
   * logger's error level.
   */
  writeEvent(envelope: EventEnvelope): void;
}

/** What the log is created from: the clock its lines' times are read from, and the stream they go to. */
export type EventLogSettings = Pick<ControllerSettings, 'clock' | 'logStream'>;

/**
 * Who acts, by the kinds `audit-events.md` names: a person or a service account by the identity
 * provider's subject, which is never empty; a system or anonymous actor names nobody.
 */
export type Actor =
  | { id: string; type: 'human' | 'serviceAccount' }
  | { type: 'anonymous' | 'system' };

/**
 * Every event the Controller records: the Controller's rows of the Events table in
 * `audit-events.md`, each without the `bio.overture.` prefix its line and row carry.
 */
export type AuditEventType =
  | 'admin.acceptance'
  | 'admin.nomination'
  | 'admin.override'
  | 'admission.shareExceededTally'
  | 'application.registration'
  | 'application.servedResourcesChange'
  | 'applicationKey.confirmation'
  | 'applicationKey.issuance'
  | 'applicationKey.revocation'
  | 'applicationKey.unreadable'
  | 'audit.read'
  | 'category.creation'
  | 'channelAssertion.rejection'
  | 'channelAssertion.rejectionTally'
  | 'grant.creation'
  | 'grant.decision'
  | 'grant.extension'
  | 'grant.rateExceeded'
  | 'grant.reduction'
  | 'grant.revocation'
  | 'grant.selfCreation'
  | 'grantRules.change'
  | 'identity.revocation'
  | 'identity.revocationLift'
  | 'identity.signOut'
  | 'identityProvider.configurationChange'
  | 'invitation.claim'
  | 'invitation.creation'
  | 'invitation.lapse'
  | 'logoutToken.refusal'
  | 'logoutToken.refusalTally'
  | 'managementToken.refusal'
  | 'managementToken.refusalTally'
  | 'import.run'
  | 'ownership.transfer'
  | 'platform.revocation'
  | 'resource.deletion'
  | 'resource.detailsUpdate'
  | 'resource.orphaned'
  | 'resource.registration'
  | 'resource.restoration'
  | 'resource.retirement'
  | 'resource.revocation'
  | 'resource.suppression'
  | 'settings.change'
  | 'settings.seeding'
  | 'token.exchange'
  | 'token.exchangeRefusalTally';

/** One audit event, as it is recorded in a transaction. */
export interface AuditEvent {
  /** Whom the event names as its actor: the transaction's actor unless given. */
  actor?: Actor;

  /**
   * The event's own members. The trail writes `actorId` and `actorType` from the actor and
   * `instance` from the configuration over any given here.
   */
  data: { readonly [member: string]: JsonValue };

  /** Which definition of `data` applies, where one is published. */
  dataschema?: string;

  severity: Severity;
  type: AuditEventType;
}

/** A transaction in progress, its actor declared. */
export interface AuditTransaction<Connection> {
  /** The transaction's connection, for the change's own statements. */
  connection: Connection;

  /**
   * Writes an event's row in the transaction, resolving to the event's id once it is written. Its
   * line is written once the transaction commits, and never when it rolls back.
   *
   * @throws once the transaction has ended.
   */
  record(event: AuditEvent): Promise<string>;
}

/**
 * One connection the audit trail runs a transaction on, released once the transaction ends. It must
 * run a text of several statements given without values as one query, its statements in order.
 */
export interface TrailConnection {
  /**
   * Runs a statement, or a text of several given without values, resolving, for a single statement,
   * to the command the store answered it with, such as `COMMIT`.
   */
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly command: string }>;

  /** Returns the connection to its pool, or discards it when `destroy` is true. */
  release(destroy?: boolean): void;
}

/** Where the audit trail takes each transaction's connection from: the Controller's pool. */
export interface TrailStore<Connection extends TrailConnection> {
  connect(): Promise<Connection>;
}

/**
 * How one transaction is run, where it differs from the default: its bounds, where they differ from
 * the configured store timeout, and the event it records when its work fails.
 */
export interface TransactionOptions {
  /**
   * When the request the transaction runs for must have been answered, for a transaction one deadline
   * bounds with the rest of its request, as the exchange's are. The transaction's work is bounded by
   * its timeout or the time left to the deadline as it begins, whichever is shorter, and both limits
   * the store applies to a session are set to that bound inside the transaction alone. Its `COMMIT`
   * is given its timeout or the time left as it is about to be sent, whichever is shorter, and is not
   * sent at all with too little left, the transaction then abandoned as one the store did not answer
   * in time. A transaction naming none is bounded by its timeout alone.
   */
  deadline?: Deadline;

  /**
   * The event recorded in the work's place when the work fails, for a unit whose design records its
   * own failure. The work then runs under a savepoint taken in the one query that begins the
   * transaction, before the actor is declared. When it fails, for any reason, the transaction is
   * rolled back to that savepoint, which also reverts the actor's declaration and any limits set with
   * it, and the actor and those limits are declared again with the values first declared; every event
   * the work recorded is forgotten, its row never written and its line never written, and this event
   * is recorded and committed in their place; the work's failure is then thrown, whatever became of
   * the `COMMIT`. A connection that cannot be rolled back to the savepoint, that fails the actor's
   * declaration made again, or that fails this event's row, records nothing: the transaction is
   * rolled back whole and the work's failure thrown. A transaction abandoned for its timeout or its
   * deadline before this event is recorded fails as any other does. A transaction naming none rolls
   * back whole when its work fails.
   */
  failureEvent?: AuditEvent;

  /**
   * The transaction's own timeout, in milliseconds, set where the unit is defined, as its design
   * gives it: it takes the place of the store timeout for the whole transaction, and both limits the
   * store applies to a session are raised to it inside the transaction alone. A transaction naming
   * none runs within the store timeout.
   */
  timeoutMilliseconds?: number;
}

/** The audit trail: each event's row written in the transaction of the change it records. */
export interface AuditTrail<Connection> {
  /**
   * Runs work in one transaction that declares, before the work, the actor each change in it is to
   * be recorded under. The rows of the events the work records commit with the change, and
   * their lines are written once it has committed, in the order recorded. When the work, a row or
   * the commit fails, the transaction rolls back, no line is written, and the failure is thrown,
   * except where a failure event records the work's failure, as
   * {@link TransactionOptions.failureEvent} says. A line the log stream cannot take changes nothing
   * of what committed. Taking the connection and the work run within the store timeout, or the
   * transaction's own; past it, the transaction is abandoned, its connection discarded, and no line
   * is written. The `COMMIT` is given one more timeout for its answer; past that, no line is written
   * either, and one line at error names the `id` and `type` of each event recorded, whose rows may
   * or may not have committed. A transaction given a deadline is bounded by it as well, as
   * {@link TransactionOptions.deadline} says, and never runs past it.
   *
   * @param actor who acts in the transaction.
   * @param work the change's statements, run on the transaction's connection.
   * @param options the transaction's own timeout, for a unit whose design gives it one; the deadline,
   *   for a unit one deadline bounds with the rest of its request; and the event recorded in the
   *   work's place when it fails, for a unit recording its own failure.
   * @throws when the actor names an empty subject, before anything runs.
   * @throws the work's failure, where a failure event is given and the work fails, unless the
   *   transaction was abandoned before that event was recorded.
   * @throws {StoreTimeout} when the store does not answer the transaction before its `COMMIT` in time,
   *   or too little is left to its deadline to send the `COMMIT`.
   * @throws {CommitUnconfirmed} when the store does not answer the `COMMIT` within its bound.
   */
  inTransaction<Result>(
    actor: Actor,
    work: (transaction: AuditTransaction<Connection>) => Promise<Result>,
    options?: TransactionOptions,
  ): Promise<Result>;

  /**
   * Records an event that accompanies no change, such as a refusal, in a transaction of its own
   * declaring the actor given, within the store timeout. Nothing it meets is thrown: when the row
   * cannot be written, as with the store down or not answering in time, it writes an operational
   * line at error naming the event's type and the failure's code, never the event's data, and
   * resolves to `undefined`. When its `COMMIT` goes unconfirmed, the row may have committed: it is
   * never written again, and the one line naming it is the transaction's, so it resolves to
   * `undefined` writing nothing more.
   *
   * @param actor who acts.
   * @param event the event.
   * @returns the event's id once its row has committed.
   */
  recordEvent(actor: Actor, event: AuditEvent): Promise<string | undefined>;
}

/** What the audit trail is created from. */
export interface AuditTrailSettings<Connection extends TrailConnection> {
  /** Where each committed event's line is written, and the line naming an event whose row was not. */
  eventLog: Pick<EventLog, 'error' | 'writeEvent'>;

  /**
   * The clock events' times are read from, the store's schema, the event source, the instance's name,
   * and the store timeout each transaction runs within.
   */
  settings: Pick<
    ControllerSettings,
    | 'clock'
    | 'databaseSchema'
    | 'eventSource'
    | 'instanceName'
    | 'storeTimeoutMilliseconds'
  >;

  store: TrailStore<Connection>;
}
