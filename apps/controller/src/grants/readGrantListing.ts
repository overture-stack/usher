import { type InputContext, type InputReading, readPageQuery } from '../managementApi/index.js';
import { GRANT_PROBLEMS } from './grantProblems.js';
import { idOfCursor } from './idCursor.js';
import { readAddressLookup } from './readAddressLookup.js';
import type { GrantListing, PersonGrantListing } from './types.js';

/** The most grants on a page of a grant listing when the query names no page size. */
export const GRANT_PAGE_DEFAULT = 100;

/** The most grants on any page of a grant listing: a larger size is answered with this many. */
export const GRANT_PAGE_MAXIMUM = 1000;

/**
 * Reads a grant listing's query, as {@link readPageQuery} reads a listing's: `cursor`, as a
 * previous page named it; `limit`, the page size, {@link GRANT_PAGE_DEFAULT} when left out and at
 * most {@link GRANT_PAGE_MAXIMUM}; and `includeRevoked`, `true` or `false`, false when left out,
 * and refused to anyone but a platform administrator sending it `true` 403 `administratorOnly`.
 *
 * @param context who calls, and the query's parameters.
 */
export const readGrantListing = (context: InputContext): InputReading<GrantListing> => {
	const reading = readPageQuery(context, {
		afterOf: idOfCursor,
		defaultSize: GRANT_PAGE_DEFAULT,
		maximumSize: GRANT_PAGE_MAXIMUM,
		withheld: {
			parameter: 'includeRevoked',
			refusal: GRANT_PROBLEMS.revokedListedToAdministrators,
		},
	});
	return reading.kind === 'read'
		? {
				input: {
					after: reading.input.after,
					includeRevoked: reading.input.includesWithheld,
					limit: reading.input.limit,
				},
				kind: 'read',
			}
		: reading;
};

/**
 * Reads a listing of a person's grants: its body with {@link readAddressLookup}, then its query
 * with {@link readGrantListing}, the body's refusal answered first.
 *
 * @param body the body's object, or none for a request sending none.
 * @param context who calls, and the query's parameters.
 */
export const readPersonGrantListing = (
	body: Readonly<Record<string, unknown>> | undefined,
	context: InputContext,
): InputReading<PersonGrantListing> => {
	const lookup = readAddressLookup(body);
	if (lookup.kind === 'refused') {
		return lookup;
	}
	const listing = readGrantListing(context);
	return listing.kind === 'read' ? { input: { ...lookup.input, ...listing.input }, kind: 'read' } : listing;
};
