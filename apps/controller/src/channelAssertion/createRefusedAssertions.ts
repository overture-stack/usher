import { type Clock, CLOCK_TOLERANCE_MILLISECONDS } from '../configuration/index.js';
import { CHANNEL_ASSERTION_MAXIMUM_LIFETIME_SECONDS } from './createChannelAssertionVerifier.js';
import type { RefusedAssertions } from './types.js';

/**
 * How long an instance remembers a refused assertion, in milliseconds of the configured clock, from
 * its first refusal: the longest an assertion may live, and the clock tolerance.
 */
export const REFUSED_ASSERTION_WINDOW_MILLISECONDS: number =
	CHANNEL_ASSERTION_MAXIMUM_LIFETIME_SECONDS * 1000 + CLOCK_TOLERANCE_MILLISECONDS;

/** The most refused assertions an instance remembers at once. */
export const REFUSED_ASSERTIONS_LIMIT = 10_000;

/**
 * Creates this instance's memory of the assertions it refused after they verified, each known by its
 * signing input's digest and kept for {@link REFUSED_ASSERTION_WINDOW_MILLISECONDS} from its first
 * refusal, at most {@link REFUSED_ASSERTIONS_LIMIT} at once. Entries are held in the order they were
 * remembered, which every one's fixed window makes the order they expire in, so each reading drops
 * the expired ones from the front, costing only what it drops. A clock moved back can put a later
 * expiry ahead of an earlier one, which only delays forgetting what follows it; the limit holds
 * whatever the clock does.
 *
 * @param clock the configured clock each window is measured on.
 */
export const createRefusedAssertions = (clock: Clock): RefusedAssertions => {
	const expiries = new Map<string, number>();
	// Drops the expired entries from the front, stopping at the first one still within its window, so a
	// reading costs only what it drops. A Map deletes the entry being visited safely.
	const pruned = (): void => {
		const now = clock.now();
		for (const [signingInputDigest, expiresAt] of expiries) {
			if (expiresAt > now) {
				break;
			}
			expiries.delete(signingInputDigest);
		}
	};
	return {
		forget: (signingInputDigest) => {
			expiries.delete(signingInputDigest);
		},
		has: (signingInputDigest) => {
			pruned();
			return expiries.has(signingInputDigest);
		},
		isFull: () => {
			pruned();
			return expiries.size >= REFUSED_ASSERTIONS_LIMIT;
		},
		remember: (signingInputDigest) => {
			pruned();
			if (expiries.size < REFUSED_ASSERTIONS_LIMIT) {
				expiries.set(signingInputDigest, clock.now() + REFUSED_ASSERTION_WINDOW_MILLISECONDS);
			}
		},
	};
};
