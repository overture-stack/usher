import type {
  FastifyError,
  FastifyReply,
  FastifyRequest,
  RouteOptions,
} from 'fastify';

import {
  type Actor,
  type AuditEvent,
  REFUSED_SUBJECT_MAXIMUM_LENGTH,
  type Severity,
} from '../eventLog/index.js';
import type { Problem } from '../http/index.js';
import type { UnverifiedReason } from '../identityProvider/index.js';
import { holdsUnstorableText, isStorableText } from '../store/index.js';
import { CommitUnconfirmed } from '../storeTimeout/index.js';
import {
  queryNamesOf,
  queryParametersOf,
  readCredential,
} from './credential.js';
import {
  BODY_LIMIT_BYTES,
  PROBLEMS,
  sendProblem,
  unreadableBody,
} from './problems.js';
import { readManagementClaims } from './readManagementClaims.js';
import { readJsonBody } from './requestBody.js';
import type {
  EventMembers,
  InputReading,
  ManagementDependencies,
  ManagementOperation,
  OperationOutcome,
  Principal,
  TallyReason,
} from './types.js';

/** The line naming a failure of the store while an operation, or the standing of its caller, was read. */
export const STORE_FAILED = 'managementApi.storeFailed';

/** The line naming a failure the Controller did not expect, answered 500. */
export const UNEXPECTED_FAILURE = 'managementApi.unexpectedFailure';

const BODY_TOO_LARGE = 'FST_ERR_CTP_BODY_TOO_LARGE';

// The framework's codes for a body it could not read, each answered as the request's fault.
const CONTENT_PARSING = 'FST_ERR_CTP_';

// The tally reason each of the verifier's reasons is counted under. It covers every reason the
// verifier gives, so a reason added there fails to compile here rather than reaching the audit trail
// unlisted.
const TALLY_REASONS = {
  invalidSignature: 'invalidSignature',
  otherIssuer: 'otherIssuer',
  unreadableToken: 'unreadableToken',
} as const satisfies Readonly<Record<UnverifiedReason, TallyReason>>;

// A request's body as a refused event may read it.
type Body = Readonly<Record<string, unknown>> | undefined;

type Admission =
  | {
      /** Whether Usher has any administrator yet, as the store read it for this request. */
      anyAdministrator: boolean;

      kind: 'admitted';
      principal: Principal;
    }
  | {
      kind: 'refused';
      problem: Problem;

      /** The whole seconds to wait before trying again, for a refusal naming them in `Retry-After`. */
      retryAfterSeconds?: number;
    };

const refusedWith = (
  problem: Problem,
  retryAfterSeconds?: number,
): Admission => ({
  kind: 'refused',
  problem,
  ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
});

const actorOf = ({ subject, type }: Principal): Actor => ({
  id: subject,
  type,
});

// The template as the router writes it: `{id}` as `:id`.
const routerPath = (route: string): string =>
  route.replaceAll(/\{(\w+)\}/gu, ':$1');

const paramsOf = (
  request: FastifyRequest,
): Readonly<Record<string, string>> => {
  const { params } = request;
  return typeof params === 'object' && params !== null
    ? Object.fromEntries(
        Object.entries(params).flatMap(([name, value]) =>
          typeof value === 'string' ? [[name, value]] : [],
        ),
      )
    : {};
};

// Whether every path parameter, as decoded, can be stored and recorded: a NUL or an unpaired
// surrogate in any one can be neither, so such a request names no entity the store could hold.
const holdsStorablePath = (request: FastifyRequest): boolean =>
  Object.values(paramsOf(request)).every(isStorableText);

// A body the framework refused to read, as the refusal it earns: one too large, or any other fault of
// the request's in reading it.
const contentFaultOf = (error: FastifyError): Problem | undefined => {
  if (error.code === BODY_TOO_LARGE) {
    return PROBLEMS.bodyTooLarge;
  }
  return error.code.startsWith(CONTENT_PARSING) &&
    (error.statusCode ?? 500) < 500
    ? unreadableBody('could not be read')
    : undefined;
};

const codeOf = (failure: unknown): Readonly<Record<string, string>> => {
  const code: unknown =
    typeof failure === 'object' && failure !== null && 'code' in failure
      ? failure.code
      : undefined;
  return typeof code === 'string' ? { code } : {};
};

