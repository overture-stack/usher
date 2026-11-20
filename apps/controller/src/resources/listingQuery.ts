import { type InputContext, type InputReading, readPageQuery } from '../managementApi/index.js';
import { isStorableText } from '../store/index.js';
import { RESOURCE_PROBLEMS } from './resourceProblems.js';
import type { ListingQuery } from './types.js';

/** The most entries on a page of the listing when the query names no page size. */
export const LISTING_PAGE_DEFAULT = 100;

/** The most entries on any page of the listing: a larger page size is answered with this many. */
export const LISTING_PAGE_MAXIMUM = 1000;

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

/**
 * The cursor of the page after the one ending with a resource: its externalId, as unpadded base64url
 * of its UTF-8 form.
 *
 * @param externalId the externalId of the last resource on the page.
 */
export const cursorAfter = (externalId: string): string => Buffer.from(externalId, 'utf8').toString('base64url');

/**
 * The externalId a cursor names, read only from the form {@link cursorAfter} writes: any other text
 * names none.
 *
 * @param cursor the cursor sent.
 * @returns the externalId, or `undefined` for a cursor no listing gave.
 */
export const externalIdOfCursor = (cursor: string): string | undefined => {
	if (!BASE64URL.test(cursor)) {
		return undefined;
	}
	const externalId = Buffer.from(cursor, 'base64url').toString('utf8');
	return isStorableText(externalId) && cursorAfter(externalId) === cursor ? externalId : undefined;
};

/**
 * Reads the resource listing's query, as {@link readPageQuery} reads a listing's: `cursor`, as a
 * previous page named it; `limit`, the page size, {@link LISTING_PAGE_DEFAULT} when left out and at
 * most {@link LISTING_PAGE_MAXIMUM}; and `includeRetired`, `true` or `false`, false when left out,
 * and refused to anyone but a platform administrator sending it `true` 403 `administratorOnly`.
 *
 * @param context who calls, and the query's parameters.
 */
export const readListingQuery = (context: InputContext): InputReading<ListingQuery> => {
	const reading = readPageQuery(context, {
		afterOf: externalIdOfCursor,
		defaultSize: LISTING_PAGE_DEFAULT,
		maximumSize: LISTING_PAGE_MAXIMUM,
		withheld: {
			parameter: 'includeRetired',
			refusal: RESOURCE_PROBLEMS.retiredListedToAdministrators,
		},
	});
	return reading.kind === 'read'
		? {
				input: {
					after: reading.input.after,
					includeRetired: reading.input.includesWithheld,
					limit: reading.input.limit,
				},
				kind: 'read',
			}
		: reading;
};
