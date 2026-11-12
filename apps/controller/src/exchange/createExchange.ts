import type {
  FastifyError,
  FastifyReply,
  FastifyRequest,
  RouteOptions,
} from 'fastify';

import {
  type Admitted,
  SHARE_EXCEEDED_RETRY_AFTER_SECONDS,
} from '../admission/index.js';
import type { Actor, AuditEvent } from '../eventLog/index.js';
import { failureCodeOf, failureNameOf } from '../failures/index.js';
import type { Problem } from '../http/index.js';
import type { SignInJudgement } from '../signInTokens/index.js';
import { CommitUnconfirmed, type Deadline } from '../storeTimeout/index.js';
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

/** The line naming a request that arrived too late to be answered by its deadline, answered `408 requestTimeout`. */
export const EXCHANGE_REQUEST_TIMEOUT = 'exchange.requestTimeout';

/**
 * The time an exchange keeps back from its deadline for recording a credential's refusal, in
 * milliseconds. The judgement is waited for until the deadline less this, so the refusal's own
 * transaction, which a judgement past its budget still needs, has this long to commit before the
 * deadline.
 */
export const RECORDING_RESERVE_MILLISECONDS = 1000;

/**
 * The least time a judgement is given, in milliseconds. Judging a sign-in token under keys already
 * held takes well under one millisecond, and one fetch of the identity provider's keys from a
 * provider that answers takes a fraction of a second, so a judgement given this long and still not
 * given was kept from being given by the identity provider: only then is the exchange recorded as the
 * provider's failure.
 */
export const MINIMUM_JUDGEMENT_BUDGET_MILLISECONDS = 1000;

/**
 * The least time left to its deadline, in milliseconds, for a request whose body has arrived to be
 * answered as anything but late: the recording reserve and the least judgement budget together. A
 * request with less left is answered `408 requestTimeout`, its lateness the request's own, so nothing
 * it causes is recorded as the identity provider's or the store's failure.
 */
export const LATE_REQUEST_THRESHOLD_MILLISECONDS =
  RECORDING_RESERVE_MILLISECONDS + MINIMUM_JUDGEMENT_BUDGET_MILLISECONDS;

const BODY_TOO_LARGE = 'FST_ERR_CTP_BODY_TOO_LARGE';

// The framework's codes for a body it could not read, each answered as the request's fault.
const CONTENT_PARSING = 'FST_ERR_CTP_';

const TOKEN_MEDIA_TYPE = 'application/jwt';

const ANONYMOUS: Actor = Object.freeze({ type: 'anonymous' });

// A judgement not given within its budget, answered and recorded as keys that cannot be had are.
const KEYS_UNAVAILABLE: SignInJudgement = Object.freeze({
  kind: 'keysUnavailable',
});

/** What the exchange holds for a request whose channel assertion verified: its deadline, and its key. */
interface Verified {
  deadline: Deadline;
  key: ExchangeKey;
}

/** A refusal as the exchange answers it, with the whole seconds to wait where it names them. */
interface Refusal {
  problem: Problem;
  retryAfterSeconds?: number;
}

/** What an exchange answers once its `token.exchange` has committed. */
type Answer =
  { kind: 'issued'; token: string } | (Refusal & { kind: 'refused' });

/**
 * What an exchange's own work gave: its answer, the failure that kept its transaction from committing,
 * or, for a credential with too little of its deadline left to be given the least judgement budget,
 * that the request arrived too late, so nothing was judged or recorded.
 */
type Outcome = Answer | { failure: unknown; kind: 'failed' } | { kind: 'late' };

const LATE: Outcome = Object.freeze({ kind: 'late' });

/** A credential's refusal, and the `token.exchange` recording it. */
interface CredentialRefusal extends Refusal {
  event: AuditEvent;
}

// The answer to an exchange over its application's share while the pool is contended, given before
// any work on the store.
const SHARE_EXCEEDED: Outcome = Object.freeze({
  kind: 'refused',
  problem: EXCHANGE_PROBLEMS.admissionShareExceeded,
  retryAfterSeconds: SHARE_EXCEEDED_RETRY_AFTER_SECONDS,
});

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

