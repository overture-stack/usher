import type { Directory } from '../directory/index.js';
import { GRANT_PROBLEMS, type NamedHolder, unresolvedByDirectory } from '../grants/index.js';
import type { OperationOutcome } from '../managementApi/index.js';
import { RESOURCE_PROBLEMS } from './resourceProblems.js';

/** A registration's owners by subject, in the order named, or the outcome refusing them. */
export type OwnerSubjects =
	{ kind: 'refused'; outcome: OperationOutcome } | { kind: 'resolved'; subjects: readonly string[] };

const refusedWith = (outcome: OperationOutcome): OwnerSubjects => ({
	kind: 'refused',
	outcome,
});

/**
 * The subjects of a registration's owners, in the order named, each owner named by address resolved
 * through the directory in turn, before the registration's transaction begins. The first address
 * held by no single account is refused 404 `holderNotFound`, and a directory resolving nothing is
 * answered as `unresolvedByDirectory` decides, stopping at either. Once every address resolves, an
 * owner who is the caller is refused 403 `administratorSelfOwnership`, then one person named twice,
 * by a subject and an address or by two addresses, 422 `ownerNamedTwice`.
 *
 * @param directory where each address is resolved.
 * @param owners the owners, as the registration names them.
 * @param callerSubject the subject of the platform administrator registering.
 */
export const ownerSubjects = async (
	directory: Pick<Directory, 'resolveAddress'>,
	owners: readonly NamedHolder[],
	callerSubject: string,
): Promise<OwnerSubjects> => {
	const resolved = await owners.reduce<Promise<OwnerSubjects>>(
		async (earlier, owner) => {
			const named = await earlier;
			if (named.kind === 'refused') {
				return named;
			}
			if (owner.kind === 'subject') {
				return { ...named, subjects: [...named.subjects, owner.subject] };
			}
			const resolution = await directory.resolveAddress(owner.email);
			if (resolution.kind === 'resolved') {
				return { ...named, subjects: [...named.subjects, resolution.subject] };
			}
			return refusedWith(
				resolution.kind === 'unheld'
					? {
							kind: 'refused',
							problem: GRANT_PROBLEMS.holderNotFound,
						}
					: unresolvedByDirectory(resolution, 'ownerBySubject'),
			);
		},
		Promise.resolve({ kind: 'resolved', subjects: [] }),
	);
	if (resolved.kind === 'refused') {
		return resolved;
	}
	const { subjects } = resolved;
	if (subjects.includes(callerSubject)) {
		return refusedWith({
			kind: 'refused',
			problem: GRANT_PROBLEMS.administratorSelfOwnership,
		});
	}
	return new Set(subjects).size < subjects.length
		? refusedWith({
				kind: 'refused',
				problem: RESOURCE_PROBLEMS.ownerNamedTwice,
			})
		: resolved;
};
