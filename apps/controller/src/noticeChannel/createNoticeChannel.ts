import type { PollAnswer } from '@overture-stack/usher-types';
import type { FastifyError, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';

import type { VerifiedAssertion } from '../channelAssertion/index.js';
import type { Problem } from '../http/index.js';
import { CHANNEL_PROBLEMS, sendChannelProblem } from './channelProblems.js';
import { createNoticeStreams } from './createNoticeStreams.js';
import { createNoticeTail } from './createNoticeTail.js';
import { historyReaches } from './historyReaches.js';
import { placeOfNotice } from './placeOfNotice.js';
import { HEAD, readPollQuery } from './readPollQuery.js';
import type { ChannelKey, NoticeChannel, NoticeChannelSettings, PollRequest } from './types.js';
import {
	listsServedVersion,
	NOTICE_VERSIONS_HEADER,
	noticeOf,
	SERVED_NOTICE_VERSION,
	sealedPollAnswer,
} from './wireFormat.js';

/** The paths the revocation channel is served at. */
export const CHANNEL_PATHS: Readonly<{ poll: string; stream: string }> = Object.freeze({
	poll: '/notices',
	stream: '/notices/stream',
});

/** The line naming a failure of the store while a poll or a stream was answered. */
export const CHANNEL_STORE_FAILED = 'noticeChannel.storeFailed';

/** The line naming a failure the Controller did not expect, answered 500. */
export const CHANNEL_UNEXPECTED_FAILURE = 'noticeChannel.unexpectedFailure';

const codeOf = (failure: unknown): Readonly<Record<string, string>> => {
	const code: unknown =
		typeof failure === 'object' && failure !== null && 'code' in failure ? failure.code : undefined;
	return typeof code === 'string' ? { code } : {};
};

// What a request's admission gives: its assertion once admitted, the store's failure to record it, or
// the refusal it is answered with.
type Admission = { assertion: VerifiedAssertion<ChannelKey> } | { failure: unknown } | { problem: Problem };

const headerOf = (request: FastifyRequest, name: string): string | undefined => {
	const value = request.headers[name];
	return typeof value === 'string' ? value : undefined;
};

/**
 * Creates the revocation channel the Bridge reads: the poll at `GET /notices` and the push at
 * `GET /notices/stream`, each answering one application's notices alone. Every request's channel
 * assertion is checked first, from memory, and refused `401`: an assertion that could not be verified
 * is counted, for `channelAssertion.rejectionTally`, and one that verified and is refused anyway is
 * handed to the instance's recorder of refused assertions, which records the instance's first refusal
 * of each assertion as a `channelAssertion.rejection` naming its application and the request's
 * address, and counts the rest; the answer never waits on it. Then
 * its notice versions, refused `406` unless version 1 is listed; then its starting point, refused
 * `400` when absent or malformed; then its cursor, read from the store, refused `410` when history no
 * longer reaches it. A store that cannot answer within the store timeout is answered `503`. Every
 * answer is `no-store`, and every notice and poll answer is encrypted under the subkeys of the key
 * the assertion verified under.
 *
 * - A poll is answered at once, from the store alone: a head poll with no notices and a cursor for the
 *   newest place; a poll after a cursor with the audience's notices after it, a page at a time, and a
 *   `next` naming the last notice returned while more wait, or the newest place once none does. An
 *   assertion serves any number of polls within its lifetime.
 * - A stream's assertion is recorded in the store as used as soon as it verifies, before anything else
 *   the request carries is read, once across every instance sharing the store: one already recorded is
 *   refused `401` as `reusedAssertion`, and handed to the recorder as any other refusal of an assertion
 *   that verified is. One the store cannot record is answered `503` as any store failure on the route is,
 *   and no stream is opened for it. Once its cursor is read, the stream reserves its place under the audience's
 *   limit on the instance, refused `503` past it, and sends its headers and a first byte at once. It
 *   replays the notices after its cursor, then delivers each new one as the instance's tail reads it.
 * - A wake has the tail read at once, so a change this instance committed is pushed without waiting
 *   for the reread interval.
 * - A change to the live keys ends every stream opened under a key no longer live.
 *
 * @param settings what the channel reads, verifies, seals and records with, and its limits.
 */
export const createNoticeChannel = ({
	assertionRefusals,
	cursors,
	eventLog,
	keyRing,
	reader,
	rejections,
	settings,
	usedAssertions,
	verifier,
}: NoticeChannelSettings): NoticeChannel => {
	const tail = createNoticeTail({
		log: eventLog,
		pageLimit: () => settings.noticePageLimit,
		reader,
		rereadMilliseconds: () => settings.noticeRereadMilliseconds,
	});
	const streams = createNoticeStreams({
		cursors,
		eventLog,
		reader,
		settings,
		tail,
	});

	// An assertion that could not be verified costs nothing to send, so it is counted; one that verified
	// and is refused anyway goes to the recorder, which records its first refusal on the instance. The
	// refusal is answered from memory, so the store's state never delays it.
	const admit = async (request: FastifyRequest): Promise<VerifiedAssertion<ChannelKey> | undefined> => {
		const check = await verifier.verify(request.raw.rawHeaders);
		if (check.kind === 'verified') {
			return check.assertion;
		}
		if (check.kind === 'unverified') {
			rejections.count(check.reason, check.applicationId);
			return undefined;
		}
		assertionRefusals.refused({
			applicationId: check.applicationId,
			reason: check.reason,
			signingInputDigest: check.signingInputDigest,
			sourceIp: request.ip,
		});
		return undefined;
	};

	// The assertion's verification and its refusal come from memory. An assertion opening a stream is then
	// recorded in the store, which judges a second presentation to the stream a reuse: refused, and handed
	// to the recorder whatever else its request carries. A failure to record it is answered 503 with no
	// stream opened. The notice versions' refusal comes last, so a stream refused for them has spent its
	// assertion.
	const admission = async (
		request: FastifyRequest,
		{ opensStream }: { opensStream: boolean },
	): Promise<Admission> => {
		const assertion = await admit(request);
		if (assertion === undefined) {
			return { problem: CHANNEL_PROBLEMS.channelAssertionRefused };
		}
		const { acceptedUntil, id, key, signingInputDigest } = assertion;
		if (opensStream) {
			const recorded = await usedAssertions.record(key.applicationId, id, acceptedUntil).then(
				(wrote) => ({ kind: 'recorded' as const, wrote }),
				(failure: unknown) => ({ failure, kind: 'failed' as const }),
			);
			if (recorded.kind === 'failed') {
				return { failure: recorded.failure };
			}
			if (!recorded.wrote) {
				assertionRefusals.refused({
					applicationId: key.applicationId,
					reason: 'reusedAssertion',
					signingInputDigest,
					sourceIp: request.ip,
				});
				return { problem: CHANNEL_PROBLEMS.channelAssertionRefused };
			}
		}
		return listsServedVersion(headerOf(request, NOTICE_VERSIONS_HEADER))
			? { assertion }
			: { problem: CHANNEL_PROBLEMS.noticeVersionUnserved };
	};

	const storeFailed = (reply: FastifyReply, route: string, failure: unknown): FastifyReply => {
		eventLog.error(CHANNEL_STORE_FAILED, { ...codeOf(failure), route });
		return sendChannelProblem(reply, CHANNEL_PROBLEMS.storeUnavailable);
	};

	const errorHandler =
		(
			route: string,
		): ((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => FastifyReply | undefined) =>
		(error, _request, reply) => {
			eventLog.error(CHANNEL_UNEXPECTED_FAILURE, {
				error: error.code ?? error.name,
				route,
			});
			return reply.sent ? undefined : sendChannelProblem(reply, CHANNEL_PROBLEMS.internalError);
		};

	const pollAnswer = async (key: ChannelKey, { nonce, start }: PollRequest): Promise<PollAnswer | undefined> => {
		if (start.kind === 'head') {
			return {
				after: HEAD,
				more: false,
				next: cursors.seal(await reader.head()),
				nonce,
				notices: [],
				v: SERVED_NOTICE_VERSION,
			};
		}
		const place = cursors.open(start.cursor);
		if (place === undefined) {
			return undefined;
		}
		const page = await reader.after(place.position, {
			audience: key.applicationId,
			limit: settings.noticePageLimit,
		});
		if (!historyReaches(place, page)) {
			return undefined;
		}
		const last = page.notices.at(-1);
		return {
			after: start.cursor,
			more: page.more,
			next: cursors.seal(page.more && last !== undefined ? placeOfNotice(page.epoch, last) : page.head),
			nonce,
			notices: page.notices.map((notice) =>
				noticeOf(notice, cursors.seal(placeOfNotice(page.epoch, notice)), key),
			),
			v: SERVED_NOTICE_VERSION,
		};
	};

	const pollRoute: RouteOptions = {
		errorHandler: errorHandler(CHANNEL_PATHS.poll),
		exposeHeadRoute: false,
		handler: async (request, reply) => {
			const admitted = await admission(request, { opensStream: false });
			if ('failure' in admitted) {
				return storeFailed(reply, CHANNEL_PATHS.poll, admitted.failure);
			}
			if ('problem' in admitted) {
				return sendChannelProblem(reply, admitted.problem);
			}
			const { key } = admitted.assertion;
			const asked = readPollQuery(request.raw.url ?? '');
			if (asked === undefined) {
				return sendChannelProblem(reply, CHANNEL_PROBLEMS.unreadableQuery);
			}
			const answered = await pollAnswer(key, asked).then(
				(answer) => ({ answer, kind: 'answered' as const }),
				(failure: unknown) => ({ failure, kind: 'failed' as const }),
			);
			if (answered.kind === 'failed') {
				return storeFailed(reply, CHANNEL_PATHS.poll, answered.failure);
			}
			if (answered.answer === undefined) {
				return sendChannelProblem(reply, CHANNEL_PROBLEMS.cursorGone);
			}
			return reply
				.code(200)
				.headers({
					'cache-control': 'no-store',
					'content-type': 'application/jose',
				})
				.send(await sealedPollAnswer(answered.answer, key));
		},
		method: 'GET',
		url: CHANNEL_PATHS.poll,
	};

	const streamRoute: RouteOptions = {
		errorHandler: errorHandler(CHANNEL_PATHS.stream),
		exposeHeadRoute: false,
		handler: async (request, reply) => {
			const admitted = await admission(request, { opensStream: true });
			if ('failure' in admitted) {
				return storeFailed(reply, CHANNEL_PATHS.stream, admitted.failure);
			}
			if ('problem' in admitted) {
				return sendChannelProblem(reply, admitted.problem);
			}
			const { key } = admitted.assertion;
			const lastEventId = headerOf(request, 'last-event-id') ?? '';
			if (lastEventId === '') {
				return sendChannelProblem(reply, CHANNEL_PROBLEMS.cursorMissing);
			}
			const place = cursors.open(lastEventId);
			if (place === undefined) {
				return sendChannelProblem(reply, CHANNEL_PROBLEMS.cursorGone);
			}
			const read = await reader
				.after(place.position, {
					audience: key.applicationId,
					limit: settings.noticePageLimit,
				})
				.then(
					(page) => ({ kind: 'read' as const, page }),
					(failure: unknown) => ({ failure, kind: 'failed' as const }),
				);
			if (read.kind === 'failed') {
				return storeFailed(reply, CHANNEL_PATHS.stream, read.failure);
			}
			if (!historyReaches(place, read.page)) {
				return sendChannelProblem(reply, CHANNEL_PROBLEMS.cursorGone);
			}
			const reserved = streams.reserve(key.applicationId);
			if (reserved.kind !== 'reserved') {
				return sendChannelProblem(
					reply,
					reserved.kind === 'full' ? CHANNEL_PROBLEMS.streamLimitReached : CHANNEL_PROBLEMS.instanceStopping,
				);
			}
			reply.hijack();
			reserved.reservation.open({
				firstPage: read.page,
				key,
				place,
				response: reply.raw,
			});
			return reply;
		},
		method: 'GET',
		url: CHANNEL_PATHS.stream,
	};

	return {
		keysChanged: () => {
			streams.endWhere(({ key }) => !keyRing.holds(key));
		},
		routes: [pollRoute, streamRoute],
		stop: async () => {
			await streams.stop();
			await tail.stop();
		},
		wake: () => {
			tail.wake();
		},
	};
};
