import type {
  FastifyError,
  FastifyReply,
  FastifyRequest,
  RouteOptions,
} from 'fastify';

import type { Actor, AuditEvent, Severity } from '../eventLog/index.js';
import { CommitUnconfirmed } from '../storeTimeout/index.js';
import { queryNamesOf, readCredential } from './credential.js';
import { readManagementClaims } from './managementClaims.js';
import {
  BODY_LIMIT_BYTES,
  PROBLEMS,
  sendProblem,
  unreadableBody,
} from './problems.js';
import { readJsonBody } from './requestBody.js';
import { holdsUnstorableText } from './storableText.js';
import type {
  EventMembers,
  InputReading,
  ManagementDependencies,
  ManagementOperation,
  OperationOutcome,
  Principal,
  Problem,
} from './types.js';

/** The line naming a failure of the store while an operation, or the standing of its caller, was read. */
export const STORE_FAILED = 'managementApi.storeFailed';

/** The line naming a failure the controller did not expect, answered 500. */
export const UNEXPECTED_FAILURE = 'managementApi.unexpectedFailure';

/** The longest `sub` a `managementToken.refusal` names, in characters; a longer one is left out, never cut short. */
export const REFUSED_SUBJECT_MAXIMUM_LENGTH = 255;

const BODY_TOO_LARGE = 'FST_ERR_CTP_BODY_TOO_LARGE';

// The framework's codes for a body it could not read, each answered as the request's fault.
const CONTENT_PARSING = 'FST_ERR_CTP_';

type Admission =
  | { kind: 'admitted'; principal: Principal }
  | { kind: 'refused'; problem: Problem };

const refusedWith = (problem: Problem): Admission => ({
  kind: 'refused',
  problem,
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
 * Builds the route of one Management API operation. Each request is admitted before its body is read:
 * its credential must be exactly one Bearer token, else it is refused 400 and counted in the refusal
 * tally as `malformedCredential`; a missing one is refused 401 and recorded nowhere; a token that
 * cannot be verified is refused 401 and counted in the refusal tally by reason; a token whose keys
 * cannot be fetched is refused 503; a verified token refused for its claims, or by a revocation of
 * the person or the platform or a sign-out in the store, is refused 401, or 400 for a subject or
 * session that cannot be stored, and recorded as `managementToken.refusal`, its actor anonymous,
 * before the operation begins; a service account is refused 403, and so is anyone but a platform
 * administrator for an operation of theirs alone. Then the query, which no operation takes, and the
 * body are read, and the operation run. A refusal from admission on records the operation's own
 * event, `denied`, at warning, its reason the code answered, naming the existing entities the request
 * named; a failure of the store answers 503 and records it `failed`, at error. A change whose
 * `COMMIT` the store did not confirm answers 503 `outcomeUnknown` and records nothing more, since it may
 * have been made. Text that cannot be stored, in the token's subject or session or anywhere in the
 * body, is refused 400 before any transaction begins.
 *
 * @param operation the operation.
 * @param dependencies the verifier, the tally, the store's reading of a principal's standing, the
 *   trail, the log and the settings every operation shares.
 */
export const managementRoute = <Input>(
  operation: ManagementOperation<Input>,
  dependencies: ManagementDependencies,
): RouteOptions => {
  const {
    eventLog,
    refusalTally,
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
      problem: { code },
      result,
      severity,
    }: { problem: Problem; result: 'denied' | 'failed'; severity: Severity },
  ): Promise<void> => {
    if (operation.event !== undefined) {
      const named: EventMembers = await operation.event
        .named(paramsOf(request))
        .catch(() => ({}));
      await trail.recordEvent(actorOf(principal), {
        data: { ...named, reason: code, result, sourceIp: request.ip },
        severity,
        type: operation.event.type,
      });
    }
  };

  const refuse = async (
    request: FastifyRequest,
    reply: FastifyReply,
    principal: Principal,
    problem: Problem,
  ): Promise<FastifyReply> => {
    await recordOperationEvent(request, principal, {
      problem,
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
    if (verification.kind === 'unverified') {
      refusalTally.count(verification.reason);
      return refusedWith(PROBLEMS.credentialRefused);
    }
    const claims = readManagementClaims(
      verification.claims,
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
    return { kind: 'admitted', principal };
  };

  // The principal's standing for the operation, judged before any lookup, so the answer is the same
  // whether or not anything the request names exists.
  const authorityProblem = (principal: Principal): Problem | undefined => {
    if (principal.type === 'serviceAccount') {
      return PROBLEMS.serviceAccountNotPermitted;
    }
    return operation.administratorOnly && !principal.administrator
      ? PROBLEMS.administratorOnly
      : undefined;
  };

  const inputOf = (request: FastifyRequest): InputReading<Input> => {
    if (queryNamesOf(request.raw.url ?? '').length > 0) {
      return { kind: 'refused', problem: PROBLEMS.unreadableQuery };
    }
    const body = readJsonBody(
      request.body instanceof Uint8Array ? request.body : undefined,
      request.headers['content-type'],
    );
    if (body.kind === 'refused') {
      return body;
    }
    if (body.kind === 'object' && operation.body === 'none') {
      return {
        kind: 'refused',
        problem: unreadableBody('is not taken by this operation'),
      };
    }
    if (body.kind === 'absent' && operation.body === 'required') {
      return {
        kind: 'refused',
        problem: unreadableBody('is required by this operation'),
      };
    }
    if (body.kind === 'object' && holdsUnstorableText(body.value)) {
      return { kind: 'refused', problem: PROBLEMS.unrepresentableText };
    }
    return operation.readInput(body.kind === 'object' ? body.value : undefined);
  };

  const answer = (
    reply: FastifyReply,
    outcome: Extract<OperationOutcome, { kind: 'answered' }>,
  ): FastifyReply =>
    reply
      .code(outcome.status)
      .headers({
        'content-type': 'application/json',
        ...(outcome.forbidsStoring ? { 'cache-control': 'no-store' } : {}),
      })
      .send(JSON.stringify(outcome.body));

  // A change whose commit went unconfirmed may have been made: recording it failed could be false,
  // and the trail's line already names its events.
  const failed = async (
    request: FastifyRequest,
    reply: FastifyReply,
    principal: Principal,
    failure: unknown,
  ): Promise<FastifyReply> => {
    if (failure instanceof CommitUnconfirmed) {
      return sendProblem(reply, PROBLEMS.outcomeUnknown);
    }
    eventLog.error(STORE_FAILED, {
      ...codeOf(failure),
      method: operation.method,
      route: operation.route,
    });
    await recordOperationEvent(request, principal, {
      problem: PROBLEMS.storeUnavailable,
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
        return refuse(request, reply, principal, fault);
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
      const reading = inputOf(request);
      if (reading.kind === 'refused') {
        return refuse(request, reply, principal, reading.problem);
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
        return failed(request, reply, principal, outcome.failure);
      }
      return outcome.kind === 'answered'
        ? answer(reply, outcome)
        : refuse(request, reply, principal, outcome.problem);
    },
    method: operation.method,
    onRequest: async (request, reply) => {
      const admission = await authenticate(request);
      if (admission.kind === 'refused') {
        return sendProblem(reply, admission.problem);
      }
      const problem = authorityProblem(admission.principal);
      if (problem !== undefined) {
        return refuse(request, reply, admission.principal, problem);
      }
      admitted.set(request, admission.principal);
      return undefined;
    },
    url: routerPath(operation.route),
  };
};
