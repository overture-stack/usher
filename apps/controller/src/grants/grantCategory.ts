import { GRANT_PROBLEMS } from './grantProblems.js';
import { refuseWithin } from './operationOutcome.js';
import type { GrantStore, StoredRole } from './types.js';

/** The record category a grant of a role names, before the resource is read. */
export type CategoryNaming = { kind: 'named'; scopedName: string; submitter: boolean } | { kind: 'wholeResource' };

/**
 * The record category a grant of a role names, judged inside its change's transaction: a
 * control-plane role takes the whole resource and is refused 422 `wholeResourceRole` for naming a
 * category; a data-plane role names one, the `submitter` role taking the instance's submitter
 * category when it names none, and any other data-plane role naming none is refused 422
 * `categoryRequired`.
 *
 * @param role the role granted.
 * @param named the scoped category the request names, or none.
 * @param submitterCategory the instance's submitter category.
 */
export const categoryNamingOf = (
	role: StoredRole,
	named: string | undefined,
	submitterCategory: string,
): CategoryNaming => {
	if (role.plane === 'control') {
		return named === undefined ? { kind: 'wholeResource' } : refuseWithin(GRANT_PROBLEMS.wholeResourceRole);
	}
	if (named !== undefined) {
		return { kind: 'named', scopedName: named, submitter: false };
	}
	return role.name === 'submitter'
		? { kind: 'named', scopedName: submitterCategory, submitter: true }
		: refuseWithin(GRANT_PROBLEMS.categoryRequired);
};

/**
 * The category a naming names that a resource offers, read in a change's transaction: `null` for
 * the whole resource; a category the resource does not offer is refused 422 `categoryNotOffered`,
 * the submitter category's refusal saying it was the instance's.
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
		: {
				id:
					(await grants.findOfferedCategory(naming.scopedName, resourceId)) ??
					refuseWithin(
						naming.submitter
							? GRANT_PROBLEMS.submitterCategoryNotOffered
							: GRANT_PROBLEMS.categoryNotOffered,
					),
				scopedName: naming.scopedName,
			};