// What the work gives within the milliseconds given, or the fallback once they have passed. The work
// is never cancelled, since what it waits on may be shared with other requests still waiting on it, and
// its late result or failure is dropped, so a rejection after the fallback is never left unhandled.
const withinOr = <Value>(
  work: Promise<Value>,
  milliseconds: number,
  fallback: Value,
): Promise<Value> =>
  new Promise<Value>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        resolve(fallback);
      },
      Math.max(0, milliseconds),
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (failure: unknown) => {
        clearTimeout(timer);
        reject(failure);
      },
    );
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
 * Every exchange is answered by its deadline, `deadlineMilliseconds` from the moment its request
 * arrives, read on the monotonic clock given. The bridge's timeout is that deadline plus a margin for
 * the network and for writing the answer, so the controller always answers before the bridge gives up.
 * Each step below that runs out of time is answered as its paragraph says, never past the deadline.
 *
 * Each request's channel assertion is checked first, from memory, so a caller it does not authenticate
 * is given no other work: an assertion that could not be verified, an unknown application's and one
 * whose application holds no live key among them, is counted by reason and named application in the
 * shared tally, and one that verified and is refused anyway is handed to the exchange's own recorder
 * of refused assertions, taken from the instance's, which records the instance's first refusal of each
 * assertion as a `channelAssertion.rejection` naming its application and counts the rest, the answer
 * never waiting on it. Each recording is held to two bounds: the route's limit of recordings waiting
 * on the store, and a place in the share of the application the assertion names, taken through
 * `recordRefusalWithinShare` as a credential's refusal takes one; a refusal past either is counted.
 * Each is answered one identical `401 channelAssertionRefused`, and confirms nothing. One assertion
 * serves every exchange within its lifetime. An assertion that verifies confirms the key it verified
 * under, as the confirmations given confirm it, beside the exchange's own work and bounded by the
 * exchange's deadline, every answer waiting for that confirmation until the deadline at most, whatever
 * the body and the credential then earn. A read straight after the answer therefore shows the key's
 * `confirmedAt` only when the store took the confirmation by the deadline; one it did not take by then
 * changes no answer, is written to the log as a failed confirmation is, and is tried again at the
 * key's next exchange.
 *
 * Then the body is read, as `readExchangeRequest` reads it: `400 unreadableBody` for one unreadable by
 * its shape, `406 payloadVersionUnserved` for one listing no version served, and `413 bodyTooLarge`
 * past 64 KiB. The time the body takes to arrive counts against the deadline, and is not cut short: a
 * request whose body arrives whole with less than the late-request threshold left to its deadline,
 * {@link LATE_REQUEST_THRESHOLD_MILLISECONDS} as the controller passes it, arrived too late to be
 * answered by its deadline. It is answered at once `408 requestTimeout`, with `Connection: close`,
 * judging nothing, recording nothing and writing one line at warning, {@link EXCHANGE_REQUEST_TIMEOUT},
 * naming the route alone, so a request's own lateness is never recorded as the identity provider's or
 * the store's failure.
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
 * controller. Every such event's actor is anonymous. The judgement is waited for until the deadline
 * less {@link RECORDING_RESERVE_MILLISECONDS}, which is kept for recording the refusal, a budget of at
 * least {@link MINIMUM_JUDGEMENT_BUDGET_MILLISECONDS} for any request not answered as late; a judgement
 * not given by then is answered and recorded exactly as keys that cannot be had are. It is never cancelled,
 * since the fetch of the identity provider's keys it may wait on is shared with other requests, and
 * its late result is dropped.
 *
 * Each exchange's store work, the anonymous calculation or a credential's refusal whatever the
 * judgement, `signingKeyUnconfirmed` included, runs within its application's share of the exchange
 * pool as `admission` admits it: its place is taken once every check needing no store has passed, the
 * assertion, the body and the credential's judgement, and released once that work has ended, however
 * it ended. An exchange within its share is always admitted; past it, one is admitted while the
 * instance's exchanges in flight number fewer than the pool's connections, and one anonymous exchange
 * per application past that. Any other is answered `503 admissionShareExceeded` with `Retry-After` at
 * once, nothing begun on the store and nothing recorded, and is counted for its application. A refusal
 * of the assertion or of the body, and a request answered as late, take no place.
 *
 * A refused exchange follows the same rule as an issued one: every exchange admitted into its share
 * is answered only once its `token.exchange` has committed, in a transaction of its own within the
 * store timeout and the deadline, so no exchange goes unrecorded while looking answered. One whose
 * transaction the store cannot take is answered `503 storeUnavailable`, its failure written by its
 * code alone, and one whose commit the store did not confirm `503 outcomeUnknown`; neither issues a
 * token, and a refusal is never answered `403` unrecorded. Bounded by the deadline, that transaction's
 * work runs for the store timeout or the time left to the deadline, whichever is shorter, and is
 * answered `503 storeUnavailable` with nothing recorded once that has passed; it sends no `COMMIT`
 * with too little left to the deadline for an answer, and is answered the same; and a `COMMIT` not
 * answered within the store timeout or the time left to the deadline, whichever is shorter, is
 * answered `503 outcomeUnknown`, the trail's own line naming its event. A failure the route did not
 * expect is answered `500 internalError`. Every answer is `no-store`.
 *
 * @param settings the admission and where its refusals are counted, the assertion verifier, its tally,
 *   the instance's recording of refused assertions and the exchange's limit of them, the deadline and
 *   the monotonic clock it is read on, the credential judge, the key confirmations, the trail, the log,
 *   and the configuration the exchange reads.
 */
