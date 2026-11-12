import type { KeyObject } from 'node:crypto';

import type { RouteOptions } from 'fastify';
import type pg from 'pg';

import type {
  ChannelAssertionCheck,
  RefusalRecorder,
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
 * Judges a credential presented at the exchange for the calling application at an instant, as
 * `judgeSignInCredential` judges it through the verifier every route shares.
 *
 * @param credential the credential, as the request carried it.
 * @param context the calling application's id, and the instant.
 */
export type CredentialJudge = (
  credential: string,
  context: Omit<SignInJudgementContext, 'verifier'>,
) => Promise<SignInJudgement>;

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
  /**
   * Takes each refusal of an assertion that verified, recording the instance's first refusal of each
   * assertion and counting the rest, never holding up the answer.
   */
  assertionRefusals: RefusalRecorder;

  /** Where each refusal of an assertion that could not be verified is counted. */
  assertionRejections: RejectionCounter;

  /** Checks each request's channel assertion. */
  assertions: ExchangeAssertionVerifier;

  /**
   * The exchange's deadline, in milliseconds: when the controller must have answered an exchange,
   * measured from the request's arrival. Shorter than the bridge's timeout, how long the bridge waits
   * for the answer, by the margin left for the network and for writing the answer, so the controller
   * always answers before the bridge gives up; the controller passes the value of
   * `CONTROLLER_EXCHANGE_DEADLINE_MILLISECONDS` from `@overture-stack/usher-types`.
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
   * served rather than answered `408 requestTimeout` as late: the controller passes
   * `LATE_REQUEST_THRESHOLD_MILLISECONDS`, the recording reserve and the least judgement budget.
   */
  lateRequestThresholdMilliseconds: number;

  /**
   * The monotonic clock every reading of a deadline is made on, in milliseconds, such as
   * `performance.now`: never the configured clock, which a test may hold still or move by hand.
   */
  monotonicNow(): number;

  /** The baseline, the clock, the schema, the issuer and the token lifetime. */
  settings: Pick<
    ControllerConfiguration,
    'baseline' | 'clock' | 'databaseSchema' | 'issuer' | 'tokenLifetimeSeconds'
  >;

  /** Where each exchange's `token.exchange` is written, in the exchange's own transaction. */
  trail: Pick<AuditTrail<pg.ClientBase>, 'inTransaction'>;
}

/** The token exchange: its route. */
export interface Exchange {
  /** The route serving `POST /exchange`. */
  route: RouteOptions;
}