/**
 * Builds the route of one Management API operation. Each request is admitted before its body is
 * read: its credential must be exactly one Bearer token, else it is refused 400 and counted in the
 * refusal tally as `malformedCredential`; a missing one is refused 401 and recorded nowhere; a
 * token that cannot be verified is refused 401 and counted in the refusal tally by reason; a token
 * whose keys cannot be fetched is refused 503, and one whose signing key is not confirmed yet is
 * refused 503 `signingKeyUnconfirmed` with `Retry-After` naming the seconds to wait, neither
 * counted nor recorded; a verified token refused for its claims, or by a revocation of the person
 * or the platform or a sign-out in the store, is refused 401, or 400 for a subject or session that
 * cannot be stored, and recorded as `managementToken.refusal`, its actor anonymous, before the
 * operation begins. Admin status is then read from the store, by the token's subject under the
 * trusted issuer, on every request and never from the token; a store that cannot say is answered
 * 503, recording nothing. Until Usher has an administrator, every operation but those answered
 * before the first one is refused 403 `noAdministratorYet`, a service account included; a service
 * account is refused 403, and so is anyone but a platform administrator for an operation of theirs
 * alone, and anyone whose token lacks the first-user role for an operation of the first user's
 * alone. Then the query, refused 400 for an operation taking none, and the body are read, and the
 * operation run. What the operation answers is sent once the steps it names to run after its commit
 * have run, as is the answer to a change whose `COMMIT` went unconfirmed; a refusal or any other
 * failure runs none. A success carrying no content is answered with no body.
 *
 * A refusal from admission on records the operation's own event, `denied`, at warning. Its reason
 * is the code answered, or the reason the operation gives in its place, as where a `404` stands in
 * for a refusal of authority. It names what the operation reads the request to name, from the path
 * and from a body read as an object holding no text that cannot be stored. A failure of the store
 * answers 503 and records the event `failed`, at error, naming the same. A change whose `COMMIT`
 * the store did not confirm answers 503 `outcomeUnknown` and records nothing more, since it may
 * have been made. Text that cannot be stored, in the token's subject or session, in a path
 * parameter, or anywhere in the body, is refused 400 before any transaction begins, a path
 * parameter's before the query and the body are read. A refusal of a request whose path parameter
 * cannot be stored names no entity, so its event is recorded without the operation being asked what
 * the request named.
 *
 * @param operation the operation.
 * @param dependencies the verifier, the tally, the store's readings of a principal's standing and
 *   of admin status, the trail, the runner of the steps after a commit, the log and the settings
 *   every operation shares.
 */
