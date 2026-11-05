import type pg from 'pg';

import type { Clock, ControllerConfiguration } from '../configuration/index.js';
import type {
  AuditEventType,
  AuditTrail,
  EventLog,
  JsonValue,
  TrailConnection,
} from '../eventLog/index.js';
import type {
  TokenVerifier,
  UnverifiedReason,
} from '../identityProvider/index.js';

/** RFC 9457 problem details as the management API answers a refusal, carrying a code. */
export interface Problem {
  /** Names the refusal, for a caller to act on. */
  code: string;

  /** What was wrong, and what to do about it; never a value the request carried. */
  detail: string;

  status: number;

  /** The rule broken, in a few words. */
  title: string;
}

/** Who an accepted management token speaks for. */
export interface Principal {
  /** Whether the token carries the configured administrator realm role, read from each request's token. */
  administrator: boolean;

  /** The identity provider's subject, the token's `sub`. */
  subject: string;

  type: 'human' | 'serviceAccount';
}

/** The session an accepted token belongs to, as far as it names one. */
export interface Session {
  /** The token's `iat`, in seconds since the Unix epoch. */
  issuedAt?: number;

  /** The token's `sid`. */
  sid?: string;
}

/** What the management API reads of the configuration to judge a management token. */
export type ManagementTokenSettings = Pick<
  ControllerConfiguration,
  'administratorRole' | 'managementAudience' | 'managementClients'
>;

/**
 * What a verified management token's claims gave: a principal; a refusal naming its reason and the
 * token's subject; a token naming no subject to act for; or one whose subject or session cannot be
 * stored.
 */
export type ClaimsReading =
  | { kind: 'accepted'; principal: Principal; session: Session }
  | {
      kind: 'refused';
      reason:
        'expiredToken' | 'missingExpiry' | 'notYetValid' | 'otherAudience';
      subject: string;
    }
  | { kind: 'unreadable' }
  | { kind: 'unrepresentable' };

/** Where the management API reads the store outside any transaction. */
export type StoreReader = Pick<pg.Pool, 'query'>;

/**
 * Why a management credential is counted rather than recorded: it could not be verified, for an
 * {@link UnverifiedReason}, or it could not be read as exactly one Bearer credential.
 */
export type TallyReason = UnverifiedReason | 'malformedCredential';

/** The tally of management credentials that could not be read or verified. */
export interface RefusalTally {
  /** Counts one credential refused for the reason given. */
  count(reason: TallyReason): void;

  /** Starts reading the clock for each interval's end. */
  start(): void;

  /** Stops reading the clock, records the counts held, and settles once every recording has. */
  stop(): Promise<void>;
}

/** What the tally is created from. */
export interface RefusalTallySettings {
  /** The clock the intervals are measured on. */
  clock: Clock;

  /** Records one reason's count over an interval; a failure to is the recorder's to report. */
  record(reason: TallyReason, count: number): Promise<unknown>;
}

/** An event's members, as an operation names them. */
export type EventMembers = { readonly [member: string]: JsonValue };

/** What an operation is asked, once its caller is admitted and its request read. */
export interface OperationRequest<Input> {
  /** What the operation read from the body. */
  input: Input;

  /** The path's parameters, by the names the route gives them, decoded. */
  params: Readonly<Record<string, string>>;

  principal: Principal;

  /** The address the request came from, behind any trusted proxies. */
  sourceIp: string;
}

/** What an operation answered: a success, or a refusal. */
export type OperationOutcome =
  | {
      /** The answer's JSON body. */
      body: JsonValue;

      /** Whether the answer forbids storing it, as one carrying a key's value does. */
      forbidsStoring: boolean;

      kind: 'answered';
      status: number;
    }
  | { kind: 'refused'; problem: Problem };

/** What an operation read from a request's body: its input, or the refusal it earned. */
export type InputReading<Input> =
  { input: Input; kind: 'read' } | { kind: 'refused'; problem: Problem };

/** An event an operation records, and so records `denied` when it refuses. */
export interface OperationEvent {
  /**
   * The existing entities a request names, as the event's members, for the event recording its
   * refusal: never one the request would have created, nor an identifier naming nothing.
   */
  named(params: Readonly<Record<string, string>>): Promise<EventMembers>;

  type: AuditEventType;
}

/** Why the store refuses a principal whose token is otherwise accepted. */
export type StoredRefusal =
  'revokedPlatform' | 'revokedPrincipal' | 'signedOutSession';

/** Whose standing the store is asked about: the trusted issuer, the token's subject, and its session. */
export interface StandingQuestion {
  issuer: string;
  session: Session;
  subject: string;
}

/** One Management API operation, as its route and its reading of a request define it. */
export interface ManagementOperation<Input> {
  /** Whether it is for platform administrators alone, refusing everyone else before any lookup. */
  administratorOnly: boolean;

  /** Whether it takes a body: never, when the request sends one, or always. */
  body: 'none' | 'optional' | 'required';

  /** The event it records; an operation recording none, such as a read, records no refusal. */
  event?: OperationEvent;

  method: 'DELETE' | 'GET' | 'POST';

  /** Reads its input from the body's object, none when the request sent no body. */
  readInput(
    body: Readonly<Record<string, unknown>> | undefined,
  ): InputReading<Input>;

  /** The route's template, its parameters in braces, as the contract writes it. */
  route: string;

  /**
   * Answers an admitted, readable request. A failure it throws is the store's, since the store is
   * the one thing an operation reaches beyond itself.
   */
  run(request: OperationRequest<Input>): Promise<OperationOutcome>;
}

/** What every management operation's route is built on. */
export interface ManagementDependencies {
  /** Where an operational line is written. */
  eventLog: Pick<EventLog, 'error'>;

  refusalTally: Pick<RefusalTally, 'count'>;

  settings: ManagementTokenSettings &
    Pick<ControllerConfiguration, 'clock' | 'identityProviderIssuer'>;

  /** Reads whether the store refuses a principal, by a revocation of the person or the platform, or a sign-out. */
  storedRefusal(question: StandingQuestion): Promise<StoredRefusal | undefined>;

  tokenVerifier: TokenVerifier;

  /** Where refusals and failures are recorded. */
  trail: Pick<AuditTrail<TrailConnection>, 'recordEvent'>;
}
