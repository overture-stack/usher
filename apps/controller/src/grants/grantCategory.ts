import type { Problem } from '../http/index.js';
import { GRANT_PROBLEMS } from './grantProblems.js';
import { refuseWithin } from './operationOutcome.js';
import { atCategory } from './readCategories.js';
import type { GrantStore, StoredRole } from './types.js';

/**
 * The record category one grant of a role names, before the resource is read, with its place in the
 * request's `categories` where the request named it.
 */
export type CategoryNaming =
	{ index: number | undefined; kind: 'named'; scopedName: string; submitter: boolean } | { kind: 'wholeResource' };

/**
 * The record categories the grants of a role name, one grant each, judged inside its change's
 * transaction: a control-plane role takes the whole resource, one grant, and is refused 422
 * `wholeResourceRole` for naming categories; a data-plane role takes each category named, in order,
 * the `submitter` role taking the instance's submitter category when it names none, and any other
 * data-plane role naming none is refused 422 `categoryRequired`.
 *
 * @param role the role granted.
 * @param named the scoped categories the request names, or none.
 * @param submitterCategory the instance's submitter category.
 */
export const categoryNamingsOf = (
	role: StoredRole,
	named: readonly string[] | undefined,
	submitterCategory: string,
): readonly CategoryNaming[] => {
	if (role.plane === 'control') {
		return named === undefined ? [{ kind: 'wholeResource' }] : refuseWithin(GRANT_PROBLEMS.wholeResourceRole);
	}
	if (named !== undefined) {
		return named.map((scopedName, index) => ({ index, kind: 'named', scopedName, submitter: false }));
	}
	return role.name === 'submitter'
		? [{ index: undefined, kind: 'named', scopedName: submitterCategory, submitter: true }]
		: refuseWithin(GRANT_PROBLEMS.categoryRequired);
};

/**
 * The category a naming names that a resource offers, read in a change's transaction, under the
 * scoped name it was registered as whatever letter case the naming used: `null` for the whole
 * resource; a category the resource does not offer is refused 422 `categoryNotOffered`, naming its
 * place in `categories`, the submitter category's refusal saying it was the instance's.
 *
 * @param grants the grant store, on the change's connection.
 * @param naming the category named.
 * @param resourceId the resource's id.
 */
export const offeredCategory = async (
	grants: Pick<GrantStore, 'findOfferedCategory'>,
	naming: CategoryNaming,
	resourceId: string,
): Promise<{ id: string; scopedName: string } | null> =>
	naming.kind === 'wholeResource'
		? null
		: ((await grants.findOfferedCategory(naming.scopedName, resourceId)) ??
			refuseWithin(
				naming.submitter
					? GRANT_PROBLEMS.submitterCategoryNotOffered
					: atCategory(GRANT_PROBLEMS.categoryNotOffered, naming.index ?? 0),
			));

/**
 * A refusal of one category's grant, naming its place in `categories` where the request named it.
 *
 * @param refusal the problem.
 * @param naming the category the grant names.
 */
export const forCategory = (refusal: Problem, naming: CategoryNaming): Problem =>
	naming.kind === 'named' && naming.index !== undefined ? atCategory(refusal, naming.index) : refusal;
