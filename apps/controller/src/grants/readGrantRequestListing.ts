import type { Problem } from '../http/index.js';
import { type InputContext, type InputReading, unreadableQuery } from '../managementApi/index.js';
import { GRANT_PROBLEMS } from './grantProblems.js';
import type { GrantRequestListing } from './types.js';

/** The most requests on a page of the listing when the query names no page size. */
export const REQUEST_PAGE_DEFAULT = 100;

/** The most requests on any page of the listing: a larger page size is answered with this many. */
export const REQUEST_PAGE_MAXIMUM = 1000;

const PARAMETERS = Object.freeze(['cursor', 'limit']);

// A whole number in digits, of either sign, so a page size below 1 is told from one that is no
// number.
const WHOLE_NUMBER = /^-?[0-9]+$/u;

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

// A request's id as the store writes it, in lower case.
const REQUEST_ID_FORM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * The cursor of the page after the one ending with a request: its id, as unpadded base64url of its
 * text.
 *
 * @param requestId the id of the last request on the page.
 */
export const cursorAfterRequest = (requestId: string): string => Buffer.from(requestId, 'utf8').toString('base64url');

/**
 * The request id a cursor names, read only from the form {@link cursorAfterRequest} writes for an
 * id in the store's form: any other text names none.
 *
 * @param cursor the cursor sent.
 * @returns the id, or `undefined` for a cursor no listing gave.
 */
export const requestIdOfCursor = (cursor: string): string | undefined => {
	if (!BASE64URL.test(cursor)) {
		return undefined;
	}
	const requestId = Buffer.from(cursor, 'base64url').toString('utf8');
	return REQUEST_ID_FORM.test(requestId) && cursorAfterRequest(requestId) === cursor ? requestId : undefined;
};

const refusal = (problem: Problem): InputReading<never> => ({
	kind: 'refused',
	problem,
});

/**
 * Reads the grant request listing's query: `cursor`, as a previous page named it, and `limit`, the
 * page size, {@link REQUEST_PAGE_DEFAULT} when left out and at most {@link REQUEST_PAGE_MAXIMUM}.
 * A parameter not taken, one sent twice, or a value that cannot be read is refused 400
 * `unreadableQuery`, and a page size below 1 422 `pageSizeTooSmall`.
 *
 * @param context the query's parameters.
 */
export const readGrantRequestListing = ({ query }: InputContext): InputReading<GrantRequestListing> => {
	const names = query.map(([name]) => name);
	if (!names.every((name) => PARAMETERS.includes(name))) {
		return refusal(
			unreadableQuery('names a parameter this operation does not take: it takes cursor and limit alone'),
		);
	}
	if (new Set(names).size !== names.length) {
		return refusal(unreadableQuery('names a parameter twice'));
	}
	const value = (name: string): string | undefined => query.find(([sent]) => sent === name)?.[1];
	const cursor = value('cursor');
	const limit = value('limit');
	const after = cursor === undefined ? undefined : requestIdOfCursor(cursor);
	if (cursor !== undefined && after === undefined) {
		return refusal(unreadableQuery('holds a cursor no page named'));
	}
	if (limit !== undefined && !WHOLE_NUMBER.test(limit)) {
		return refusal(unreadableQuery('holds limit as something other than a whole number'));
	}
	const size = limit === undefined ? REQUEST_PAGE_DEFAULT : Number(limit);
	return size < 1
		? refusal(GRANT_PROBLEMS.pageSizeTooSmall)
		: {
				input: { after, limit: Math.min(size, REQUEST_PAGE_MAXIMUM) },
				kind: 'read',
			};
};
