import type {
  FastifyError,
  FastifyReply,
  FastifyRequest,
  RouteOptions,
} from 'fastify';
import type pg from 'pg';

import {
  type Admitted,
  SHARE_EXCEEDED_RETRY_AFTER_SECONDS,
} from '../admission/index.js';
import type { Actor, AuditEvent, AuditTransaction } from '../eventLog/index.js';
import { failureCodeOf, failureNameOf } from '../failures/index.js';
import { findOrRecordPerson } from '../findOrRecordPerson.js';
import type { Problem } from '../http/index.js';
import { tokenDigestOf } from '../refusalWindows/index.js';
import {
  isServiceAccount,
  readStoredRefusal,
  type SignInJudgement,
  type StoredRefusal,
} from '../signInTokens/index.js';
import { CommitUnconfirmed, type Deadline } from '../storeTimeout/index.js';
import {
  anonymousCalculation,
  readAudiencePolicy,
  readPrincipalPolicy,
  signedInCalculation,
} from '../tokenCalculation/index.js';
import { sealUsherToken, type VersionOnePayload } from '../usherToken/index.js';
import { anonymousPayload } from './anonymousPayload.js';
import {
  deniedExchangeEvent,
  type ExchangeDenial,
  failedExchangeEvent,
  issuedExchangeEvent,
  overLimitExchangeEvent,
} from './exchangeEvents.js';
import {
  BODY_LIMIT_BYTES,
  EXCHANGE_PROBLEMS,
  sendExchangeProblem,
  unreadableBody,
} from './exchangeProblems.js';
import { readExchangeRequest } from './readExchangeRequest.js';
import { recordExchangedSession } from './recordExchangedSession.js';
import { signedInPayload } from './signedInPayload.js';
import type { Exchange, ExchangeKey, ExchangeSettings } from './types.js';

/** The path Bridges exchange credentials at. */
export const EXCHANGE_PATH = '/exchange';

/** The line naming a failure of the store while an exchange was answered. */
export const EXCHANGE_STORE_FAILED = 'exchange.storeFailed';

/** The line naming an exchange whose token would pass the token limit, answered `503 tokenOverResponseCap`. */
export const EXCHANGE_TOKEN_OVER_RESPONSE_CAP = 'exchange.tokenOverResponseCap';

/** The line naming a failure the Controller did not expect, answered `500 internalError`. */
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

/**
 * A credential's refusal, and the `token.exchange` recording it; for a refusal recorded `denied`, its
 * reason, and whether the token's signature verified, which decides the window it is counted in.
 */
interface CredentialRefusal extends Refusal {
  denial?: { reason: ExchangeDenial; tokenVerified: boolean };
  event: AuditEvent;
  kind: 'refused';
}

/** What an exchange's store work found for a principal the store refuses, recording nothing. */
interface StandingRefusal {
  kind: 'standingRefused';
  standing: StoredRefusal;
  subject: string;
}

/** What recording a refusal opening a window gave: its answer and its event's id, or the failure that kept it from committing. */
type Opening =
  | { answer: Answer; eventId: string; kind: 'recorded' }
  | { failure: unknown; kind: 'failed' };

/** A sign-in token the judgement accepted. */
type AcceptedJudgement = Extract<SignInJudgement, { kind: 'accepted' }>;

/**
 * A sign-in token the judgement accepted and nothing refused before the store is read: the principal
 * it acts for, and the instant its Usher token is issued at, in whole seconds since the Unix epoch.
 */
interface Issuable {
  issuedAt: number;
  kind: 'issuable';
  principal: AcceptedJudgement;
}

/** What judging a credential earns before the store is read: a refusal, or a token to issue. */
type JudgedCredential = CredentialRefusal | Issuable;

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

// What an exchange's transaction records in its work's place when that work fails: the exchange
// failed as storeUnavailable, its actor anonymous whoever the transaction acts for.
const storeFailureOf = (sourceIp: string): AuditEvent => ({
  actor: ANONYMOUS,
  ...failedExchangeEvent({ reason: 'storeUnavailable', sourceIp }),
});

// The bytes a token takes as the `200` body sends it: its compact form, as UTF-8.
const bodyBytesOf = (token: string): number => Buffer.byteLength(token, 'utf8');

// A refusal answered the one 403 every refused credential gets, recorded denied under its reason.
const credentialRefused = (
  event: AuditEvent,
  denial: NonNullable<CredentialRefusal['denial']>,
): CredentialRefusal => ({
  denial,
  event,
  kind: 'refused',
  problem: EXCHANGE_PROBLEMS.credentialRefused,
});

