import type { Problem } from '../http/index.js';
import { type InputContext, type InputReading, unreadableQuery } from '../managementApi/index.js';
import { isStorableText } from '../store/index.js';
import { RESOURCE_PROBLEMS } from './resourceProblems.js';
import type { ListingQuery } from './types.js';

/** The most entries on a page of the listing when the query names no page size. */
export const LISTING_PAGE_DEFAULT = 100;

/** The most entries on any page of the listing: a larger page size is answered with this many. */
export const LISTING_PAGE_MAXIMUM = 1000;

const PARAMETERS = Object.freeze(['cursor', 'includeRetired', 'limit']);

// A whole number in digits, of either sign, so a page size below 1 is told from one that is no number.
const WHOLE_NUMBER = /^-?[0-9]+$/u;

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

const refusal = (problem: Problem): InputReading<never> => ({
	kind: 'refused',
	problem,
});

/**
 * Reads the resource listing's query: `cursor`, as a previous page named it; `limit`, the page
 * size, {@link LISTING_PAGE_DEFAULT} when left out and at most {@link LISTING_PAGE_MAXIMUM}; and
 * `includeRetired`, `true` or `false`, false when left out. Judged in turn: a parameter not taken,
 * one sent twice, or a value that cannot be read is refused 400 `unreadableQuery`; `includeRetired`
 * `true` from anyone but a platform administrator 403 `administratorOnly`; and a page size below 1
 * 422 `pageSizeTooSmall`.
 *
 * @param context who calls, and the query's parameters.
 */
export const readListingQuery = ({ principal, query }: InputContext): InputReading<ListingQuery> => {
	const names = query.map(([name]) => name);
	if (!names.every((name) => PARAMETERS.includes(name))) {
		return refusal(
			unreadableQuery(
				'names a parameter this operation does not take: it takes cursor, includeRetired and limit alone',
			),
		);
	}
	if (new Set(names).size !== names.length) {
		return refusal(unreadableQuery('names a parameter twice'));
	}
	const value = (name: string): string | undefined => query.find(([sent]) => sent === name)?.[1];
	const cursor = value('cursor');
	const limit = value('limit');
	const includeRetired = value('includeRetired');
	const after = cursor === undefined ? undefined : externalIdOfCursor(cursor);
	if (cursor !== undefined && after === undefined) {
		return refusal(unreadableQuery('holds a cursor no page named'));
	}
	if (limit !== undefined && !WHOLE_NUMBER.test(limit)) {
		return refusal(unreadableQuery('holds limit as something other than a whole number'));
	}
	const retired = ((): boolean | undefined => {
		if (includeRetired === undefined || includeRetired === 'false') {
			return false;
		}
		return includeRetired === 'true' ? true : undefined;
	})();
	if (retired === undefined) {
		return refusal(unreadableQuery('holds includeRetired as something other than true or false'));
	}
	if (retired && !principal.administrator) {
		return refusal(RESOURCE_PROBLEMS.retiredListedToAdministrators);
	}
	const size = limit === undefined ? LISTING_PAGE_DEFAULT : Number(limit);
	return size < 1
		? refusal(RESOURCE_PROBLEMS.pageSizeTooSmall)
		: {
				input: {
					after,
					includeRetired: retired,
					limit: Math.min(size, LISTING_PAGE_MAXIMUM),
				},
				kind: 'read',
			};
};
