import type {
  FastifyError,
  FastifyReply,
  FastifyRequest,
  RouteOptions,
} from 'fastify';

import { rejectionEvent } from '../channelAssertion/index.js';
import type { Actor, AuditEvent } from '../eventLog/index.js';
import { failureCodeOf, failureNameOf } from '../failures/index.js';
import type { Problem } from '../http/index.js';
import type { SignInJudgement } from '../signInTokens/index.js';
import { CommitUnconfirmed } from '../storeTimeout/index.js';
import {
  anonymousCalculation,
  readAudiencePolicy,
} from '../tokenCalculation/index.js';
import { sealUsherToken } from '../usherToken/index.js';
import { anonymousPayload } from './anonymousPayload.js';
import {
  deniedExchangeEvent,
  failedExchangeEvent,
  issuedExchangeEvent,
} from './exchangeEvents.js';
import {
  BODY_LIMIT_BYTES,
  EXCHANGE_PROBLEMS,
  sendExchangeProblem,
  unreadableBody,
} from './exchangeProblems.js';
import { readExchangeRequest } from './readExchangeRequest.js';
import type { Exchange, ExchangeKey, ExchangeSettings } from './types.js';

/** The path bridges exchange credentials at. */
export const EXCHANGE_PATH = '/exchange';

/** The line naming a failure of the store while an exchange was answered. */
export const EXCHANGE_STORE_FAILED = 'exchange.storeFailed';

/** The line naming a failure the controller did not expect, answered `500 internalError`. */
export const EXCHANGE_UNEXPECTED_FAILURE = 'exchange.unexpectedFailure';

const BODY_TOO_LARGE = 'FST_ERR_CTP_BODY_TOO_LARGE';

// The framework's codes for a body it could not read, each answered as the request's fault.
const CONTENT_PARSING = 'FST_ERR_CTP_';

const TOKEN_MEDIA_TYPE = 'application/jwt';

const ANONYMOUS: Actor = Object.freeze({ type: 'anonymous' });

const SYSTEM: Actor = Object.freeze({ type: 'system' });

/** A refusal as the exchange answers it, with the whole seconds to wait where it names them. */
interface Refusal {
  problem: Problem;
  retryAfterSeconds?: number;
}

/** What an exchange answers once its `token.exchange` has committed. */
type Answer =
  { kind: 'issued'; token: string } | (Refusal & { kind: 'refused' });

/** What an exchange's own transaction gave: its answer, or the failure that kept it from committing. */
type Outcome = Answer | { failure: unknown; kind: 'failed' };

/** A credential's refusal, and the `token.exchange` recording it. */
interface CredentialRefusal extends Refusal {
  event: AuditEvent;
}

// The failure by its code alone, where it carries one that is an identifier, since a message may quote
// a value.
const codeOf = (failure: unknown): Readonly<Record<string, string>> => {
  const code = failureCodeOf(failure);
  return code === undefined ? {} : { code };
};

// Until the exchange issues signed-in tokens, a credential the judgement accepts is refused like any
// other, its answer the one every refused credential gets, and recorded as apiKeyVerifierNotConfigured,
// naming no subject: no token bearing an identity exists before identity refusals do. This branch alone
// changes when signed-in tokens are issued, which replace it whole, and its answer may change by ruling
// before then.
const acceptedCredentialRefusal = (sourceIp: string): CredentialRefusal => ({
  event: deniedExchangeEvent({
    reason: 'apiKeyVerifierNotConfigured',
    sourceIp,
  }),
  problem: EXCHANGE_PROBLEMS.credentialRefused,
});

// What a judged credential is answered, and how its exchange is recorded: refused alike and denied
// under its own reason; denied too while its signing key is not confirmed yet, since a made-up key id
// or a routine key rotation produces that and neither is a fault in the controller; or kept from being
// judged by an identity provider that cannot be reached, and failed.
const credentialRefusalOf = (
  judgement: SignInJudgement,
  sourceIp: string,
): CredentialRefusal => {
  if (judgement.kind === 'recorded') {
    const { reason, refusedSubject } = judgement;
    return {
      event: deniedExchangeEvent({
        reason,
        ...(refusedSubject === undefined ? {} : { refusedSubject }),
        sourceIp,
      }),
      problem: EXCHANGE_PROBLEMS.credentialRefused,
    };
  }
  if (judgement.kind === 'keysUnavailable') {
    return {
      event: failedExchangeEvent({
        reason: 'identityProviderUnavailable',
        sourceIp,
      }),
      problem: EXCHANGE_PROBLEMS.identityProviderUnavailable,
    };
  }
  if (judgement.kind === 'signingKeyUnconfirmed') {
    return {
      event: deniedExchangeEvent({ reason: 'signingKeyUnconfirmed', sourceIp }),
      problem: EXCHANGE_PROBLEMS.signingKeyUnconfirmed,
      retryAfterSeconds: judgement.retryAfterSeconds,
    };
  }
  return acceptedCredentialRefusal(sourceIp);
};

