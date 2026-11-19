import type { FastifyError, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';

import type { Actor } from '../eventLog/index.js';
import type { Problem } from '../http/index.js';
import { failureCodeOf, failureNameOf } from '../failures/index.js';
import type { UnverifiedReason } from '../identityProvider/index.js';
import { tokenDigestOf } from '../refusalWindows/index.js';
import { CommitUnconfirmed } from '../storeTimeout/index.js';
import { readLogoutRequest } from './readLogoutRequest.js';
import { readLogoutToken } from './readLogoutToken.js';
import { recordSignOut } from './recordSignOut.js';
import { logoutTokenRefusalEvent } from './refusalEvents.js';
import { BODY_LIMIT_BYTES, SIGN_OUT_PROBLEMS, sendSignOutProblem } from './signOutProblems.js';
import type { SignOut, SignOutRouteSettings, SwitchedOffLogoutReason, UnverifiedLogoutReason } from './types.js';

/** The path the identity provider's back-channel logout is sent to. */
export const SIGN_OUT_PATH = '/backchannel-logout';

/** The line naming a failure of the store while a sign-out was recorded. */
export const SIGN_OUT_STORE_FAILED = 'signOuts.storeFailed';

/** The line written at warning on every start that does not relay sign-outs, the `backChannelLogout` setting off. */
export const SIGN_OUTS_RELAYING_OFF = 'signOuts.relayingOff';

/** The line naming a failure the Controller did not expect, answered `400 internalError`. */
export const SIGN_OUT_UNEXPECTED_FAILURE = 'signOuts.unexpectedFailure';

const BODY_TOO_LARGE = 'FST_ERR_CTP_BODY_TOO_LARGE';

// The framework's codes for a body it could not read, each answered as the request's fault.
const CONTENT_PARSING = 'FST_ERR_CTP_';

// The reason each of the verifier's reasons is refused under. It covers every reason the verifier
// gives, so a reason added there fails to compile here rather than reaching the audit trail unlisted.
const UNVERIFIED_REASONS = {
	invalidSignature: 'invalidSignature',
	otherIssuer: 'otherIssuer',
	unreadableToken: 'unreadableToken',
} as const satisfies Readonly<Record<UnverifiedReason, UnverifiedLogoutReason>>;

const ANONYMOUS: Actor = Object.freeze({ type: 'anonymous' });

// The reason every logout token is refused under while the setting is off: keyed by the reason alone.
const SWITCHED_OFF_REASON: SwitchedOffLogoutReason = 'backChannelLogoutOff';

const SYSTEM: Actor = Object.freeze({ type: 'system' });

type Admission = { kind: 'admitted'; signOut: SignOut } | { kind: 'refused'; problem: Problem };

type Committing = { failure: unknown; kind: 'failed' } | { kind: 'committed' };

const refusedWith = (problem: Problem): Admission => ({
	kind: 'refused',
	problem,
});

// The failure by its code alone, where it carries one that is an identifier, since a message may quote
// a value.
const codeOf = (failure: unknown): Readonly<Record<string, string>> => {
	const code = failureCodeOf(failure);
	return code === undefined ? {} : { code };
};

/**
 * Creates the route the identity provider's OpenID Connect back-channel logout is sent to,
 * `POST /backchannel-logout`, taking no credential but the logout token itself. A request is read
 * for one form-encoded `logout_token` and no query, refused `400` otherwise, and `400 bodyTooLarge`
 * past 64 KiB. While the `backChannelLogout` setting is off, read at each request, every logout token
 * is refused before it is verified, as `backChannelLogoutOff`, answered `400 logoutTokenRefused`, its
 * window keyed by that reason alone and its first refusal recorded naming no subject. Otherwise its
 * token is verified under the trusted issuer's published keys, through the
 * verifier every route shares, and judged as a logout token for a configured back-channel logout
 * client, current and naming a session, a subject or both, every refusal of the token answered
 * alike, `400 logoutTokenRefused`, so the answer tells no check from another. Each refused token is
 * counted in the windows given: one that verified and is refused anyway under its digest and the
 * reason, and one that could not be verified under the reason alone, never under anything read from
 * it. A refusal opening a window is recorded as a `logoutToken.refusal`, its actor anonymous,
 * naming its reason, the request's address and, as `refusedSubject`, the subject named by a verified
 * token's `sub` where that may be named; a refusal counted in an open window writes nothing. A token
 * whose key cannot be had while the provider cannot be reached is answered
 * `400 identityProviderUnavailable`, and one whose key is not confirmed yet, the refetch cooldown
 * forbidding a fetch, `400 signingKeyUnconfirmed` with no `Retry-After`, which Back-Channel Logout
 * gives no meaning to. Neither is counted or recorded, and a request refused before its token is
 * verified is recorded nowhere. A token accepted is recorded as a sign-out, with its
 * `identity.signOut` event and, where the subject is known, a principal notice to every
 * application, in one transaction declaring the system as its actor, and answered `200` once that
 * transaction has committed, so every application can read any notice before the provider is told
 * the sign-out was taken; a sign-out the store holds already writes nothing more and is answered
 * `200` alike. A store that cannot take it is answered `400 storeUnavailable`, its failure written
 * by its code alone, a commit it did not confirm `400 outcomeUnknown`, and a failure the route did
 * not expect `400 internalError`: as OpenID Connect Back-Channel Logout 1.0 §2.8 has it, every
 * logout not taken is answered `400`, its code naming the cause. Every answer is `no-store`, and no
 * line it writes holds the token, a URL or a message from the store: a failure is named by its code
 * or its name only where that is an identifier.
 *
 * @param settings the verifier, the windows, the trail, the log, and the configuration the route reads.
 */
export const createSignOutRoute = ({
	eventLog,
	refusals,
	settings,
	tokenVerifier,
	trail,
}: SignOutRouteSettings): RouteOptions => {
	const admit = async (request: FastifyRequest): Promise<Admission> => {
		const reading = readLogoutRequest({
			body: request.body instanceof Uint8Array ? request.body : undefined,
			contentType: request.headers['content-type'],
			url: request.raw.url ?? '',
		});
		if (reading.kind === 'refused') {
			return refusedWith(reading.problem);
		}
		if (!settings.backChannelLogout) {
			await refusals.refuse(
				{ reason: SWITCHED_OFF_REASON, route: 'logout' },
				() =>
					trail.recordEvent(
						ANONYMOUS,
						logoutTokenRefusalEvent({
							reason: SWITCHED_OFF_REASON,
							sourceIp: request.ip,
							subject: undefined,
						}),
					),
				(id) => id,
			);
			return refusedWith(SIGN_OUT_PROBLEMS.logoutTokenRefused);
		}
		const verification = await tokenVerifier.verify(reading.token);
		if (verification.kind === 'keysUnavailable') {
			return refusedWith(SIGN_OUT_PROBLEMS.identityProviderUnavailable);
		}
		if (verification.kind === 'signingKeyUnconfirmed') {
			return refusedWith(SIGN_OUT_PROBLEMS.signingKeyUnconfirmed);
		}
		if (verification.kind === 'unverified') {
			const reason = UNVERIFIED_REASONS[verification.reason];
			await refusals.refuse(
				{ reason, route: 'logout' },
				() =>
					trail.recordEvent(
						ANONYMOUS,
						logoutTokenRefusalEvent({
							reason,
							sourceIp: request.ip,
							subject: undefined,
						}),
					),
				(id) => id,
			);
			return refusedWith(SIGN_OUT_PROBLEMS.logoutTokenRefused);
		}
		const token = readLogoutToken(verification, settings, settings.clock.now());
		if (token.kind === 'accepted') {
			return { kind: 'admitted', signOut: token.signOut };
		}
		await refusals.refuse(
			{
				reason: token.reason,
				route: 'logout',
				tokenDigest: tokenDigestOf(reading.token),
			},
			() =>
				trail.recordEvent(
					ANONYMOUS,
					logoutTokenRefusalEvent({
						reason: token.reason,
						sourceIp: request.ip,
						subject: token.subject,
					}),
				),
			(id) => id,
		);
		return refusedWith(SIGN_OUT_PROBLEMS.logoutTokenRefused);
	};

	const commit = (signOut: SignOut, sourceIp: string): Promise<Committing> =>
		trail
			.inTransaction(SYSTEM, (transaction) =>
				recordSignOut(
					transaction,
					{
						issuer: settings.identityProviderIssuer,
						retentionSeconds: settings.signInTokenMaximumLifetimeSeconds,
						schema: settings.databaseSchema,
						sourceIp,
					},
					signOut,
				),
			)
			.then(
				(): Committing => ({ kind: 'committed' }),
				(failure: unknown): Committing => ({ failure, kind: 'failed' }),
			);

	// A commit the store did not confirm may have taken effect, and the trail's own line names it.
	const failed = (reply: FastifyReply, failure: unknown): FastifyReply => {
		if (failure instanceof CommitUnconfirmed) {
			return sendSignOutProblem(reply, SIGN_OUT_PROBLEMS.outcomeUnknown);
		}
		eventLog.error(SIGN_OUT_STORE_FAILED, {
			...codeOf(failure),
			route: SIGN_OUT_PATH,
		});
		return sendSignOutProblem(reply, SIGN_OUT_PROBLEMS.storeUnavailable);
	};

	return {
		bodyLimit: BODY_LIMIT_BYTES,
		errorHandler: (error: FastifyError, _request, reply) => {
			const code = failureCodeOf(error);
			if (code === BODY_TOO_LARGE) {
				return sendSignOutProblem(reply, SIGN_OUT_PROBLEMS.bodyTooLarge);
			}
			if (code?.startsWith(CONTENT_PARSING) === true && (error.statusCode ?? 500) < 500) {
				return sendSignOutProblem(reply, SIGN_OUT_PROBLEMS.unreadableBody);
			}
			eventLog.error(SIGN_OUT_UNEXPECTED_FAILURE, {
				error: code ?? failureNameOf(error),
				route: SIGN_OUT_PATH,
			});
			return reply.sent ? undefined : sendSignOutProblem(reply, SIGN_OUT_PROBLEMS.internalError);
		},
		exposeHeadRoute: false,
		handler: async (request, reply) => {
			const admission = await admit(request);
			if (admission.kind === 'refused') {
				return sendSignOutProblem(reply, admission.problem);
			}
			const committing = await commit(admission.signOut, request.ip);
			return committing.kind === 'committed'
				? reply.code(200).header('cache-control', 'no-store').send()
				: failed(reply, committing.failure);
		},
		method: 'POST',
		url: SIGN_OUT_PATH,
	};
};