// The id a refusal opening a window committed its event under, when it was admitted and committed.
const openedIdOf = (opening: Admitted<Opening>): string | undefined =>
  opening.kind === 'admitted' && opening.result.kind === 'recorded'
    ? opening.result.eventId
    : undefined;

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

// A sign-in token the judgement accepted is refused still, before the store is read, when any one of a
// service account's marks is on it, or when it expires at or before the second its Usher token would be
// issued in, so that token would live no time; each refusal names the verified subject.
const acceptedCredentialOf = (
  principal: AcceptedJudgement,
  {
    issuedAt,
    serviceAccountRole,
  }: { issuedAt: number; serviceAccountRole: string },
  sourceIp: string,
): JudgedCredential => {
  const { claims, expiresAt, subject } = principal;
  if (isServiceAccount(claims, serviceAccountRole)) {
    return credentialRefused(
      deniedExchangeEvent({
        reason: 'serviceAccountNotPermitted',
        refusedSubject: subject,
        sourceIp,
      }),
      { reason: 'serviceAccountNotPermitted', tokenVerified: true },
    );
  }
  return expiresAt > issuedAt
    ? { issuedAt, kind: 'issuable', principal }
    : credentialRefused(
        deniedExchangeEvent({
          reason: 'expiredToken',
          refusedSubject: subject,
          sourceIp,
        }),
        { reason: 'expiredToken', tokenVerified: true },
      );
};

// What a judged credential is answered, and how its exchange is recorded: refused alike and denied
// under its own reason; denied too while its signing key is not confirmed yet, since a made-up key id
// or a routine key rotation produces that and neither is a fault in the Controller; kept from being
// judged by an identity provider that cannot be reached, and failed; or, accepted, issued for unless
// refused before the store is read.
const judgedCredentialOf = (
  judgement: SignInJudgement,
  issuing: { issuedAt: number; serviceAccountRole: string },
  { applicationId, sourceIp }: { applicationId: string; sourceIp: string },
): JudgedCredential => {
  // The judgement names a refused token's subject only once its signature verified; the refusal of
  // any other credential names the application instead, as its window is that application's.
  if (judgement.kind === 'recorded') {
    const { reason, refusedSubject } = judgement;
    return credentialRefused(
      deniedExchangeEvent({
        ...(refusedSubject === undefined
          ? { applicationId }
          : { refusedSubject }),
        reason,
        sourceIp,
      }),
      { reason, tokenVerified: refusedSubject !== undefined },
    );
  }
  if (judgement.kind === 'keysUnavailable') {
    return {
      event: failedExchangeEvent({
        reason: 'identityProviderUnavailable',
        sourceIp,
      }),
      kind: 'refused',
      problem: EXCHANGE_PROBLEMS.identityProviderUnavailable,
    };
  }
  if (judgement.kind === 'signingKeyUnconfirmed') {
    return {
      denial: { reason: 'signingKeyUnconfirmed', tokenVerified: false },
      event: deniedExchangeEvent({
        applicationId,
        reason: 'signingKeyUnconfirmed',
        sourceIp,
      }),
      kind: 'refused',
      problem: EXCHANGE_PROBLEMS.signingKeyUnconfirmed,
      retryAfterSeconds: judgement.retryAfterSeconds,
    };
  }
  return acceptedCredentialOf(judgement, issuing, sourceIp);
};