/**
 * Creates the token exchange, `POST /exchange`, the one call every bridge makes for an Usher token.
 *
 * Each request's channel assertion is checked first, from memory, so a caller it does not authenticate
 * is given no other work: an assertion that could not be verified, an unknown application's and one
 * whose application holds no live key among them, is counted by reason and named application in the
 * shared tally, and one that verified and is refused anyway is recorded as a
 * `channelAssertion.rejection` naming its application, the answer never waiting on that recording.
 * Each is answered one identical `401 channelAssertionRefused`, and confirms nothing. One assertion
 * serves every exchange within its lifetime. An assertion that verifies confirms the key it verified
 * under, as the confirmations given confirm it, beside the exchange's own work, every answer waiting
 * for that confirmation whatever the body and the credential then earn. Then the body is read, as
 * `readExchangeRequest` reads it: `400 unreadableBody` for one unreadable by its shape,
 * `406 payloadVersionUnserved` for one listing no version served, and `413 bodyTooLarge` past 64 KiB.
 *
 * A body carrying no credential is the anonymous visitor's exchange. In one transaction the audience's
 * policy is read in one statement, so from one snapshot, the anonymous calculation is run, its version
 * 1 payload is sealed under the token subkey of the key the assertion verified under, and its
 * `token.exchange` is recorded as `succeeded`, its actor anonymous. The token is answered `200` as one
 * compact `application/jwt` body once that transaction has committed.
 *
 * A credential is judged for the application the assertion names, through the verifier every route
 * shares, and refused: every credential the judgement refuses is answered one identical
 * `403 credentialRefused` and recorded `denied` under its own reason, naming the token's subject in
 * `refusedSubject` only where the judgement names it; a credential the judgement accepts is answered
 * the same `403` and recorded as `apiKeyVerifierNotConfigured`, naming no subject, until the exchange
 * issues signed-in tokens. Keys that cannot be had are answered `503 identityProviderUnavailable` and
 * recorded `failed` under that code. A signing key not confirmed yet is answered
 * `503 signingKeyUnconfirmed` with its seconds in `Retry-After` and recorded `denied` under that code,
 * since a made-up key id or a routine key rotation produces it and neither is a fault in the
 * controller. Every such event's actor is anonymous.
 *
 * A refused exchange follows the same rule as an issued one: every exchange that reaches the judgement
 * is answered only once its `token.exchange` has committed, in a transaction of its own within the
 * store timeout, so no exchange goes unrecorded while looking answered. One whose transaction the store
 * cannot take is answered `503 storeUnavailable`, its failure written by its code alone, and one whose
 * commit the store did not confirm `503 outcomeUnknown`; neither issues a token, and a refusal is never
 * answered `403` unrecorded. A failure the route did not expect is answered `500 internalError`. Every
 * answer is `no-store`. Its stop settles once every assertion's rejection still being recorded has been.
 *
 * @param settings the assertion verifier and its tally, the credential judge, the key confirmations,
 *   the trail, the log, and the configuration the exchange reads.
 */
