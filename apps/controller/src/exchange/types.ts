import type { KeyObject } from 'node:crypto';

import type { RouteOptions } from 'fastify';
import type pg from 'pg';

import type {
  ChannelAssertionCheck,
  UnverifiedRejectionReason,
} from '../channelAssertion/index.js';
import type { ControllerConfiguration } from '../configuration/index.js';
import type { AuditTrail } from '../eventLog/index.js';
import type {
  SignInJudgement,
  SignInJudgementContext,
} from '../signInTokens/index.js';

/** An application's live key as the exchange answers with it: its application, and its token subkey. */
export interface ExchangeKey {
  applicationId: string;

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
}

/** What the exchange is created from. */
export interface ExchangeSettings {
  /** Where each refusal of an assertion that could not be verified is counted. */
  assertionRejections: RejectionCounter;

  /** Checks each request's channel assertion. */
  assertions: ExchangeAssertionVerifier;

  /** Where the exchange writes its operational lines. */
  eventLog: ExchangeLog;

  /** Judges each credential presented. */
  judgeCredential: CredentialJudge;

  /** The baseline, the clock, the schema, the issuer and the token lifetime. */
  settings: Pick<
    ControllerConfiguration,
    'baseline' | 'clock' | 'databaseSchema' | 'issuer' | 'tokenLifetimeSeconds'
  >;

  /**
   * Where each exchange's `token.exchange` is written, in the exchange's own transaction, and each
   * refusal of an assertion that verified is recorded.
   */
  trail: Pick<AuditTrail<pg.ClientBase>, 'inTransaction' | 'recordEvent'>;
}

/** The token exchange: its route, and what it still has in flight. */
export interface Exchange {
  /** The route serving `POST /exchange`. */
  route: RouteOptions;

  /** Settles once every refused assertion's `channelAssertion.rejection` still being recorded has been. */
  stop(): Promise<void>;
}