/**
 * Creates the token exchange, `POST /exchange`, answering the application a channel assertion names
 * an Usher token: the anonymous visitor's, or a signed-in principal's.
 *
 * Every exchange is answered by its deadline, `deadlineMilliseconds` from the moment its request
 * arrives, read on the monotonic clock given. The deadline must stay shorter than the time its callers
 * wait for an answer, by a margin for the network and for writing the answer, so every answer reaches
 * them before they give up. Each step below that runs out of time is answered as its paragraph says,
 * never past the deadline.
 *
 * Each request's channel assertion is checked first, from memory, so a caller it does not authenticate
 * is given no other work: an assertion that could not be verified, an unknown application's and one
 * whose application holds no live key among them, is counted by reason and named application in the
 * shared tally, and one that verified and is refused anyway is handed to the exchange's own recorder
 * of refused assertions, taken from the instance's, the answer never waiting on it. That recorder is
 * given two bounds, and must count a refusal past either rather than record it: the route's limit of
 * recordings waiting on the store, and a place in the share of the application the assertion names,
 * taken through `recordRefusalWithinShare` as a credential's refusal takes one. Each refused
 * assertion is answered one identical `401 channelAssertionRefused`, and confirms nothing. The key an
 * assertion verifies under is handed to the key confirmations given, beside the exchange's own work
 * and bounded by the exchange's deadline, and every answer waits for that confirmation until the
 * deadline at most, whatever the body and the credential then earn; a confirmation not settled by the
 * deadline changes no answer.
 *
 * Then the body is read: one unreadable by its shape is answered `400 unreadableBody`, one listing no
 * version served `406 payloadVersionUnserved`, and one past 64 KiB `413 bodyTooLarge`. The time the
 * body takes to arrive counts against the deadline, and is not cut short: a request whose body arrives
 * whole with less than the late-request threshold given left to its deadline arrived too late to be
 * answered by it. It is answered at once `408 requestTimeout`, with `Connection: close`, judging
 * nothing, recording nothing and writing one line at warning, {@link EXCHANGE_REQUEST_TIMEOUT}, naming
 * the route alone, so a request's own lateness is never recorded as the identity provider's or the
 * store's failure.
 *
 * A body carrying no credential is the anonymous visitor's exchange. In one transaction the audience's
 * policy is read from one snapshot, the anonymous calculation is run, its version 1 payload is sealed
 * under the token subkey of the key the assertion verified under, and its `token.exchange` is recorded
 * as `succeeded`, its actor anonymous. The token is answered `200` as one compact `application/jwt`
 * body once that transaction has committed.
 *
 * A credential is judged by the judge given, for the application the assertion names, at the
 * configured clock's instant. Every credential the judgement refuses is answered one identical
 * `403 credentialRefused` and recorded `denied` under its own reason, naming the token's subject in
 * `refusedSubject` only where the judgement names it, and naming the application the assertion
 * names as `applicationId` where it does not. Keys that cannot be had are answered
 * `503 identityProviderUnavailable` and recorded `failed` under that code. A signing key not confirmed
 * yet is answered `503 signingKeyUnconfirmed` with its seconds in `Retry-After` and recorded
 * `denied` under that code, naming the application, since a made-up key id or a routine key
 * rotation produces it and neither is a fault in the Controller. The judgement is waited for until
 * the deadline less {@link RECORDING_RESERVE_MILLISECONDS}, which is kept for recording its
 * outcome, a budget of at least {@link MINIMUM_JUDGEMENT_BUDGET_MILLISECONDS} for any request not
 * answered as late; a judgement not given by then is answered and recorded exactly as keys that
 * cannot be had are. It is never cancelled, since what it waits on may be shared with other
 * requests, and its late result is dropped.
 *
 * A sign-in token the judgement accepts is still refused with the same `403`, before any work on the
 * store, so its principal is never met as a person: as `serviceAccountNotPermitted` when
 * {@link isServiceAccount} marks it as a service account's under the configured service-account role,
 * and as `expiredToken` when its `exp` is at or before the second its Usher token would be issued in,
 * so no Usher token living no time is issued. Each is recorded `denied`, naming the verified subject
 * in `refusedSubject`. Every event recording a credential's refusal names its actor anonymous.
 *
 * Any other sign-in token the judgement accepts is issued for, in one transaction declaring its
 * principal the actor, a person named by the identity provider's `sub`. Their standing is read first,
 * under the identity provider's issuer: a principal the store refuses, revoked, issued for before a
 * revocation of the whole platform, or signed out, is answered the same `403` and denied under that
 * reason, naming the subject in `refusedSubject`, its actor anonymous, that transaction writing
 * nothing. A principal in good standing is met, a person recorded on first meeting them; the
 * audience's policy and the recorded grants reaching that person are read from one snapshot, and the
 * signed-in calculation is run at the second the token is issued in; the version 1 payload, naming
 * the identity provider's subject in `sub` and expiring a token lifetime after it is issued, with the
 * sign-in token, or with the earliest grant it drew on, whichever is soonest, is sealed as the
 * anonymous one is; and the session the sign-in token names, if it names one, is recorded with that
 * token's `exp`. Its `token.exchange` is recorded as `succeeded`, naming the subject as `userId` and
 * counting the grants drawn on as `grantCount`, and the token is answered `200` as the anonymous one
 * is, once that transaction has committed.
 *
 * Every token sealed, anonymous or signed in, is measured before anything more is written, as the
 * bytes its `200` body would send, its compact form as UTF-8, against the token limit given: a token of
 * exactly the limit is answered, and a larger one is not. Such an exchange is answered
 * `503 tokenOverResponseCap`, with no token and no `Retry-After`, and its `token.exchange` is recorded
 * `failed` at `error` in its issuance's place, its actor the exchange's, naming the resources its
 * payload holds an entry for as `heldResourceCount`, the token's size as `tokenBytes` and its subject
 * as `userId`, and no resource, grant count or rule; one line at error,
 * {@link EXCHANGE_TOKEN_OVER_RESPONSE_CAP}, names the route alone. No session is recorded for it, and a
 * person met for the first time is kept, committed with that event.
 *
 * Every refusal recorded `denied` is counted in the windows given: a token whose signature verified
 * under its digest and its reason, and any other credential under the application whose assertion
 * verified and its reason, never under anything read from it. A refusal opening a window records its
 * `token.exchange` `denied`, in a transaction of its own taking a place in its application's share,
 * or in the share already held by the exchange for a principal refused by the store, and is
 * answered once that event has committed. A refusal counted in an open window is answered at once,
 * as that refusal is answered, writing nothing and taking no place. A refusal recorded `failed` is
 * recorded for each exchange.
 *
 * Each exchange's store work runs within its application's share of the exchange pool, through the
 * admission given: the anonymous exchange's in the anonymous lane, and every credential's, issued for
 * or refused whatever the judgement, `signingKeyUnconfirmed` included, in the credential lane. Its
 * place is taken once every check needing no store has passed, the assertion, the body and the
 * credential's judgement, and released once that work has ended, however it ended. An exchange the
 * admission does not admit is answered `503 admissionShareExceeded` with `Retry-After` at once,
 * nothing begun on the store and nothing recorded, and is counted for its application. A refusal of
 * the assertion or of the body, and a request answered as late, take no place.
 *
 * A refused exchange opening a window, or recorded `failed`, follows the same rule as an issued
 * one: every exchange admitted into its share is answered only once its `token.exchange` has
 * committed, in a transaction of its own, so no exchange goes unrecorded while looking answered.
 * That transaction is given the deadline, and must not run past it or past the store timeout. It is
 * also given the event recording the exchange as `failed` at `error`, as `storeUnavailable`, its
 * actor anonymous, which must take the place of every event the work recorded, keeping nothing the
 * work wrote, when that work fails; the transaction must then fail with the work's failure whatever
 * becomes of that event's `COMMIT`, so such an exchange is answered `503 storeUnavailable`, its
 * failure written by its code alone. One whose transaction the store cannot take, or does not take
 * in time, is answered `503 storeUnavailable` the same way, and one whose commit the store did not
 * confirm in time `503 outcomeUnknown`; none issues a token, and a refusal is answered `403`
 * unrecorded only when counted in an open window. A failure the route did not expect is answered
 * `500 internalError`. Every answer is `no-store`.
 *
 * @param settings the admission and where its refusals are counted, the assertion verifier, its tally,
 *   the instance's recording of refused assertions and the exchange's limit of them, the deadline and
 *   the monotonic clock it is read on, the credential judge, the key confirmations, the windows
 *   counting refused credentials, the token limit, the trail, the log, and the configuration the
 *   exchange reads.
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
  refusals,
  settings,
  sharesExceeded,
  tokenLimitBytes,
  trail,
}: ExchangeSettings): Exchange => {
  const admitted = new WeakMap<FastifyRequest, Verified>();
  const confirming = new WeakMap<FastifyRequest, Promise<void>>();

  // A refusal's record is store work like any other, so it takes a place in its application's share:
  // recorded outside it, a flood of refusals through one application's Bridge would hold the pool's
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

  // The answer for a token past the token limit: a line naming the route alone, the exchange recorded
  // failed in place of its issuance, and a refusal carrying no Retry-After.
  const overLimitAnswer = async (
    record: AuditTransaction<pg.ClientBase>['record'],
    payload: VersionOnePayload,
    tokenBytes: number,
    sourceIp: string,
  ): Promise<Answer> => {
    eventLog.error(EXCHANGE_TOKEN_OVER_RESPONSE_CAP, { route: EXCHANGE_PATH });
    await record(
      overLimitExchangeEvent({
        heldResourceCount: Object.keys(payload.permissions).length,
        sourceIp,
        subject: payload.sub,
        tokenBytes,
      }),
    );
    return { kind: 'refused', problem: EXCHANGE_PROBLEMS.tokenOverResponseCap };
  };

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
        const tokenBytes = bodyBytesOf(token);
        if (tokenBytes <= tokenLimitBytes) {
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
        }
        return overLimitAnswer(record, payload, tokenBytes, sourceIp);
      },
      { deadline, failureEvent: storeFailureOf(sourceIp) },
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

  // A credential's refusal, recorded in a transaction of its own, its actor anonymous.
  const recordRefusal = (
    { event, ...refusal }: CredentialRefusal,
    { deadline }: Verified,
    sourceIp: string,
  ): Promise<Answer> =>
    trail.inTransaction(
      ANONYMOUS,
      async ({ record }) => {
        await record(event);
        return refusal;
      },
      { deadline, failureEvent: storeFailureOf(sourceIp) },
    );

  // A refusal opening a window, recorded in a transaction of its own, its actor anonymous, with the
  // id its event committed under.
  const recordOpening = (
    { event, ...refusal }: CredentialRefusal,
    { deadline }: Verified,
    sourceIp: string,
  ): Promise<Opening> =>
    trail
      .inTransaction(
        ANONYMOUS,
        async ({ record }) => {
          const eventId = await record(event);
          const answer: Answer = {
            kind: 'refused',
            problem: refusal.problem,
            ...(refusal.retryAfterSeconds === undefined
              ? {}
              : { retryAfterSeconds: refusal.retryAfterSeconds }),
          };
          return { answer, eventId, kind: 'recorded' as const };
        },
        { deadline, failureEvent: storeFailureOf(sourceIp) },
      )
      .catch((failure: unknown): Opening => ({ failure, kind: 'failed' }));

  // A denied credential's window: a verified token's by its digest and the reason, any other's by the
  // application whose assertion verified and the reason, never by anything read from the credential.
  const windowOf = (
    { reason, tokenVerified }: NonNullable<CredentialRefusal['denial']>,
    credential: string,
    applicationId: string,
  ) =>
    tokenVerified
      ? {
          reason,
          route: 'exchange' as const,
          tokenDigest: tokenDigestOf(credential),
        }
      : { applicationId, reason, route: 'exchange' as const };

  // A refusal counted in its window. One opening a window is recorded within its application's share,
  // or through the share already taken, and answered once its event has committed; one counted in an
  // open window is answered at once, writing nothing and taking no place.
  const refuseInWindow = async (
    refusal: CredentialRefusal & {
      denial: NonNullable<CredentialRefusal['denial']>;
    },
    { credential, verified }: { credential: string; verified: Verified },
    { sourceIp, withinShare }: { sourceIp: string; withinShare: boolean },
  ): Promise<Outcome> => {
    const { applicationId } = verified.key;
    const record = (): Promise<Opening> =>
      recordOpening(refusal, verified, sourceIp);
    const windowed = await refusals.refuse(
      windowOf(refusal.denial, credential, applicationId),
      async (): Promise<Admitted<Opening>> =>
        withinShare
          ? { kind: 'admitted', result: await record() }
          : recordRefusalWithinShare(applicationId, record),
      openedIdOf,
    );
    if (windowed.kind === 'counted') {
      return {
        kind: 'refused',
        problem: refusal.problem,
        ...(refusal.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: refusal.retryAfterSeconds }),
      };
    }
    const opening = windowed.opening;
    if (opening.kind === 'overShare') {
      return outcomeWithin(applicationId, opening);
    }
    return opening.result.kind === 'recorded'
      ? opening.result.answer
      : { failure: opening.result.failure, kind: 'failed' };
  };

  // A principal in good standing is met, a person recorded the first time, before anything else is
  // written, so whatever the transaction records points at them. Their token is sealed and measured
  // before the session their sign-in token carries, if any, is recorded with that token's expiry, so
  // a token past the token limit records no session.
  const issueToPrincipal = async (
    { connection, record }: AuditTransaction<pg.ClientBase>,
    { key }: Verified,
    { issuedAt, principal: { expiresAt, session, subject } }: Issuable,
    sourceIp: string,
  ): Promise<Answer> => {
    const { databaseSchema, identityProviderIssuer } = settings;
    const person = await findOrRecordPerson(
      connection,
      databaseSchema,
      { issuer: identityProviderIssuer, subject },
      new Date(settings.clock.now()),
    );
    const policy = await readPrincipalPolicy(
      connection,
      databaseSchema,
      key.applicationId,
      person,
    );
    const calculation = signedInCalculation(policy, {
      baseline: settings.baseline,
      issuedAt,
      signedInRule: settings.signedInRule,
    });
    const payload = signedInPayload(calculation, {
      audience: key.applicationId,
      issuedAt,
      issuer: settings.issuer,
      lifetimeSeconds: settings.tokenLifetimeSeconds,
      signInExpiresAt: expiresAt,
      subject,
    });
    const token = await sealUsherToken(payload, key);
    const tokenBytes = bodyBytesOf(token);
    if (tokenBytes <= tokenLimitBytes) {
      const { sid } = session;
      if (sid !== undefined) {
        await recordExchangedSession(connection, databaseSchema, {
          expiresAt,
          issuer: identityProviderIssuer,
          sid,
          subject,
        });
      }
      await record(
        issuedExchangeEvent({
          audience: payload.aud,
          generatedAt: payload.generatedAt,
          grantCount: calculation.grantCount,
          rules: calculation.rules,
          sourceIp,
          subject,
          tokenTtl: payload.exp - payload.iat,
        }),
      );
      return { kind: 'issued', token };
    }
    return overLimitAnswer(record, payload, tokenBytes, sourceIp);
  };

  // A signed-in principal's exchange, in one transaction declaring them its actor, their standing read
  // first: a principal the store refuses is given back with nothing written, for its refusal to be
  // counted in its window.
  const issueSignedIn = (
    verified: Verified,
    issuable: Issuable,
    sourceIp: string,
  ): Promise<Answer | StandingRefusal> => {
    const { session, subject } = issuable.principal;
    return trail.inTransaction(
      { id: subject, type: 'human' },
      async (transaction): Promise<Answer | StandingRefusal> => {
        const standing = await readStoredRefusal(
          transaction.connection,
          settings.databaseSchema,
          { issuer: settings.identityProviderIssuer, session, subject },
        );
        return standing === undefined
          ? issueToPrincipal(transaction, verified, issuable, sourceIp)
          : { kind: 'standingRefused', standing, subject };
      },
      { deadline: verified.deadline, failureEvent: storeFailureOf(sourceIp) },
    );
  };

  // A principal the store refuses is denied under that reason, naming the verified subject, its actor
  // anonymous since nothing is done for that subject, and counted in its window within the share the
  // exchange already holds.
  const issueOrRefuseSignedIn = async (
    credential: string,
    verified: Verified,
    issuable: Issuable,
    sourceIp: string,
  ): Promise<Outcome> => {
    const issued = await issueSignedIn(verified, issuable, sourceIp).catch(
      (failure: unknown): Outcome => ({ failure, kind: 'failed' }),
    );
    if (issued.kind !== 'standingRefused') {
      return issued;
    }
    const { standing, subject } = issued;
    return refuseInWindow(
      {
        ...credentialRefused(
          deniedExchangeEvent({
            reason: standing,
            refusedSubject: subject,
            sourceIp,
          }),
          { reason: standing, tokenVerified: true },
        ),
        denial: { reason: standing, tokenVerified: true },
      },
      { credential, verified },
      { sourceIp, withinShare: true },
    );
  };

  // A credential with too little of its deadline left for the least judgement budget arrived too late:
  // it is answered as late, judging and recording nothing, whatever the late-request threshold. Once
  // judged, a credential is issued for or refused within its application's share as a credential,
  // never in the anonymous lane.
  const exchangeCredential = async (
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
    const { applicationId } = verified.key;
    const judged = judgedCredentialOf(
      judgement,
      {
        issuedAt: Math.floor(settings.clock.now() / 1000),
        serviceAccountRole: settings.serviceAccountRole,
      },
      { applicationId, sourceIp },
    );
    if (judged.kind === 'issuable') {
      return outcomeWithin(
        applicationId,
        await admission.within(applicationId, 'credential', () =>
          issueOrRefuseSignedIn(credential, verified, judged, sourceIp),
        ),
      );
    }
    const { denial } = judged;
    return denial === undefined
      ? outcomeWithin(
          applicationId,
          await recordRefusalWithinShare(applicationId, () =>
            committed(recordRefusal(judged, verified, sourceIp)),
          ),
        )
      : refuseInWindow(
          { ...judged, denial },
          { credential, verified },
          { sourceIp, withinShare: false },
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
      : exchangeCredential(reading.credential, verified, request.ip);
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
