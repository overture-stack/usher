import type { FastifyReply } from 'fastify';

import { problem, type Problem } from '../http/index.js';

/** The largest request body the management API reads, in bytes: 64 KiB. */
export const BODY_LIMIT_BYTES = 65_536;

// The media type every refusal is answered in: RFC 9457's problem details.
const PROBLEM_MEDIA_TYPE = 'application/problem+json';

/** The refusals the management API answers whatever the operation. */
export const PROBLEMS = Object.freeze({
  administratorOnly: problem(
    'administratorOnly',
    403,
    'For platform administrators alone',
    'This operation is for platform administrators alone.',
  ),
  bodyTooLarge: problem(
    'bodyTooLarge',
    413,
    'Body too large',
    `A request body holds at most ${BODY_LIMIT_BYTES} bytes.`,
  ),
  credentialRefused: problem(
    'credentialRefused',
    401,
    'Credential refused',
    'Send a current access token from the trusted identity provider, issued to a management client for the management API, as one Bearer credential.',
  ),
  identityProviderUnavailable: problem(
    'identityProviderUnavailable',
    503,
    'Identity provider unavailable',
    "The identity provider's signing keys cannot be fetched to verify the access token. Try again later.",
  ),
  internalError: problem(
    'internalError',
    500,
    'Internal error',
    'The controller failed to answer this request, and nothing of it was written.',
  ),
  malformedCredential: problem(
    'malformedCredential',
    400,
    'Credential unreadable',
    'Send exactly one Authorization header holding one Bearer credential, and no credential in the query.',
  ),
  outcomeUnknown: problem(
    'outcomeUnknown',
    503,
    'Outcome unknown',
    'The store did not confirm whether this change was made. Read what it changes before trying again.',
  ),
  serviceAccountNotPermitted: problem(
    'serviceAccountNotPermitted',
    403,
    'Not for service accounts',
    'A service account may not call this operation.',
  ),
  signingKeyUnconfirmed: problem(
    'signingKeyUnconfirmed',
    503,
    'Signing key not confirmed yet',
    "The access token's signing key is not confirmed yet. Try again once the seconds in Retry-After have passed.",
  ),
  storeUnavailable: problem(
    'storeUnavailable',
    503,
    'Policy store unavailable',
    'The policy store cannot take this operation now, and nothing of it was written.',
  ),
  unreadableQuery: problem(
    'unreadableQuery',
    400,
    'Query unreadable',
    'This operation takes no query parameter.',
  ),
  unrepresentableText: problem(
    'unrepresentableText',
    400,
    'Text cannot be stored',
    "Text in the request, or its token's subject or session, holds a NUL character or an unpaired surrogate, neither of which can be stored.",
  ),
  unsupportedMediaType: problem(
    'unsupportedMediaType',
    415,
    'Unsupported media type',
    'Send the body as application/json, in UTF-8.',
  ),
});

/**
 * The refusal of a query unreadable by its shape, for an operation taking query parameters.
 *
 * @param rule what is wrong with the query, worded to follow "The query".
 */
export const unreadableQuery = (rule: string): Problem =>
  problem('unreadableQuery', 400, 'Query unreadable', `The query ${rule}.`);

/**
 * The refusal of a body unreadable by its shape.
 *
 * @param rule what is wrong with the body, worded to follow "The body".
 */
export const unreadableBody = (rule: string): Problem =>
  problem('unreadableBody', 400, 'Body unreadable', `The body ${rule}.`);

/**
 * Answers a refusal: its status, its problem details as JSON, for a refused credential the
 * `WWW-Authenticate` naming the Bearer scheme alone, so every refused credential is answered alike,
 * and `Retry-After` when the refusal names a time to wait.
 *
 * @param reply the reply.
 * @param refusal the problem.
 * @param retryAfterSeconds the whole seconds to wait before trying again, for a refusal naming them.
 */
export const sendProblem = (
  reply: FastifyReply,
  refusal: Problem,
  retryAfterSeconds?: number,
): FastifyReply =>
  reply
    .code(refusal.status)
    .headers({
      'content-type': PROBLEM_MEDIA_TYPE,
      ...(retryAfterSeconds === undefined
        ? {}
        : { 'retry-after': String(retryAfterSeconds) }),
      ...(refusal.status === 401 ? { 'www-authenticate': 'Bearer' } : {}),
    })
    .send(JSON.stringify(refusal));