export const createExchange = ({
  assertionRejections,
  assertions,
  eventLog,
  judgeCredential,
  keyConfirmations,
  settings,
  trail,
}: ExchangeSettings): Exchange => {
  const admitted = new WeakMap<FastifyRequest, ExchangeKey>();
  const confirming = new WeakMap<FastifyRequest, Promise<void>>();
  const recordings = new Set<Promise<void>>();

  // The refusal is answered from memory, so the store's state never delays it: its rejection is
  // recorded beside the answer, and the exchange's stop waits for the recording.
  const recordRejection = (event: AuditEvent): void => {
    const recording = trail.recordEvent(SYSTEM, event).then(
      () => undefined,
      () => undefined,
    );
    recordings.add(recording);
    void recording.then(() => {
      recordings.delete(recording);
    });
  };

  const admit = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> => {
    const check = await assertions.verify(request.raw.rawHeaders);
    if (check.kind === 'verified') {
      const { key } = check.assertion;
      admitted.set(request, key);
      confirming.set(request, keyConfirmations.confirm(key));
      return undefined;
    }
    if (check.kind === 'unverified') {
      assertionRejections.count(check.reason, check.applicationId);
    } else {
      recordRejection(
        rejectionEvent({
          applicationId: check.applicationId,
          reason: check.reason,
          sourceIp: request.ip,
        }),
      );
    }
    return sendExchangeProblem(
      reply,
      EXCHANGE_PROBLEMS.channelAssertionRefused,
    );
  };

  // The exchange's own transaction as its answer once it commits, or as the failure that kept it from
  // committing, which is answered as the store's refusal.
  const committed = (transaction: Promise<Answer>): Promise<Outcome> =>
    transaction.catch((failure: unknown): Outcome => ({
      failure,
      kind: 'failed',
    }));

  const issueAnonymous = (
    key: ExchangeKey,
    sourceIp: string,
  ): Promise<Answer> =>
    trail.inTransaction(ANONYMOUS, async ({ connection, record }) => {
      const policy = await readAudiencePolicy(
        connection,
        settings.databaseSchema,
        key.applicationId,
      );
      const calculation = anonymousCalculation(policy, settings.baseline);
      const payload = anonymousPayload(calculation, {
        audience: key.applicationId,
        issuedAt: Math.floor(settings.clock.now() / 1000),
        issuer: settings.issuer,
        lifetimeSeconds: settings.tokenLifetimeSeconds,
      });
      const token = await sealUsherToken(payload, key);
      await record(
        issuedExchangeEvent({
          audience: payload.aud,
          generatedAt: payload.generatedAt,
          grantCount: calculation.grantCount,
          rules: calculation.rules,
          sourceIp,
          subject: payload.sub,
          tokenTtl: payload.exp - payload.iat,
        }),
      );
      return { kind: 'issued', token };
    });

  const refuseCredential = async (
    credential: string,
    key: ExchangeKey,
    sourceIp: string,
  ): Promise<Outcome> => {
    const judgement = await judgeCredential(credential, {
      audience: key.applicationId,
      now: settings.clock.now(),
    });
    const { event, ...refusal } = credentialRefusalOf(judgement, sourceIp);
    return committed(
      trail.inTransaction(ANONYMOUS, async ({ record }) => {
        await record(event);
        return { kind: 'refused', ...refusal };
      }),
    );
  };

  // The key's confirmation runs beside the exchange's own work, and every answer waits for it, so a
  // key is confirmed once the first exchange verified with it is answered.
  const confirmationOf = (request: FastifyRequest): Promise<void> =>
    confirming.get(request) ?? Promise.resolve();

  const outcomeOf = async (
    request: FastifyRequest,
    key: ExchangeKey,
  ): Promise<Outcome> => {
    const reading = readExchangeRequest({
      body: request.body instanceof Uint8Array ? request.body : undefined,
      contentType: request.headers['content-type'],
    });
    if (reading.kind === 'refused') {
      return { kind: 'refused', problem: reading.problem };
    }
    return reading.credential === undefined
      ? committed(issueAnonymous(key, request.ip))
      : refuseCredential(reading.credential, key, request.ip);
  };

  // A commit the store did not confirm may have taken effect, and the trail's own line names its event.
  const answer = (reply: FastifyReply, outcome: Outcome): FastifyReply => {
    if (outcome.kind === 'issued') {
      return reply
        .code(200)
        .headers({
          'cache-control': 'no-store',
          'content-type': TOKEN_MEDIA_TYPE,
        })
        .send(outcome.token);
    }
    if (outcome.kind === 'refused') {
      return sendExchangeProblem(
        reply,
        outcome.problem,
        outcome.retryAfterSeconds,
      );
    }
    if (outcome.failure instanceof CommitUnconfirmed) {
      return sendExchangeProblem(reply, EXCHANGE_PROBLEMS.outcomeUnknown);
    }
    eventLog.error(EXCHANGE_STORE_FAILED, {
      ...codeOf(outcome.failure),
      route: EXCHANGE_PATH,
    });
    return sendExchangeProblem(reply, EXCHANGE_PROBLEMS.storeUnavailable);
  };

  const route: RouteOptions = {
    bodyLimit: BODY_LIMIT_BYTES,
    errorHandler: async (error: FastifyError, request, reply) => {
      await confirmationOf(request);
      const code = failureCodeOf(error);
      if (code === BODY_TOO_LARGE) {
        return sendExchangeProblem(reply, EXCHANGE_PROBLEMS.bodyTooLarge);
      }
      if (
        code?.startsWith(CONTENT_PARSING) === true &&
        (error.statusCode ?? 500) < 500
      ) {
        return sendExchangeProblem(reply, unreadableBody('could not be read'));
      }
      eventLog.error(EXCHANGE_UNEXPECTED_FAILURE, {
        error: code ?? failureNameOf(error),
        route: EXCHANGE_PATH,
      });
      return reply.sent
        ? undefined
        : sendExchangeProblem(reply, EXCHANGE_PROBLEMS.internalError);
    },
    exposeHeadRoute: false,
    handler: async (request, reply) => {
      const key = admitted.get(request);
      if (key === undefined) {
        return sendExchangeProblem(reply, EXCHANGE_PROBLEMS.internalError);
      }
      const outcome = await outcomeOf(request, key);
      await confirmationOf(request);
      return answer(reply, outcome);
    },
    method: 'POST',
    onRequest: admit,
    url: EXCHANGE_PATH,
  };

  return {
    route,
    stop: async () => {
      await Promise.all(recordings);
    },
  };
};
