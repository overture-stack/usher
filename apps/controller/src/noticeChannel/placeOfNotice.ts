import type { StoredNotice, StreamPlace } from './types.js';

/**
 * The place a stored notice holds, as its cursor carries it.
 *
 * @param epoch the epoch it was read in.
 * @param notice the notice.
 */
export const placeOfNotice = (
  epoch: string,
  { createdAt, position }: Pick<StoredNotice, 'createdAt' | 'position'>,
): StreamPlace => ({ createdAt, epoch, position });
