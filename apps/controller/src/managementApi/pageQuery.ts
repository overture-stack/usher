import type { Problem } from '../http/index.js';
import { PROBLEMS, unreadableQuery } from './problems.js';
import type { InputContext, InputReading } from './types.js';

/** What a listing's query reads: where its page begins, its size, and what withheld it includes. */
export interface PageQuery {
	/** The key the page begins after, for a page after the first. */
	after: string | undefined;

	/** Whether a platform administrator asked for the entries the listing withholds by default. */
	includesWithheld: boolean;

	/** The most entries on the page. */
	limit: number;
}

/** How one listing reads its page query. */
export interface PageRules {
	/**
	 * The key a cursor names, read only from the form the listing writes its cursors in.
	 *
	 * @param cursor the cursor sent.
	 * @returns the key, or `undefined` for text no page of the listing named.
	 */
	afterOf(cursor: string): string | undefined;

	/** The most entries on a page when the query names no page size. */
	defaultSize: number;

	/** The most entries on any page: a larger page size is answered with this many. */
	maximumSize: number;

	/**
	 * The parameter asking for the entries the listing withholds by default, which a platform
	 * administrator alone sends `true`, and the refusal of anyone else sending it so; none for a
	 * listing withholding nothing.
	 */
	withheld?: { parameter: string; refusal: Problem };
}

// A whole number in digits, of either sign, so a page size below 1 is told from one that is no
// number.
const WHOLE_NUMBER = /^-?[0-9]+$/u;

const refusal = (problem: Problem): InputReading<never> => ({
	kind: 'refused',
	problem,
});

// Names in a sentence: `a and b`, or `a, b and c`.
const sentenceList = (names: readonly string[]): string =>
	names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;

/**
 * Reads a listing's page query: `cursor`, as a previous page named it; `limit`, the page size, the
 * rules' default when left out and at most their maximum; and, for a listing withholding entries by
 * default, its parameter, `true` or `false`, false when left out. Judged in turn: a parameter not
 * taken, one sent twice, or a value that cannot be read is refused 400 `unreadableQuery`; the
 * withheld entries asked for by anyone but a platform administrator, with the rules' refusal; and a
 * page size below 1, 422 `pageSizeTooSmall`.
 *
 * @param context who calls, and the query's parameters.
 * @param rules what the listing's cursors name, its page sizes, and the entries it withholds.
 */
export const readPageQuery = (
	{ principal, query }: InputContext,
	{ afterOf, defaultSize, maximumSize, withheld }: PageRules,
): InputReading<PageQuery> => {
	const taken = ['cursor', 'limit', ...(withheld === undefined ? [] : [withheld.parameter])].toSorted();
	const names = query.map(([name]) => name);
	if (!names.every((name) => taken.includes(name))) {
		return refusal(
			unreadableQuery(`names a parameter this operation does not take: it takes ${sentenceList(taken)} alone`),
		);
	}
	if (new Set(names).size !== names.length) {
		return refusal(unreadableQuery('names a parameter twice'));
	}
	const value = (name: string): string | undefined => query.find(([sent]) => sent === name)?.[1];
	const cursor = value('cursor');
	const limit = value('limit');
	const asked = withheld === undefined ? undefined : value(withheld.parameter);
	const after = cursor === undefined ? undefined : afterOf(cursor);
	if (cursor !== undefined && after === undefined) {
		return refusal(unreadableQuery('holds a cursor no page named'));
	}
	if (limit !== undefined && !WHOLE_NUMBER.test(limit)) {
		return refusal(unreadableQuery('holds limit as something other than a whole number'));
	}
	const includesWithheld = ((): boolean | undefined => {
		if (asked === undefined || asked === 'false') {
			return false;
		}
		return asked === 'true' ? true : undefined;
	})();
	if (includesWithheld === undefined) {
		return refusal(unreadableQuery(`holds ${withheld?.parameter ?? ''} as something other than true or false`));
	}
	if (withheld !== undefined && includesWithheld && !principal.administrator) {
		return refusal(withheld.refusal);
	}
	const size = limit === undefined ? defaultSize : Number(limit);
	return size < 1
		? refusal(PROBLEMS.pageSizeTooSmall)
		: {
				input: {
					after,
					includesWithheld,
					limit: Math.min(size, maximumSize),
				},
				kind: 'read',
			};
};

/**
 * One page of a listing cut from what was read for it, which holds one entry more than the page
 * when another page follows: the entries up to the page size, and the cursor after the last of
 * them when another follows, or `null`.
 *
 * @param read the entries read, in the listing's order.
 * @param limit the most entries on the page.
 * @param cursorOf the cursor naming the page after the one ending with an entry.
 */
export const pageOf = <Entry>(
	read: readonly Entry[],
	limit: number,
	cursorOf: (last: Entry) => string,
): { entries: readonly Entry[]; next: string | null } => {
	const entries = read.slice(0, limit);
	const last = entries.at(-1);
	return {
		entries,
		next: read.length > entries.length && last !== undefined ? cursorOf(last) : null,
	};
};
