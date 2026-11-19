import type { FastifyReply } from 'fastify';

import { CHANNEL_ASSERTION_REFUSED } from '../channelAssertion/index.js';
import { problem, type Problem } from '../http/index.js';

/** The refusals the revocation channel answers, each naming the rule broken and no value sent. */
export const CHANNEL_PROBLEMS = Object.freeze({
	channelAssertionRefused: CHANNEL_ASSERTION_REFUSED,
	cursorGone: problem(
		'cursorGone',
		410,
		'Cursor gone',
		'History no longer reaches this cursor: drop every cached entry and poll from head.',
	),
	cursorMissing: problem(
		'cursorMissing',
		400,
		'Cursor missing',
		'Send the cursor the stream starts after in Last-Event-ID.',
	),
	instanceStopping: problem(
		'instanceStopping',
		503,
		'Instance stopping',
		'This instance is stopping. Open the stream again.',
	),
	internalError: problem(
		'internalError',
		500,
		'Internal error',
		'The controller failed to answer this request, and nothing of it was written.',
	),
	noticeVersionUnserved: problem(
		'noticeVersionUnserved',
		406,
		'Notice version unserved',
		'List notice version 1 in Usher-Notice-Versions.',
	),
	storeUnavailable: problem(
		'storeUnavailable',
		503,
		'Policy store unavailable',
		'The policy store cannot be read now. Try again.',
	),
	streamLimitReached: problem(
		'streamLimitReached',
		503,
		'Stream limit reached',
		'The application holds as many open streams on this instance as it may. Try again later.',
	),
	unreadableQuery: problem(
		'unreadableQuery',
		400,
		'Query unreadable',
		'Send head=true or a non-empty after, not both, and a nonce of 16 to 128 base64url characters, each once and nothing else.',
	),
});

/**
 * Answers a refusal of the revocation channel: its status, its problem details as JSON, `no-store`,
 * and for a refused assertion the `WWW-Authenticate` naming the Bearer scheme, so every refused
 * assertion is answered alike.
 *
 * @param reply the reply.
 * @param refusal the problem.
 */
export const sendChannelProblem = (reply: FastifyReply, refusal: Problem): FastifyReply =>
	reply
		.code(refusal.status)
		.headers({
			'cache-control': 'no-store',
			'content-type': 'application/problem+json',
			...(refusal.status === 401 ? { 'www-authenticate': 'Bearer' } : {}),
		})
		.send(JSON.stringify(refusal));
