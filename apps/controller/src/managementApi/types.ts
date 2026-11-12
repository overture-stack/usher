import type pg from 'pg';

import type { ControllerConfiguration } from '../configuration/index.js';
import type {
  AuditEventType,
  AuditTrail,
  EventLog,
  JsonValue,
  TrailConnection,
} from '../eventLog/index.js';
import type { Problem } from '../http/index.js';
import type { TokenVerification } from '../identityProvider/index.js';
import type {
  Session,
  StandingQuestion,
  StoredRefusal,
} from '../signInTokens/index.js';

/** Who an accepted management token speaks for. */
export interface Principal {
  /** Whether the token carries the configured administrator realm role, read from each request's token. */
  administrator: boolean;

  /** The identity provider's subject, the token's `sub`. */
  subject: string;

  type: 'human' | 'serviceAccount';
}

/** What the management API reads of the configuration to judge a management token. */
export type ManagementTokenSettings = Pick<
  ControllerConfiguration,
  'administratorRole' | 'managementAudience' | 'managementClients'
>;

/**
 * Where the management API verifies a management token: its signature, under the trusted issuer's
 * published keys alone, and its `iss`. A verifier judges no other claim, since the management API
 * judges each one itself and records a refusal by its reason.
 */
export interface TokenVerifier {
  /**
   * Verifies a compact signed token, giving its claims once its signature and issuer verify, why it
   * was not verified, that the trusted issuer's keys could not be had to verify it, or that its
   * signing key is not confirmed yet, with the whole seconds the caller is told to wait before trying
   * again.
   *
   * @param token the token carried by a request's Bearer credential.
   */
  verify(token: string): Promise<TokenVerification>;
}

/**
 * What a verified management token's claims gave: a principal; a refusal naming its reason and the
 * token's subject, `otherType` for a token not recognized as an access token; a token naming no
 * subject to act for; or one whose subject or session cannot be stored.
 */
export type ClaimsReading =
  | { kind: 'accepted'; principal: Principal; session: Session }
  | {
      kind: 'refused';
      reason:
        | 'expiredToken'
        | 'missingExpiry'
        | 'notYetValid'
        | 'otherAudience'
        | 'otherType';
      subject: string;
    }
  | { kind: 'unreadable' }
  | { kind: 'unrepresentable' };

/**
 * Where the management API, and each operation built on it, reads the store outside any transaction:
 * one statement at a time, each within the store timeout, so a request is refused rather than held
 * open when the store stops answering.
 */
export interface StoreReader {
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

/**
 * Why a management credential is counted rather than recorded, each the `reason` of a
 * `managementToken.refusalTally` event: it could not be read as exactly one Bearer credential
 * (`malformedCredential`), or its token could not be verified, being unreadable as a signed token
 * (`unreadableToken`), naming an issuer other than the trusted one (`otherIssuer`), or verifying under
 * none of the trusted issuer's published keys (`invalidSignature`). The management API lists these
 * itself, since they are its audit trail's vocabulary: a reason the verifier adds is mapped onto one
 * of them, or added here, by a decision made in this module.
 */
export type TallyReason =
  | 'invalidSignature'
  | 'malformedCredential'
  | 'otherIssuer'
  | 'unreadableToken';

/** Where the management API counts each credential it could not read or verify. */
export interface RefusalTally {
  /** Counts one credential refused for the reason given. */
  count(reason: TallyReason): void;
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
      /** The answer's JSON body, or none for a success answered with no content. */
      body: JsonValue | undefined;

      /** Whether the answer forbids storing it, as one carrying a key's value does. */
      forbidsStoring: boolean;

      kind: 'answered';
      status: number;
    }
  | { kind: 'refused'; problem: Problem };

/** What an operation read from a request's body and query: its input, or the refusal it earned. */
export type InputReading<Input> =
  { input: Input; kind: 'read' } | { kind: 'refused'; problem: Problem };

/** A request's query parameters, decoded, in the order sent, one sent twice listed twice. */
export type QueryParameters = readonly (readonly [
  name: string,
  value: string,
])[];

/** What an operation reads its input beside the body from: who calls, and the query sent. */
export interface InputContext {
  principal: Principal;

  /** The query's parameters: none for an operation taking none, which refuses any sent. */
  query: QueryParameters;
}

/** An event an operation records, and so records `denied` when it refuses. */
export interface OperationEvent {
  /**
   * The existing entities a request names, as the event's members, for the event recording its
   * refusal: never one the request would have created, nor an identifier naming nothing.
   */
  named(params: Readonly<Record<string, string>>): Promise<EventMembers>;

  type: AuditEventType;
}

/**
 * A step an operation may name, to be run once its change has committed and before it is answered, so
 * the instance answering holds what the change made: `keyReload` reads the live application keys
 * again. A step also runs for a change whose `COMMIT` the store did not confirm, so it runs whether or
 * not the commit took effect and must be safe either way, as a step that only reads is; every step
 * added here is held to that.
 */
export type AfterCommitStepName = 'keyReload';

/** One Management API operation, as its route and its reading of a request define it. */
export interface ManagementOperation<Input> {
  /** Whether it is for platform administrators alone, refusing everyone else before any lookup. */
  administratorOnly: boolean;

  /**
   * The steps its change needs, run in turn once it has answered a change it committed, or once its
   * change's `COMMIT` went unconfirmed, and before the answer is sent; none for an operation naming
   * none, and none for a refusal or any other failure.
   */
  afterCommit?: readonly AfterCommitStepName[];

  /** Whether it takes a body: never, when the request sends one, or always. */
  body: 'none' | 'optional' | 'required';

  /** The event it records; an operation recording none, such as a read, records no refusal. */
  event?: OperationEvent;

  method: 'DELETE' | 'GET' | 'POST' | 'PUT';

  /**
   * Reads its input from the body's object, none when the request sent no body, and from the query's
   * parameters, for an operation taking any, judging the principal's standing for what they name.
   */
  readInput(
    body: Readonly<Record<string, unknown>> | undefined,
    context: InputContext,
  ): InputReading<Input>;

  /** The route's template, its parameters in braces, as the contract writes it. */
  route: string;

  /** Whether it takes query parameters; one taking none refuses any sent, 400 `unreadableQuery`. */
  takesQuery?: boolean;

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

  refusalTally: RefusalTally;

  /**
   * Runs the steps an operation names, in turn, once its change has committed or may have. It never
   * rejects: a step that fails is written to the log, since the answer must say what the commit did.
   */
  runAfterCommit(steps: readonly AfterCommitStepName[]): Promise<void>;

  settings: ManagementTokenSettings &
    Pick<ControllerConfiguration, 'clock' | 'identityProviderIssuer'>;

  /** Reads whether the store refuses a principal, by a revocation of the person or the platform, or a sign-out. */
  storedRefusal(question: StandingQuestion): Promise<StoredRefusal | undefined>;

  tokenVerifier: TokenVerifier;

  /** Where refusals and failures are recorded. */
  trail: Pick<AuditTrail<TrailConnection>, 'recordEvent'>;
}
