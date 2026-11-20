import { GRANT_PROBLEMS } from './grantProblems.js';
import type { GrantChangeJudgement, GrantChangeQuestion, StoredRole } from './types.js';

// The roles within which a platform administrator who is not a counted owner extends or widens a
// grant someone else holds.
const ADMINISTRATOR_EXTENDED_ROLES: ReadonlySet<string> = new Set(['owner', 'submitter']);

// An end as an instant to compare, `null` lasting forever.
const endOf = (expiresAt: Date | null): number => (expiresAt === null ? Number.POSITIVE_INFINITY : expiresAt.getTime());

const endMovement = (before: Date | null, after: Date | null): 'earlier' | 'kept' | 'later' => {
	if (endOf(after) > endOf(before)) {
		return 'later';
	}
	return endOf(after) < endOf(before) ? 'earlier' : 'kept';
};

const roleMovement = (before: StoredRole, after: StoredRole): 'kept' | 'narrower' | 'wider' => {
	if (after.id === before.id) {
		return 'kept';
	}
	return after.capabilities.every((capability) => before.capabilities.includes(capability)) ? 'narrower' : 'wider';
};

const refuse = (problem: Extract<GrantChangeJudgement, { kind: 'refuse' }>['problem']): GrantChangeJudgement => ({
	kind: 'refuse',
	problem,
});

/**
 * Judges a grant's change, in turn: a revoked grant is refused 409 `doesNotHold`, and one a newer
 * grant on its terms replaced 409 `grantReplaced`; a role the instance does not define 422
 * `unknownRole`, and one of the other plane 422 `roleInOtherPlane`, so a data-plane grant keeps its
 * category and a control-plane one the whole resource; an expiry on an owner grant 422
 * `ownerGrantsDoNotExpire`; a self-grant's expiry removed 422 `selfGrantExpiryRequired`, and an end
 * named for it past the longest self-grant life of its request 422 `selfGrantTooLong`; and a
 * counted owner extending or widening a grant they hold 422 `selfGrantExpiryRequired` unless the
 * grant as changed carries an expiry, and 422 `selfGrantTooLong` unless that expiry falls within
 * the longest self-grant life of the change's instant. A platform administrator who is not a
 * counted owner of the resource is then refused 403 `selfWideningNotPermitted` for extending or
 * widening a grant they hold, whatever its role, and 403 `administratorGrantsNoConsumerAccess` for
 * extending or widening any other grant unless its role and its new role are each `submitter` or
 * `owner`.
 *
 * A change extends a grant when it moves its end later or removes it, and widens it when its new
 * role confers anything the grant's role did not; any other new role narrows it. Ending a grant
 * earlier and narrowing its role meet none of the limits on extending or widening one.
 *
 * @param question the caller's authority, whether they hold the grant, the change, the grant as it
 *   stands, the new role, the longest a self-grant lives and the change's instant.
 */
export const judgeGrantChange = ({
	authority,
	change,
	current,
	holderIsCaller,
	maximumSeconds,
	newRole,
	now,
}: GrantChangeQuestion): GrantChangeJudgement => {
	if (current.revokedAt !== null) {
		return refuse(GRANT_PROBLEMS.revokedGrantUnchanged);
	}
	if (current.endedAt !== null) {
		return refuse(GRANT_PROBLEMS.grantReplaced);
	}
	if (change.role !== undefined && newRole === undefined) {
		return refuse(GRANT_PROBLEMS.unknownRole);
	}
	const role = newRole ?? current.role;
	if (role.plane !== current.role.plane) {
		return refuse(GRANT_PROBLEMS.roleInOtherPlane);
	}
	const expiresAt = change.expiresAt === undefined ? current.expiresAt : change.expiresAt;
	if (role.name === 'owner' && expiresAt !== null) {
		return refuse(GRANT_PROBLEMS.ownerGrantsDoNotExpire);
	}
	const endMoved = endMovement(current.expiresAt, expiresAt);
	const roleMoved = roleMovement(current.role, role);
	const extendsOrWidens = endMoved === 'later' || roleMoved === 'wider';
	const selfWidening = holderIsCaller && extendsOrWidens;
	const ownerSelfWidening = authority === 'owner' && selfWidening;
	const since = current.selfGrantSince;
	if ((since !== null && change.expiresAt === null) || (ownerSelfWidening && expiresAt === null)) {
		return refuse(GRANT_PROBLEMS.selfGrantExpiryRequired);
	}
	const lifeMilliseconds = maximumSeconds * 1000;
	if (
		(since !== null && change.expiresAt !== undefined && endOf(expiresAt) > since.getTime() + lifeMilliseconds) ||
		(ownerSelfWidening && endOf(expiresAt) > now.getTime() + lifeMilliseconds)
	) {
		return refuse(GRANT_PROBLEMS.selfGrantTooLong);
	}
	if (authority === 'administrator' && selfWidening) {
		return refuse(GRANT_PROBLEMS.selfWideningNotPermitted);
	}
	if (
		authority === 'administrator' &&
		extendsOrWidens &&
		!(ADMINISTRATOR_EXTENDED_ROLES.has(current.role.name) && ADMINISTRATOR_EXTENDED_ROLES.has(role.name))
	) {
		return refuse(GRANT_PROBLEMS.administratorGrantsNoConsumerAccess);
	}
	return { endMoved, expiresAt, kind: 'change', role, roleMoved };
};
