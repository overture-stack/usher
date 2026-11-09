import type { FastifyReply } from 'fastify';

import { problem, type Problem } from '../http/index.js';

/** The largest request body the back-channel logout route reads, in bytes: 64 KiB. */
export const BODY_LIMIT_BYTES = 65_536;

/**
 * The refusals the back-channel logout route answers, each naming the rule broken or the cause, and no
 * value sent. Every one answers `400`, a body too large and a failure of the controller's included, as
 * OpenID Connect Back-Channel Logout 1.0 §2.8 has a logout that failed answered, so its code alone
 * tells the identity provider why.
 */
export const SIGN_OUT_PROBLEMS = Object.freeze({
  bodyTooLarge: problem(
    'bodyTooLarge',
    400,
    'Body too large',
    `A request body holds at most ${BODY_LIMIT_BYTES} bytes.`,
  ),
  identityProviderUnavailable: problem(
    'identityProviderUnavailable',
    400,
    'Identity provider unavailable',
    "The identity provider's signing keys cannot be fetched to verify the logout token. Try again later.",
  ),
  internalError: problem(
    'internalError',
    400,
    'Internal error',
    'The controller failed to answer this request, and nothing of it was written.',
  ),
  logoutTokenRefused: problem(
    'logoutTokenRefused',
    400,
    'Logout token refused',
    'Send a current logout token from the trusted identity provider, signed by one of its published keys, for a configured back-channel logout client, naming a session in sid, a subject in sub, or both.',
  ),
  outcomeUnknown: problem(
    'outcomeUnknown',
    400,
    'Outcome unknown',
    'The store did not confirm whether this sign-out was recorded. Send the logout token again: a sign-out recorded already is not recorded twice.',
  ),
  signingKeyUnconfirmed: problem(
    'signingKeyUnconfirmed',
    400,
    'Signing key not confirmed yet',
    "The logout token's signing key is not among the identity provider's keys the controller holds, and the controller may not fetch them again yet. Send the logout token again later.",
  ),
  storeUnavailable: problem(
    'storeUnavailable',
    400,
    'Policy store unavailable',
    'The policy store cannot take this sign-out now, and nothing of it was written. Send the logout token again later.',
  ),
  unreadableBody: problem(
    'unreadableBody',
    400,
    'Body unreadable',
    'Send the body as application/x-www-form-urlencoded in UTF-8, holding one logout_token.',
  ),
  unreadableQuery: problem(
    'unreadableQuery',
    400,
    'Query unreadable',
    'This endpoint takes no query: send the logout token in the body.',
  ),
});

/**
 * Answers a refusal of the back-channel logout route: its status, its problem details as JSON, and
 * `no-store`, as every answer of the route carries.
 *
 * @param reply the reply.
 * @param refusal the problem.
 */
export const sendSignOutProblem = (
  reply: FastifyReply,
  refusal: Problem,
): FastifyReply =>
  reply
    .code(refusal.status)
    .headers({
      'cache-control': 'no-store',
      'content-type': 'application/problem+json',
    })
    .send(JSON.stringify(refusal));