export const managementRoute = <Input>(
  operation: ManagementOperation<Input>,
  dependencies: ManagementDependencies,
): RouteOptions => {
  const {
    administratorStatus,
    eventLog,
    refusalTally,
    runAfterCommit,
    settings,
    storedRefusal,
    tokenVerifier,
    trail,
  } = dependencies;
  const admitted = new WeakMap<FastifyRequest, Principal>();

  const recordOperationEvent = async (
    request: FastifyRequest,
    principal: Principal,
    {
      body,
      reason,
      result,
      severity,
    }: {
      body: Body;
      reason: string;
      result: 'denied' | 'failed';
      severity: Severity;
    },
  ): Promise<void> => {
    if (operation.event !== undefined) {
      const named: EventMembers = holdsStorablePath(request)
        ? await operation.event
            .named({ body, params: paramsOf(request) })
            .catch(() => ({}))
        : {};
      await trail.recordEvent(actorOf(principal), {
        data: { ...named, reason, result, sourceIp: request.ip },
        severity,
        type: operation.event.type,
      });
    }
  };

  const refuse = async (
    request: FastifyRequest,
    reply: FastifyReply,
    principal: Principal,
    {
      body,
      problem,
      recordedReason,
    }: { body: Body; problem: Problem; recordedReason?: string },
  ): Promise<FastifyReply> => {
    await recordOperationEvent(request, principal, {
      body,
      reason: recordedReason ?? problem.code,
      result: 'denied',
      severity: 'warning',
    });
    return sendProblem(reply, problem);
  };

  // The refused subject is left out for a token whose subject is missing, or whose subject or session
  // cannot be stored, as it is for a subject too long.
  const recordTokenRefusal = (
    request: FastifyRequest,
    reason: string,
    subject?: string,
  ): Promise<string | undefined> => {
    const event: AuditEvent = {
      data: {
        method: operation.method,
        reason,
        ...(subject !== undefined &&
        subject.length <= REFUSED_SUBJECT_MAXIMUM_LENGTH
          ? { refusedSubject: subject }
          : {}),
        result: 'denied',
        route: operation.route,
        sourceIp: request.ip,
      },
      severity: 'warning',
      type: 'managementToken.refusal',
    };
    return trail.recordEvent({ type: 'anonymous' }, event);
  };

  const authenticate = async (request: FastifyRequest): Promise<Admission> => {
    const credential = readCredential(
      request.raw.rawHeaders,
      queryNamesOf(request.raw.url ?? ''),
    );
    if (credential.kind === 'absent') {
      return refusedWith(PROBLEMS.credentialRefused);
    }
    if (credential.kind === 'malformed') {
      refusalTally.count('malformedCredential');
      return refusedWith(PROBLEMS.malformedCredential);
    }
    const verification = await tokenVerifier.verify(credential.token);
    if (verification.kind === 'keysUnavailable') {
      return refusedWith(PROBLEMS.identityProviderUnavailable);
    }
    // No fault of the token's, so neither counted nor recorded, as for keys that cannot be fetched.
    if (verification.kind === 'signingKeyUnconfirmed') {
      return refusedWith(
        PROBLEMS.signingKeyUnconfirmed,
        verification.retryAfterSeconds,
      );
    }
    if (verification.kind === 'unverified') {
      refusalTally.count(TALLY_REASONS[verification.reason]);
      return refusedWith(PROBLEMS.credentialRefused);
    }
    const claims = readManagementClaims(
      verification,
      settings,
      settings.clock.now(),
    );
    if (claims.kind === 'unreadable') {
      await recordTokenRefusal(request, 'missingSubject');
      return refusedWith(PROBLEMS.credentialRefused);
    }
    if (claims.kind === 'unrepresentable') {
      await recordTokenRefusal(request, 'unrepresentableSubject');
      return refusedWith(PROBLEMS.unrepresentableText);
    }
    if (claims.kind === 'refused') {
      await recordTokenRefusal(request, claims.reason, claims.subject);
      return refusedWith(PROBLEMS.credentialRefused);
    }
    const { principal, session } = claims;
    const stored = await storedRefusal({
      issuer: settings.identityProviderIssuer,
      session,
      subject: principal.subject,
    }).then(
      (refusal) => ({ kind: 'read' as const, refusal }),
      (failure: unknown) => ({ failure, kind: 'failed' as const }),
    );
    if (stored.kind === 'failed') {
      eventLog.error(STORE_FAILED, {
        ...codeOf(stored.failure),
        method: operation.method,
        route: operation.route,
      });
      return refusedWith(PROBLEMS.storeUnavailable);
    }
    if (stored.refusal !== undefined) {
      await recordTokenRefusal(request, stored.refusal, principal.subject);
      return refusedWith(PROBLEMS.credentialRefused);
    }
    const status = await administratorStatus({
      issuer: settings.identityProviderIssuer,
      subject: principal.subject,
    }).then(
      (read) => ({ kind: 'read' as const, read }),
      (failure: unknown) => ({ failure, kind: 'failed' as const }),
    );
    if (status.kind === 'failed') {
      eventLog.error(STORE_FAILED, {
        ...codeOf(status.failure),
        method: operation.method,
        route: operation.route,
      });
      return refusedWith(PROBLEMS.storeUnavailable);
    }
    return {
      anyAdministrator: status.read.anyAdministrator,
      kind: 'admitted',
      principal: { ...principal, administrator: status.read.administrator },
    };
  };

  // The principal's standing for the operation, judged before any lookup, so the answer is the same
  // whether or not anything the request names exists. Until an administrator has accepted, only the
  // operations answered before the first one go on to the rest.
  const authorityProblem = (
    principal: Principal,
    anyAdministrator: boolean,
  ): Problem | undefined => {
    if (!anyAdministrator && operation.beforeFirstAdministrator !== true) {
      return PROBLEMS.noAdministratorYet;
    }
    if (principal.type === 'serviceAccount') {
      return PROBLEMS.serviceAccountNotPermitted;
    }
    if (operation.administratorOnly && !principal.administrator) {
      return PROBLEMS.administratorOnly;
    }
    return operation.firstUserOnly === true && !principal.firstUser
      ? PROBLEMS.notFirstUser
      : undefined;
  };

  // The input read, beside the body's object as a refused event may read it: none while the body
  // could not be read as one, or holds text that cannot be stored.
  const inputOf = (
    request: FastifyRequest,
    principal: Principal,
  ): { body: Body; reading: InputReading<Input> } => {
    const refusedFor = (
      problem: Problem,
      body: Body = undefined,
    ): { body: Body; reading: InputReading<Input> } => ({
      body,
      reading: { kind: 'refused', problem },
    });
    if (!holdsStorablePath(request)) {
      return refusedFor(PROBLEMS.unrepresentableText);
    }
    const query = queryParametersOf(request.raw.url ?? '');
    if (operation.takesQuery !== true && query.length > 0) {
      return refusedFor(PROBLEMS.unreadableQuery);
    }
    const read = readJsonBody(
      request.body instanceof Uint8Array ? request.body : undefined,
      request.headers['content-type'],
    );
    if (read.kind === 'refused') {
      return refusedFor(read.problem);
    }
    const body =
      read.kind === 'object' && !holdsUnstorableText(read.value)
        ? read.value
        : undefined;
    if (read.kind === 'object' && operation.body === 'none') {
      return refusedFor(unreadableBody('is not taken by this operation'), body);
    }
    if (read.kind === 'absent' && operation.body === 'required') {
      return refusedFor(unreadableBody('is required by this operation'));
    }
    if (read.kind === 'object' && body === undefined) {
      return refusedFor(PROBLEMS.unrepresentableText);
    }
    return { body, reading: operation.readInput(body, { principal, query }) };
  };

  // A success carrying no content is answered with no body and no media type.
  const answer = (
    reply: FastifyReply,
    {
      body,
      forbidsStoring,
      status,
    }: Extract<OperationOutcome, { kind: 'answered' }>,
  ): FastifyReply => {
    const storing = forbidsStoring ? { 'cache-control': 'no-store' } : {};
    return body === undefined
      ? reply.code(status).headers(storing).send()
      : reply
          .code(status)
          .headers({ 'content-type': 'application/json', ...storing })
          .send(JSON.stringify(body));
  };

  // A change whose commit went unconfirmed may have been made: recording it failed could be false,
  // and the trail's line already names its events. Its steps run, each being safe either way.
  const failed = async (
    request: FastifyRequest,
    reply: FastifyReply,
    principal: Principal,
    { body, failure }: { body: Body; failure: unknown },
  ): Promise<FastifyReply> => {
    if (failure instanceof CommitUnconfirmed) {
      await runAfterCommit(operation.afterCommit ?? []);
      return sendProblem(reply, PROBLEMS.outcomeUnknown);
    }
    eventLog.error(STORE_FAILED, {
      ...codeOf(failure),
      method: operation.method,
      route: operation.route,
    });
    await recordOperationEvent(request, principal, {
      body,
      reason: PROBLEMS.storeUnavailable.code,
      result: 'failed',
      severity: 'error',
    });
    return sendProblem(reply, PROBLEMS.storeUnavailable);
  };

  return {
    bodyLimit: BODY_LIMIT_BYTES,
    errorHandler: async (error: FastifyError, request, reply) => {
      const principal = admitted.get(request);
      const fault = contentFaultOf(error);
      if (principal !== undefined && fault !== undefined) {
        return refuse(request, reply, principal, {
          body: undefined,
          problem: fault,
        });
      }
      eventLog.error(UNEXPECTED_FAILURE, {
        error: error.code ?? error.name,
        method: operation.method,
        route: operation.route,
      });
      return sendProblem(reply, PROBLEMS.internalError);
    },
    exposeHeadRoute: false,
    handler: async (request, reply) => {
      const principal = admitted.get(request);
      if (principal === undefined) {
        return sendProblem(reply, PROBLEMS.internalError);
      }
      const { body, reading } = inputOf(request, principal);
      if (reading.kind === 'refused') {
        return refuse(request, reply, principal, {
          body,
          problem: reading.problem,
        });
      }
      const outcome = await operation
        .run({
          input: reading.input,
          params: paramsOf(request),
          principal,
          sourceIp: request.ip,
        })
        .catch((failure: unknown) => ({ failure, kind: 'failed' as const }));
      if (outcome.kind === 'failed') {
        return failed(request, reply, principal, {
          body,
          failure: outcome.failure,
        });
      }
      if (outcome.kind === 'answered') {
        await runAfterCommit(operation.afterCommit ?? []);
        return answer(reply, outcome);
      }
      return refuse(request, reply, principal, {
        body,
        problem: outcome.problem,
        ...(outcome.recordedReason === undefined
          ? {}
          : { recordedReason: outcome.recordedReason }),
      });
    },
    method: operation.method,
    onRequest: async (request, reply) => {
      const admission = await authenticate(request);
      if (admission.kind === 'refused') {
        return sendProblem(
          reply,
          admission.problem,
          admission.retryAfterSeconds,
        );
      }
      const problem = authorityProblem(
        admission.principal,
        admission.anyAdministrator,
      );
      if (problem !== undefined) {
        return refuse(request, reply, admission.principal, {
          body: undefined,
          problem,
        });
      }
      admitted.set(request, admission.principal);
      return undefined;
    },
    url: routerPath(operation.route),
  };
};
