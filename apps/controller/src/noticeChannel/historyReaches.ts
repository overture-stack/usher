import type { NoticePage, StreamPlace } from './types.js';

/**
 * Whether history still reaches a place, judged against a page read after its position: the place
 * belongs to the page's epoch, is not below the trim watermark, and either the notice stored at its
 * position is the one it was read from, created at the same instant, or no notice is stored there and
 * it is the watermark itself. A place below the watermark lost notices to trimming; one above it with
 * no notice stored is ahead of head, or lost to a restore; and one whose notice was created at another
 * instant names a position a restore gave to a later notice.
 *
 * @param place the place a cursor carries.
 * @param page a page read after the place's position.
 */
export const historyReaches = (
	{ createdAt, epoch, position }: StreamPlace,
	{ createdAtPosition, epoch: currentEpoch, trimmedThrough }: NoticePage,
): boolean => {
	if (epoch !== currentEpoch || position < trimmedThrough) {
		return false;
	}
	return createdAtPosition === undefined ? position === trimmedThrough : createdAt === createdAtPosition;
};
