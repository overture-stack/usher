import type { FastifyReply } from 'fastify';

import { CHANNEL_ASSERTION_REFUSED } from '../channelAssertion/index.js';
import { problem, type Problem } from '../http/index.js';

/** The largest request body the exchange reads, in bytes: 64 KiB. */
export const BODY_LIMIT_BYTES = 65_536;

/**
 * The refusals the exchange answers, each naming the rule broken or the cause and no value sent. Every
 * refused assertion is answered alike, and so is every refused credential.
 */
export const EXCHANGE_PROBLEMS = Object.freeze({
  bodyTooLarge: problem(
    'bodyTooLarge',
    413,
    'Body too large',
    `A request body holds at most ${BODY_LIMIT_BYTES} bytes.`,
  ),
  channelAssertionRefused: CHANNEL_ASSERTION_REFUSED,
  credentialRefused: problem(
    'credentialRefused',
    403,
    'Credential refused',
    'Send no credential for the anonymous exchange, or a current sign-in token from the trusted identity provider issued for this application to a principal in good standing.',
  ),
  identityProviderUnavailable: problem(
    'identityProviderUnavailable',
    503,
    'Identity provider unavailable',
    "The identity provider's signing keys cannot be fetched to verify the sign-in token, and no token was issued. Try again later.",
  ),
  internalError: problem(
    'internalError',
    500,
    'Internal error',
    'The controller failed to answer this request, and issued no token.',
  ),
  outcomeUnknown: problem(
    'outcomeUnknown',
    503,
    'Outcome unknown',
    'The store did not confirm whether this exchange was recorded, and no token was issued. Try again.',
  ),
  payloadVersionUnserved: problem(
    'payloadVersionUnserved',
    406,
    'Payload version unserved',
    'List payload version 1 in payloadVersions.',
  ),
  requestTimeout: problem(
    'requestTimeout',
    408,
    'Request timeout',
    'The request arrived too late to be answered by its deadline, and no token was issued. Send the whole request at once, then try again.',
  ),
  signingKeyUnconfirmed: problem(
    'signingKeyUnconfirmed',
    503,
    'Signing key not confirmed yet',
    "The sign-in token's signing key is not confirmed yet, and no token was issued. Try again once the seconds in Retry-After have passed.",
  ),
  storeUnavailable: problem(
    'storeUnavailable',
    503,
    'Policy store unavailable',
    'The policy store cannot take this exchange now, and no token was issued. Try again.',
  ),
});

/**
 * The refusal of a body unreadable by its shape, `400 unreadableBody`.
 *
 * @param rule what is wrong with the body, worded to follow "The body".
 */
export const unreadableBody = (rule: string): Problem =>
  problem('unreadableBody', 400, 'Body unreadable', `The body ${rule}.`);

/**
 * Answers a refusal of the exchange: its status, its problem details as JSON, `no-store`, the
 * `WWW-Authenticate` naming the Bearer scheme for a refused assertion, so every one is answered alike,
 * and `Retry-After` when the refusal names a time to wait.
 *
 * @param reply the reply.
 * @param refusal the problem.
 * @param retryAfterSeconds the whole seconds to wait before trying again, for a refusal naming them.
 */
export const sendExchangeProblem = (
  reply: FastifyReply,
  refusal: Problem,
  retryAfterSeconds?: number,
): FastifyReply =>
  reply
    .code(refusal.status)
    .headers({
      'cache-control': 'no-store',
      'content-type': 'application/problem+json',
      ...(retryAfterSeconds === undefined
        ? {}
        : { 'retry-after': String(retryAfterSeconds) }),
      ...(refusal.status === 401 ? { 'www-authenticate': 'Bearer' } : {}),
    })
    .send(JSON.stringify(refusal));
