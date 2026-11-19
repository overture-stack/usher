import type { ServerResponse } from 'node:http';

import { historyReaches } from './historyReaches.js';
import { placeOfNotice } from './placeOfNotice.js';
import type {
	ChannelKey,
	ChannelLog,
	CursorCipher,
	HeldStream,
	LiveStream,
	NoticePage,
	NoticeReader,
	NoticeStreams,
	NoticeTail,
	StoredNotice,
	StreamPlace,
	StreamReservation,
} from './types.js';
import { HEARTBEAT, noticeEvent, noticeOf, reaches } from './wireFormat.js';

/** The line naming a stream closed because its reader stopped reading. */
export const SLOW_STREAM_CLOSED = 'noticeChannel.slowStreamClosed';

/** The line naming a stream ended by a failure the Controller did not expect. */
export const STREAM_FAILED = 'noticeChannel.streamFailed';

/** The headers every stream is opened with. */
export const STREAM_HEADERS: Readonly<Record<string, string>> = Object.freeze({
	'cache-control': 'no-store',
	'content-type': 'text/event-stream',
	'x-accel-buffering': 'no',
});

const codeOf = (failure: unknown): Readonly<Record<string, string>> => {
	const code: unknown =
		typeof failure === 'object' && failure !== null && 'code' in failure ? failure.code : undefined;
	return typeof code === 'string' ? { code } : {};
};

/**
 * Creates the set of streams open on the instance. A stream replays from the store, a page at a time,
 * each page one statement within the store timeout, so it holds no connection while it writes or
 * waits; once a page leaves nothing more and the stream has passed the instance's tail, it joins the
 * tail, which hands it each newer page. Each notice reaching the stream's audience is written as one
 * event, in position order, waiting for the reader to drain whatever the socket cannot take. A stream
 * whose reader stops reading while more than the queue limit of the tail's notices wait for it is
 * closed at once; one silent for the heartbeat interval is sent a comment alone, unless it waits for
 * its reader; and each ends at its maximum lifetime, or when its replay finds history no longer
 * reaching it, its Bridge to open it again from its own cursor.
 *
 * @param settings what reads, seals and tails the stream, the log, and the limits and timings.
 */
