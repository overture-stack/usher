import type { ChannelLog, LiveStream, NoticeReader, NoticeTail } from './types.js';

/** The line naming a read of the newest notices that failed; the tail reads from where it was next time. */
export const TAIL_READ_FAILED = 'noticeChannel.tailReadFailed';

// The failure by its code alone, where it carries one, since a store's message may quote a value.
const codeOf = (failure: unknown): Readonly<Record<string, string>> => {
	const code: unknown =
		typeof failure === 'object' && failure !== null && 'code' in failure ? failure.code : undefined;
	return typeof code === 'string' ? { code } : {};
};

/**
 * Creates the instance's tail of the notice stream: one reader of the newest notices for every live
 * stream on the instance, so a stream waiting for notices holds no connection to the store. While any
 * stream is live, the tail reads the notices after its position, every audience's alike, a page at a
 * time, each page one statement within the store timeout, until a page holds no more; it hands each
 * page to every live stream, which keeps what reaches its audience, and moves on. It reads when woken
 * and at every reread interval besides, so a notice another instance committed is pushed within that
 * interval, and a changed interval is re-armed at the tick that reads it; wakes arriving during a read are
 * answered by one read after it. A read finding the epoch replaced, the watermark past the tail's position,
 * or the newest notice below it, as after a restore,
 * ends every live stream, each Bridge to open its stream again from its own cursor; a read that fails
 * is written to the log by its code, and tried again at the next wake.
 *
 * @param settings the reader, the page limit and the reread interval, each read at the moment it is used, and
 *   the log.
 */
export const createNoticeTail = ({
	log,
	pageLimit,
	reader,
	rereadMilliseconds,
}: {
	log: Pick<ChannelLog, 'error'>;
	pageLimit: () => number;
	reader: NoticeReader;
	rereadMilliseconds: () => number;
}): NoticeTail => {
	const state: {
		again: boolean;
		epoch: string | undefined;
		generation: number;
		live: Set<LiveStream>;
		position: bigint | undefined;
		reading: Promise<void> | undefined;
		stopped: boolean;
		timer: ReturnType<typeof setInterval> | undefined;
	} = {
		again: false,
		epoch: undefined,
		generation: 0,
		live: new Set(),
		position: undefined,
		reading: undefined,
		stopped: false,
		timer: undefined,
	};

	const rest = (): void => {
		clearInterval(state.timer);
		state.timer = undefined;
		state.epoch = undefined;
		state.position = undefined;
		state.generation += 1;
	};

	const endEveryStream = (): void => {
		const ending = [...state.live];
		state.live.clear();
		rest();
		ending.forEach((stream) => {
			stream.end();
		});
	};

	const readFrom = async (after: bigint, generation: number): Promise<void> => {
		const page = await reader.after(after, { limit: pageLimit() });
		if (state.generation !== generation || state.stopped) {
			return;
		}
		const rewound = page.head.position < after;
		if (page.epoch !== state.epoch || page.trimmedThrough > after || rewound) {
			endEveryStream();
			return;
		}
		const last = page.notices.at(-1)?.position ?? after;
		[...state.live].forEach((stream) => {
			stream.offer(page.notices);
		});
		state.position = last;
		if (page.more) {
			await readFrom(last, generation);
		}
	};

	const wake = (): void => {
		const { generation, position } = state;
		if (state.stopped || position === undefined) {
			return;
		}
		if (state.reading !== undefined) {
			state.again = true;
			return;
		}
		const reading = readFrom(position, generation)
			.catch((failure: unknown) => {
				log.error(TAIL_READ_FAILED, codeOf(failure));
			})
			.finally(() => {
				state.reading = undefined;
				if (state.again) {
					state.again = false;
					wake();
				}
			});
		state.reading = reading;
	};

	// Arms the reread interval at the given period, reading the value again at each tick: a value changed since the
	// interval was armed re-arms it at that tick, so the change takes effect within one interval.
	const arm = (milliseconds: number): void => {
		clearInterval(state.timer);
		state.timer = setInterval(() => {
			const current = rereadMilliseconds();
			if (current !== milliseconds) {
				arm(current);
			}
			wake();
		}, milliseconds);
		state.timer.unref();
	};

	const join = (stream: LiveStream): boolean => {
		if (state.stopped) {
			return false;
		}
		if (state.live.size > 0 && stream.epoch !== state.epoch) {
			endEveryStream();
		}
		if (state.position === undefined) {
			state.epoch = stream.epoch;
			state.position = stream.scannedThrough();
			arm(rereadMilliseconds());
		}
		if (stream.scannedThrough() < state.position) {
			return false;
		}
		state.live.add(stream);
		return true;
	};

	return {
		join,

		leave: (stream) => {
			if (state.live.delete(stream) && state.live.size === 0) {
				rest();
			}
		},

		position: () => state.position,

		stop: async () => {
			state.stopped = true;
			rest();
			await state.reading;
		},

		wake,
	};
};
