import type { KeyObject } from 'node:crypto';

import type { RouteOptions } from 'fastify';
import type pg from 'pg';

import type { Admission } from '../admission/index.js';
import type {
  AssertionRefusals,
  ChannelAssertionCheck,
  UnverifiedRejectionReason,
} from '../channelAssertion/index.js';
import type { ControllerConfiguration } from '../configuration/index.js';
import type { AuditTrail } from '../eventLog/index.js';
import type { Deadline } from '../storeTimeout/index.js';
import type {
  SignInJudgement,
  SignInJudgementContext,
} from '../signInTokens/index.js';

/** An application's live key as the exchange answers with it: its application, its id, and its token subkey. */
export interface ExchangeKey {
  applicationId: string;
  keyId: string;

  /** Seals Usher tokens: AES-256-GCM. */
  token: KeyObject;
}

/** Where the exchange checks each request's channel assertion. */
export interface ExchangeAssertionVerifier {
  /**
   * Checks a request's channel assertion, from memory alone.
   *
   * @param rawHeaders the request's header names and values, alternating, as Node gives them.
   */
  verify(
    rawHeaders: readonly string[],
  ): Promise<ChannelAssertionCheck<ExchangeKey>>;
}

/** Where the exchange counts each refusal of an assertion that could not be verified. */
export interface RejectionCounter {
  /**
   * Counts one refusal.
   *
   * @param reason why it was refused.
   * @param applicationId the registered application the assertion names, or `undefined` for none.
   */
  count(reason: UnverifiedRejectionReason, applicationId?: string): void;
}

/**
 * Judges a credential presented at the exchange for the calling application at an instant. The
 * exchange gives it those two alone, so the judge holds everything else a judgement needs: the
 * verifier every route verifying the identity provider's tokens shares, and the longest lifetime a
 * sign-in token may have.
 *
 * @param credential the credential, as the request carried it.
 * @param context the calling application's id, and the instant.
 */
export type CredentialJudge = (
  credential: string,
  context: Pick<SignInJudgementContext, 'audience' | 'now'>,
) => Promise<SignInJudgement>;

/** Where the exchange counts each exchange it refuses over its application's share. */
export interface ShareExceededCounter {
  /**
   * Counts one refusal.
   *
   * @param applicationId the application the refused exchange was for.
   */
  count(applicationId: string): void;
}

/** Where the exchange writes its operational lines, each named by its message. */
export interface ExchangeLog {
  /** Writes a line at error. */
  error(message: string, fields?: Readonly<Record<string, string>>): void;

  /** Writes a line at warning. */
  warning(message: string, fields?: Readonly<Record<string, string>>): void;
}

/** The keys an instance confirms, each at the first exchange verified with it. */
export interface KeyConfirmations {
  /**
   * Confirms a key an exchange's channel assertion verified under, unless the instance knows it
   * confirmed already; exchanges racing on one key share one write, bounded by the deadline of the
   * exchange that began it. It never rejects: a confirmation that cannot be written, or is not
   * written by that deadline, is written to the log, and tried again at the key's next exchange.
   *
   * @param key the application and the key the assertion verified under.
   * @param deadline the exchange's deadline, which bounds the write it begins; none bounds it by the
   *   store timeout alone.
   */
  confirm(
    key: Pick<ExchangeKey, 'applicationId' | 'keyId'>,
    deadline?: Deadline,
  ): Promise<void>;
}

/** What the confirmations are created from. */
export interface KeyConfirmationSettings {
  /** Where a confirmation that cannot be written is written. */
  eventLog: Pick<ExchangeLog, 'error'>;

  /** The clock a confirmation's time is read from, and the schema. */
  settings: Pick<ControllerConfiguration, 'clock' | 'databaseSchema'>;

  /** Where each confirmation and its `applicationKey.confirmation` are written, in a transaction of their own. */
  trail: Pick<AuditTrail<pg.ClientBase>, 'inTransaction'>;
}

/** What the exchange is created from. */
export interface ExchangeSettings {
  /** Admits each exchange's store work, and each recording of a refused assertion, within its application's share. */
  admission: Admission;

  /**
   * The most recordings of refused assertions the exchange holds waiting on the store at once, as
   * `pendingRecordingLimit` gives it from the exchange pool's connections.
   */
  assertionRecordingLimit: number;

  /**
   * The instance's recording of refused assertions, from which the exchange takes its own recorder:
   * it records the instance's first refusal of each assertion that verified through the exchange's
   * trail and counts the rest, never holding up the answer.
   */
  assertionRefusals: Pick<AssertionRefusals, 'forRoute'>;

  /** Where each refusal of an assertion that could not be verified is counted. */
  assertionRejections: RejectionCounter;

  /** Checks each request's channel assertion. */
  assertions: ExchangeAssertionVerifier;

  /**
   * The exchange's deadline, in milliseconds: when the controller must have answered an exchange,
   * measured from the request's arrival. It must be shorter than the bridge's timeout, how long the
   * bridge waits for the answer, by the margin left for the network and for writing the answer.
   */
  deadlineMilliseconds: number;

  /** Where the exchange writes its operational lines. */
  eventLog: ExchangeLog;

  /** Judges each credential presented. */
  judgeCredential: CredentialJudge;

  /** Confirms each key an exchange's channel assertion verifies under. */
  keyConfirmations: KeyConfirmations;

  /**
   * The least time left to its deadline, in milliseconds, for a request whose body has arrived to be
   * served rather than answered `408 requestTimeout` as late.
   */
  lateRequestThresholdMilliseconds: number;

  /**
   * The monotonic clock every reading of a deadline is made on, in milliseconds, such as
   * `performance.now`: never the configured clock, which a test may hold still or move by hand.
   */
  monotonicNow(): number;

  /**
   * The baseline and the signed-in rule, the clock, the schema, the identity provider's issuer, the
   * controller's own issuer, the service-account realm role, and the token lifetime.
   */
  settings: Pick<
    ControllerConfiguration,
    | 'baseline'
    | 'clock'
    | 'databaseSchema'
    | 'identityProviderIssuer'
    | 'issuer'
    | 'serviceAccountRole'
    | 'signedInRule'
    | 'tokenLifetimeSeconds'
  >;

  /** Where each exchange refused over its application's share is counted. */
  sharesExceeded: ShareExceededCounter;

  /** The largest token the exchange answers, in bytes as its `200` body sends them. */
  tokenLimitBytes: number;

  /**
   * Where each exchange's `token.exchange` is written, in the exchange's own transaction, and each
   * refused assertion's `channelAssertion.rejection`, in one of its own: over the exchange pool.
   */
  trail: Pick<AuditTrail<pg.ClientBase>, 'inTransaction'>;
}

/** The token exchange: its route. */
export interface Exchange {
  /** The route serving `POST /exchange`. */
  route: RouteOptions;
}
