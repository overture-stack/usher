import type { Problem } from '../http/index.js';
import { maySee } from '../resourceStanding/index.js';
import { GRANT_PROBLEMS } from './grantProblems.js';
import type {
	GrantAuthority,
	GrantAuthorityQuestion,
	SelfGrantAuthority,
	SelfGrantAuthorityQuestion,
} from './types.js';

// The roles a platform administrator grants on any resource.
const ADMINISTRATOR_GRANTED_ROLES: ReadonlySet<string> = new Set(['owner', 'submitter']);

const refuse = (problem: Problem, recordedReason?: string): GrantAuthority => ({
	kind: 'refuse',
	problem,
	...(recordedReason === undefined ? {} : { recordedReason }),
});

/**
 * Decides whether a caller may issue a grant, judging in turn: a platform administrator naming
 * themself an owner is refused 403 `administratorSelfOwnership`; anyone naming themself is refused
 * 422 `selfNamed`; a platform administrator granting a role other than `submitter` and `owner` is
 * refused 403 `administratorGrantsNoConsumerAccess`, alike whether or not the resource exists; a
 * resource that does not exist, or is retired, is refused 404 `resourceNotFound`, and so is one the
 * caller may not see, its event recording `noAuthorityOnResource`. A platform administrator, and a
 * counted owner of the resource, issue the grant; anyone else is refused 403
 * `noAuthorityOnResource`.
 *
 * @param question whether the caller is a platform administrator and is the holder named, the role,
 *   and where the caller stands on the resource.
 */
export const grantAuthority = ({
	administrator,
	holderIsCaller,
	role,
	standing,
}: GrantAuthorityQuestion): GrantAuthority => {
	if (administrator && holderIsCaller && role === 'owner') {
		return refuse(GRANT_PROBLEMS.administratorSelfOwnership);
	}
	if (holderIsCaller) {
		return refuse(GRANT_PROBLEMS.selfNamed);
	}
	if (administrator && !ADMINISTRATOR_GRANTED_ROLES.has(role)) {
		return refuse(GRANT_PROBLEMS.administratorGrantsNoConsumerAccess);
	}
	if (standing === undefined || standing.retired) {
		return refuse(GRANT_PROBLEMS.resourceNotFound);
	}
	if (!maySee(standing, { administrator, asksForRetired: false })) {
		return refuse(GRANT_PROBLEMS.resourceNotFound, GRANT_PROBLEMS.noAuthorityOnResource.code);
	}
	return administrator || standing.countedOwner ? { kind: 'issue' } : refuse(GRANT_PROBLEMS.noAuthorityOnResource);
};

/**
 * Decides how a caller's self-grant is answered, judging in turn: a resource that does not exist,
 * or is retired, is refused 404 `resourceNotFound`, and so is one the caller may not see, its event
 * recording `noAuthorityOnResource`. A counted owner of the resource, a platform administrator
 * among them, is issued the grant at once; any other platform administrator asks for it, as a
 * request someone else decides; anyone else is refused 403 `noAuthorityOnResource`.
 *
 * @param question whether the caller is a platform administrator, and where they stand on the
 *   resource.
 */
export const selfGrantAuthority = ({ administrator, standing }: SelfGrantAuthorityQuestion): SelfGrantAuthority => {
	if (standing === undefined || standing.retired) {
		return { kind: 'refuse', problem: GRANT_PROBLEMS.resourceNotFound };
	}
	if (!maySee(standing, { administrator, asksForRetired: false })) {
		return {
			kind: 'refuse',
			problem: GRANT_PROBLEMS.resourceNotFound,
			recordedReason: GRANT_PROBLEMS.noAuthorityOnResource.code,
		};
	}
	if (standing.countedOwner) {
		return { kind: 'issue' };
	}
	return administrator ? { kind: 'request' } : { kind: 'refuse', problem: GRANT_PROBLEMS.noAuthorityOnResource };
};
