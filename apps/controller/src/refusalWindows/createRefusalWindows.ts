import type { Clock } from '../configuration/index.js';
import type { ClosedWindow, RefusalKey, RefusalWindows, WindowCount } from './types.js';

/** How long a window stays open with no refusal under its key, in milliseconds of the clock: 10 minutes. */
export const REFUSAL_WINDOW_COOLDOWN_MILLISECONDS = 600_000;

/** How long after it opened a window closes, whatever refusals come, in milliseconds of the clock: 60 minutes. */
export const REFUSAL_WINDOW_CEILING_MILLISECONDS = 3_600_000;

/** The most windows one instance holds open for single tokens at once. */
export const PER_TOKEN_WINDOW_LIMIT = 10_000;

interface OpenWindow {
	count: number;
	firstSeenAt: number;
	key: RefusalKey;
	lastSeenAt: number;

	/** Whether it counts the refusals of one token, and so takes a place under the cap. */
	perToken: boolean;

	window: number;
}

// A key's parts joined by newlines, none of which a part holds, so equal keys name one window. A
// per-token key, an overflow key and a key of credentials that did not verify never name the same
// window, even for one route and reason.
const nameOf = (key: RefusalKey, kind: 'overflow' | 'perToken' | 'unverified'): string =>
	[key.route, kind, key.reason, key.applicationId ?? '', key.tokenDigest ?? ''].join('\n');

const closedOf = ({ count, firstSeenAt, key, lastSeenAt, window }: OpenWindow): ClosedWindow => ({
	count,
	firstSeenAt,
	key,
	lastSeenAt,
	window,
});

/**
 * Creates one instance's windows, held in memory alone, every instant read from the clock given. A
 * window opens at its key's first refusal, and counts that refusal and every later one under its key
 * until it closes: once its key has gone {@link REFUSAL_WINDOW_COOLDOWN_MILLISECONDS} without a refusal, or
 * {@link REFUSAL_WINDOW_CEILING_MILLISECONDS} after it opened, whichever comes first. The next
 * refusal under a closed window's key opens a new one. At most {@link PER_TOKEN_WINDOW_LIMIT} windows
 * counting one token's refusals are open at once; a refusal of a token with none open past that,
 * once every window due has closed and freed its place, is counted in an overflow window for its
 * route and reason, which opens and closes as any other does. A window of credentials that did not
 * verify takes no place under the cap, since the reasons and applications keying it are few.
 *
 * @param clock the clock each window is measured on.
 */
export const createRefusalWindows = (clock: Clock): RefusalWindows => {
	// One entry per open window, in the order they opened, changed in place: at the cap a copy per
	// refusal would cost ten thousand entries each time. Never exposed, so no caller sees it change.
	const open = new Map<string, OpenWindow>();
	const state = { lastWindow: 0, perTokenOpen: 0 };

	const isDue = ({ firstSeenAt, lastSeenAt }: OpenWindow, now: number): boolean =>
		now - lastSeenAt >= REFUSAL_WINDOW_COOLDOWN_MILLISECONDS ||
		now - firstSeenAt >= REFUSAL_WINDOW_CEILING_MILLISECONDS;

	const close = (name: string, window: OpenWindow): ClosedWindow => {
		open.delete(name);
		state.perTokenOpen -= window.perToken ? 1 : 0;
		return closedOf(window);
	};

	const closeDueAt = (now: number): readonly ClosedWindow[] =>
		[...open].filter(([, window]) => isDue(window, now)).map(([name, window]) => close(name, window));

	// Opens a window under a name, or counts the refusal in the one open there, closing it first when
	// it is due.
	const countUnder = (
		name: string,
		key: RefusalKey,
		{ now, perToken }: { now: number; perToken: boolean },
	): WindowCount => {
		const current = open.get(name);
		if (current !== undefined && !isDue(current, now)) {
			open.set(name, { ...current, count: current.count + 1, lastSeenAt: now });
			return { closed: [], kind: 'counted' };
		}
		const closed = current === undefined ? [] : [close(name, current)];
		state.lastWindow += 1;
		state.perTokenOpen += perToken ? 1 : 0;
		open.set(name, {
			count: 1,
			firstSeenAt: now,
			key,
			lastSeenAt: now,
			perToken,
			window: state.lastWindow,
		});
		return { closed, kind: 'opened', window: state.lastWindow };
	};

	const countPerToken = (key: RefusalKey, now: number): WindowCount => {
		const name = nameOf(key, 'perToken');
		if (open.has(name) || state.perTokenOpen < PER_TOKEN_WINDOW_LIMIT) {
			return countUnder(name, key, { now, perToken: true });
		}
		const freed = closeDueAt(now);
		if (state.perTokenOpen < PER_TOKEN_WINDOW_LIMIT) {
			const counted = countUnder(name, key, { now, perToken: true });
			return { ...counted, closed: [...freed, ...counted.closed] };
		}
		const overflowKey: RefusalKey = { reason: key.reason, route: key.route };
		const counted = countUnder(nameOf(overflowKey, 'overflow'), overflowKey, {
			now,
			perToken: false,
		});
		return { ...counted, closed: [...freed, ...counted.closed] };
	};

	return {
		closeAll: () => [...open].map(([name, window]) => close(name, window)),
		closeDue: () => closeDueAt(clock.now()),
		count: (key) => {
			const now = clock.now();
			return key.tokenDigest === undefined
				? countUnder(nameOf(key, 'unverified'), key, { now, perToken: false })
				: countPerToken(key, now);
		},
	};
};