export const createExchange = ({
  admission,
  assertionRecordingLimit,
  assertionRefusals,
  assertionRejections,
  assertions,
  deadlineMilliseconds,
  eventLog,
  judgeCredential,
  keyConfirmations,
  lateRequestThresholdMilliseconds,
  monotonicNow,
  settings,
  sharesExceeded,
  trail,
}: ExchangeSettings): Exchange => {
  const admitted = new WeakMap<FastifyRequest, Verified>();
  const confirming = new WeakMap<FastifyRequest, Promise<void>>();

  // A refusal's record is store work like any other, so it takes a place in its application's share:
  // recorded outside it, a flood of refusals through one application's bridge would hold the pool's
  // connections outside every share, and the shares would no longer keep the other applications
  // served. A credential's refusal and a refused assertion's rejection both go through here.
  const recordRefusalWithinShare = <Result>(
    applicationId: string,
    record: () => Promise<Result>,
  ): Promise<Admitted<Result>> =>
    admission.within(applicationId, 'credential', record);

  // The route's recorder of refused assertions, holding at most its limit of recordings waiting on the
  // store and each within the share of the application the assertion names.
  const assertionRecorder = assertionRefusals.forRoute({
    pendingLimit: assertionRecordingLimit,
    trail,
    within: async (applicationId, recording) =>
      (await recordRefusalWithinShare(applicationId, recording)).kind ===
      'admitted',
  });

  // An exchange admitted is answered by its own work; one refused is counted for its application and
  // answered at once.
  const outcomeWithin = (
    applicationId: string,
    work: Admitted<Outcome>,
  ): Outcome => {
    if (work.kind === 'admitted') {
      return work.result;
    }
    sharesExceeded.count(applicationId);
    return SHARE_EXCEEDED;
  };

  // A request's deadline, fixed when it arrives.
  const deadlineFromNow = (): Deadline => {
    const dueAt = monotonicNow() + deadlineMilliseconds;
    return { remainingMilliseconds: () => dueAt - monotonicNow() };
  };

  const admit = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> => {
    const deadline = deadlineFromNow();
    const check = await assertions.verify(request.raw.rawHeaders);
    if (check.kind === 'verified') {
      const { key } = check.assertion;
      admitted.set(request, { deadline, key });
      confirming.set(request, keyConfirmations.confirm(key, deadline));
      return undefined;
    }
    // The refusal is answered from memory, so the store's state never delays it.
    if (check.kind === 'unverified') {
      assertionRejections.count(check.reason, check.applicationId);
    } else {
      assertionRecorder.refused({
        applicationId: check.applicationId,
        reason: check.reason,
        signingInputDigest: check.signingInputDigest,
        sourceIp: request.ip,
      });
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
    { deadline, key }: Verified,
    sourceIp: string,
  ): Promise<Answer> =>
    trail.inTransaction(
      ANONYMOUS,
      async ({ connection, record }) => {
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
      },
      { deadline },
    );

  // The credential's judgement, waited for through its budget, the deadline less the recording
  // reserve, so its refusal can still be recorded in time, and taken past that as keys that cannot be
  // had: a budget of at least the least judgement budget, so only a judge that overran a real budget
  // names the identity provider.
  const judgedWithin = (
    credential: string,
    { key }: Verified,
    budgetMilliseconds: number,
  ): Promise<SignInJudgement> =>
    withinOr(
      judgeCredential(credential, {
        audience: key.applicationId,
        now: settings.clock.now(),
      }),
      budgetMilliseconds,
      KEYS_UNAVAILABLE,
    );

  // A credential with too little of its deadline left for the least judgement budget arrived too late:
  // it is answered as late, judging and recording nothing, whatever threshold the handler was given.
  // Every judgement's refusal is recorded within the application's share.
  const refuseCredential = async (
    credential: string,
    verified: Verified,
    sourceIp: string,
  ): Promise<Outcome> => {
    const budgetMilliseconds =
      verified.deadline.remainingMilliseconds() -
      RECORDING_RESERVE_MILLISECONDS;
    if (budgetMilliseconds < MINIMUM_JUDGEMENT_BUDGET_MILLISECONDS) {
      return LATE;
    }
    const judgement = await judgedWithin(
      credential,
      verified,
      budgetMilliseconds,
    );
    const { event, ...refusal } = credentialRefusalOf(judgement, sourceIp);
    const { applicationId } = verified.key;
    return outcomeWithin(
      applicationId,
      await recordRefusalWithinShare(applicationId, () =>
        committed(
          trail.inTransaction(
            ANONYMOUS,
            async ({ record }) => {
              await record(event);
              return { kind: 'refused', ...refusal };
            },
            { deadline: verified.deadline },
          ),
        ),
      ),
    );
  };

  // The anonymous exchange's calculation, within its application's share as an anonymous exchange,
  // so the anonymous lane serves it past a full share.
  const issueWithinShare = async (
    verified: Verified,
    sourceIp: string,
  ): Promise<Outcome> => {
    const { applicationId } = verified.key;
    return outcomeWithin(
      applicationId,
      await admission.within(applicationId, 'anonymous', () =>
        committed(issueAnonymous(verified, sourceIp)),
      ),
    );
  };

  // The key's confirmation runs beside the exchange's own work, and every answer waits for it until the
  // deadline at most, so a key is confirmed once the first exchange verified with it is answered
  // whenever the store takes the confirmation by then.
  const confirmationOf = (request: FastifyRequest): Promise<void> => {
    const confirmation = confirming.get(request);
    const verified = admitted.get(request);
    return confirmation === undefined || verified === undefined
      ? Promise.resolve()
      : withinOr(
          confirmation,
          verified.deadline.remainingMilliseconds(),
          undefined,
        );
  };

  const outcomeOf = async (
    request: FastifyRequest,
    verified: Verified,
  ): Promise<Outcome> => {
    const reading = readExchangeRequest({
      body: request.body instanceof Uint8Array ? request.body : undefined,
      contentType: request.headers['content-type'],
    });
    if (reading.kind === 'refused') {
      return { kind: 'refused', problem: reading.problem };
    }
    return reading.credential === undefined
      ? issueWithinShare(verified, request.ip)
      : refuseCredential(reading.credential, verified, request.ip);
  };

  // A commit the store did not confirm may have taken effect, and the trail's own line names its event.
  const answer = (reply: FastifyReply, outcome: Outcome): FastifyReply => {
    if (outcome.kind === 'late') {
      return answerRequestTimeout(reply);
    }
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

  // A request whose body arrived with too little of its deadline left is answered at once as late, and
  // its connection closed, so a client that slow holds no connection open for another request, and its
  // lateness is never taken for the identity provider's or the store's failure.
  const answerRequestTimeout = (reply: FastifyReply): FastifyReply => {
    eventLog.warning(EXCHANGE_REQUEST_TIMEOUT, { route: EXCHANGE_PATH });
    return sendExchangeProblem(
      reply.header('connection', 'close'),
      EXCHANGE_PROBLEMS.requestTimeout,
    );
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
      const verified = admitted.get(request);
      if (verified === undefined) {
        return sendExchangeProblem(reply, EXCHANGE_PROBLEMS.internalError);
      }
      if (
        verified.deadline.remainingMilliseconds() <
        lateRequestThresholdMilliseconds
      ) {
        return answerRequestTimeout(reply);
      }
      const outcome = await outcomeOf(request, verified);
      await confirmationOf(request);
      return answer(reply, outcome);
    },
    method: 'POST',
    onRequest: admit,
    url: EXCHANGE_PATH,
  };

  return { route };
};
