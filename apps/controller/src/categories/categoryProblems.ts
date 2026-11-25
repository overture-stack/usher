import { problem, type Problem } from '../http/index.js';

/** The refusals the category operations answer, beside those every Management API operation may. */
export const CATEGORY_PROBLEMS = Object.freeze({
	categoryNotFound: problem(
		'categoryNotFound',
		404,
		'Category not found',
		'No global category has the scoped name given. GET /admin/categories lists each global category by its scoped name.',
	),
	invalidCategoryName: problem(
		'invalidCategoryName',
		422,
		'Category name not accepted',
		'A name is not empty, and holds only letters, digits, underscores and hyphens. Two names are reserved, in any letter case: unmarked, the category of records matching no other, and __proto__.',
	),
	memberNotSettable: problem(
		'memberNotSettable',
		422,
		'Member not settable',
		'The update names a member it may not set. Only description can be changed; a category keeps the name it was registered under.',
	),
	ownersAndAdministratorsOnly: problem(
		'ownersAndAdministratorsOnly',
		403,
		'For owners and administrators alone',
		'This operation is for platform administrators, and for principals who own at least one resource.',
	),
} satisfies Readonly<Record<string, Problem>>);

/**
 * The refusal of a registration whose name a global category already holds in some letter case, naming that
 * category by the scoped spelling it was registered under.
 *
 * @param existing the scoped name of the category holding the name.
 */
export const categoryAlreadyExists = (existing: string): Problem =>
	problem(
		'alreadyExists',
		409,
		'Category already exists',
		`The global category ${existing} holds that name, in some letter case, so choose another name.`,
	);