export const createNoticeStreams = ({
	cursors,
	eventLog,
	reader,
	settings,
	tail,
}: {
	cursors: Pick<CursorCipher, 'seal'>;
	eventLog: ChannelLog;
	reader: NoticeReader;
	settings: {
		heartbeatMilliseconds: number;
		noticePageLimit: number;
		streamLimitPerAudience: number;
		streamMaximumLifetimeSeconds: number;
		streamQueueLimit: number;
	};
	tail: Pick<NoticeTail, 'join' | 'leave'>;
}): NoticeStreams => {
	const state: {
		open: Set<HeldStream>;
		reserved: string[];
		stopped: boolean;
		work: Set<Promise<void>>;
	} = { open: new Set(), reserved: [], stopped: false, work: new Set() };

	const unreserve = (applicationId: string): void => {
		const index = state.reserved.indexOf(applicationId);
		if (index !== -1) {
			state.reserved.splice(index, 1);
		}
	};

	const openStream = ({
		firstPage,
		key,
		place,
		response,
	}: {
		firstPage: NoticePage;
		key: ChannelKey;
		place: StreamPlace;
		response: ServerResponse;
	}): void => {
		const { applicationId } = key;
		const { epoch } = place;
		const stream: {
			draining: boolean;
			drainWaiters: (() => void)[];
			ended: boolean;
			flushing: boolean;
			heartbeat: ReturnType<typeof setTimeout> | undefined;
			live: boolean;
			queue: StoredNotice[];
			scannedThrough: bigint;
		} = {
			draining: false,
			drainWaiters: [],
			ended: false,
			flushing: false,
			heartbeat: undefined,
			live: false,
			queue: [],
			scannedThrough: place.position,
		};

		const drained = (): void => {
			stream.draining = false;
			stream.drainWaiters.splice(0).forEach((waiter) => {
				waiter();
			});
		};

		const finish = (closing: 'destroy' | 'end'): void => {
			if (stream.ended) {
				return;
			}
			stream.ended = true;
			clearTimeout(stream.heartbeat);
			clearTimeout(lifetime);
			tail.leave(live);
			state.open.delete(held);
			unreserve(applicationId);
			stream.queue = [];
			drained();
			if (closing === 'destroy') {
				response.destroy();
				return;
			}
			response.end();
		};

		// Ends the stream as cleanly as its reader allows: at an event's end, or at once while it waits
		// for a reader who may never drain it.
		const end = (): void => {
			finish(stream.draining ? 'destroy' : 'end');
		};

		const fail = (failure: unknown): void => {
			eventLog.error(STREAM_FAILED, codeOf(failure));
			finish('destroy');
		};

		const untilDrained = (): Promise<void> =>
			new Promise((resolve) => {
				stream.drainWaiters.push(resolve);
			});

		// Writes once the reader has drained what came before, and waits for it to drain this too when
		// the socket cannot take it.
		const write = async (text: string): Promise<void> => {
			if (stream.draining) {
				await untilDrained();
			}
			if (stream.ended) {
				return;
			}
			rearm();
			if (!response.write(text)) {
				stream.draining = true;
				await untilDrained();
			}
		};

		// A heartbeat goes out after a silence of the heartbeat interval, and never while the reader is
		// not draining what was written.
		const beat = (): void => {
			if (stream.draining) {
				rearm();
				return;
			}
			void write(HEARTBEAT);
		};

		const rearm = (): void => {
			clearTimeout(stream.heartbeat);
			stream.heartbeat = setTimeout(beat, settings.heartbeatMilliseconds);
			stream.heartbeat.unref();
		};

		const eventOf = (notice: StoredNotice): Promise<string> =>
			noticeEvent(noticeOf(notice, cursors.seal(placeOfNotice(epoch, notice)), key), key);

		const writeNotice = async (notice: StoredNotice): Promise<void> => {
			await write(await eventOf(notice));
		};

		const writeInTurn = (notices: readonly StoredNotice[]): Promise<void> =>
			notices.reduce(
				(earlier, notice) => earlier.then(() => (stream.ended ? undefined : writeNotice(notice))),
				Promise.resolve(),
			);

		// A notice stays queued until the socket is handed its event, so the queue counts what waits on
		// the reader and nothing the socket already took.
		const writeQueue = async (): Promise<void> => {
			const [next] = stream.queue;
			if (next === undefined || stream.ended) {
				return;
			}
			const event = await eventOf(next);
			if (stream.draining) {
				await untilDrained();
			}
			if (stream.ended) {
				return;
			}
			stream.queue.shift();
			await write(event);
			await writeQueue();
		};

		const flush = (): void => {
			if (stream.flushing || stream.ended) {
				return;
			}
			stream.flushing = true;
			const flushing = writeQueue()
				.catch(fail)
				.finally(() => {
					stream.flushing = false;
					state.work.delete(flushing);
				});
			state.work.add(flushing);
		};

		const live: LiveStream = {
			end,
			epoch,
			offer: (notices) => {
				if (stream.ended || !stream.live) {
					return;
				}
				const passed = stream.scannedThrough;
				stream.queue.push(
					...notices.filter((notice) => notice.position > passed && reaches(notice, applicationId)),
				);
				const last = notices.at(-1)?.position ?? passed;
				stream.scannedThrough = last > passed ? last : passed;
				if (stream.draining && stream.queue.length > settings.streamQueueLimit) {
					eventLog.warning(SLOW_STREAM_CLOSED, { applicationId });
					finish('destroy');
					return;
				}
				flush();
			},
			scannedThrough: () => stream.scannedThrough,
		};

		const held: HeldStream = {
			close: () => {
				finish('destroy');
			},
			end,
			key,
		};

		// Writes a page, then joins the tail once nothing more waits and the tail is not ahead, or reads
		// the next page from where this one reached. A tail ahead of every notice the store holds, as after
		// a restore that kept the epoch, ends the stream rather than have it read the store again and again.
		const replay = async (page: NoticePage): Promise<void> => {
			await writeInTurn(page.notices);
			const last = page.notices.at(-1);
			const reached = page.more && last !== undefined ? placeOfNotice(epoch, last) : page.head;
			if (stream.ended) {
				return;
			}
			stream.scannedThrough = reached.position;
			if (!page.more && tail.join(live)) {
				stream.live = true;
				flush();
				return;
			}
			const next = await reader.after(reached.position, {
				audience: applicationId,
				limit: settings.noticePageLimit,
			});
			if (stream.ended) {
				return;
			}
			const behindTail = !page.more && next.notices.length === 0 && next.head.position <= reached.position;
			if (historyReaches(reached, next) && !behindTail) {
				await replay(next);
				return;
			}
			end();
		};

		const lifetime = setTimeout(end, settings.streamMaximumLifetimeSeconds * 1000);
		lifetime.unref();

		state.open.add(held);
		response.on('drain', drained);
		response.on('close', () => {
			finish('destroy');
		});
		// A reader gone before the stream opened leaves no close to hear.
		if (response.socket?.destroyed !== false) {
			finish('destroy');
			return;
		}
		response.socket.setNoDelay(true);
		response.writeHead(200, { ...STREAM_HEADERS });
		void write(HEARTBEAT);
		const replaying = replay(firstPage)
			.catch(fail)
			.finally(() => {
				state.work.delete(replaying);
			});
		state.work.add(replaying);
	};

	return {
		endWhere: (test) => {
			[...state.open].filter(test).forEach((stream) => {
				stream.end();
			});
		},

		reserve: (applicationId) => {
			if (state.stopped) {
				return { kind: 'stopping' };
			}
			const held = state.reserved.filter((reserved) => reserved === applicationId).length;
			if (held >= settings.streamLimitPerAudience) {
				return { kind: 'full' };
			}
			state.reserved.push(applicationId);
			const reservation: StreamReservation = {
				open: (stream) => {
					if (state.stopped) {
						unreserve(applicationId);
						stream.response.destroy();
						return;
					}
					openStream(stream);
				},
				release: () => {
					unreserve(applicationId);
				},
			};
			return { kind: 'reserved', reservation };
		},

		stop: async () => {
			state.stopped = true;
			[...state.open].forEach((stream) => {
				stream.close();
			});
			await Promise.all([...state.work]);
		},
	};
};
