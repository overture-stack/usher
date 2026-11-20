import { type InputContext, type InputReading, readPageQuery } from '../managementApi/index.js';
import { idOfCursor } from './idCursor.js';
import type { GrantRequestListing } from './types.js';

/** The most requests on a page of the listing when the query names no page size. */
export const REQUEST_PAGE_DEFAULT = 100;

/** The most requests on any page of the listing: a larger page size is answered with this many. */
export const REQUEST_PAGE_MAXIMUM = 1000;

/**
 * Reads the grant request listing's query, as {@link readPageQuery} reads a listing's: `cursor`, as
 * a previous page named it, and `limit`, the page size, {@link REQUEST_PAGE_DEFAULT} when left out
 * and at most {@link REQUEST_PAGE_MAXIMUM}.
 *
 * @param context who calls, and the query's parameters.
 */
export const readGrantRequestListing = (context: InputContext): InputReading<GrantRequestListing> => {
	const reading = readPageQuery(context, {
		afterOf: idOfCursor,
		defaultSize: REQUEST_PAGE_DEFAULT,
		maximumSize: REQUEST_PAGE_MAXIMUM,
	});
	return reading.kind === 'read'
		? {
				input: { after: reading.input.after, limit: reading.input.limit },
				kind: 'read',
			}
		: reading;
};
