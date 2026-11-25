import type { Problem } from '../http/index.js';
import { unreadableBody } from '../managementApi/index.js';
import { GRANT_PROBLEMS } from './grantProblems.js';

/**
 * A refusal naming the category at fault by its place in the request's `categories`, counted from
 * 0, so the answer points at it without repeating a value the request carried.
 *
 * @param refusal the problem.
 * @param index the category's place in `categories`.
 */
export const atCategory = (refusal: Problem, index: number): Problem =>
	Object.freeze({ ...refusal, categoryIndex: index });

/**
 * Whether a body's `categories` is out of its shape: present and anything but a list of one or more
 * strings.
 *
 * @param body the body's object.
 */
export const categoriesShapeProblem = (body: Readonly<Record<string, unknown>>): Problem | undefined => {
	if (!Object.hasOwn(body, 'categories')) {
		return undefined;
	}
	const categories = body['categories'];
	if (!Array.isArray(categories) || !categories.every((category) => typeof category === 'string')) {
		return unreadableBody('holds categories as something other than a list of strings');
	}
	return categories.length === 0 ? unreadableBody('holds categories as an empty list') : undefined;
};

/**
 * The categories a body names, as sent and in order; none when it names none.
 *
 * @param body the body's object, its shape already judged.
 */
export const categoriesOf = (body: Readonly<Record<string, unknown>>): readonly string[] | undefined => {
	const categories = body['categories'];
	return Array.isArray(categories) ? categories.filter((category) => typeof category === 'string') : undefined;
};

/**
 * The refusal of a category named twice, in any letter case, since category names are unique in any
 * case, naming the first repeat by its place; none when each is named once.
 *
 * @param categories the categories named.
 */
export const repeatedCategory = (categories: readonly string[] | undefined): Problem | undefined => {
	const folded = (categories ?? []).map((category) => category.toLowerCase());
	const index = folded.findIndex((category, place) => folded.indexOf(category) !== place);
	return index === -1 ? undefined : atCategory(GRANT_PROBLEMS.duplicateCategory, index);
};
