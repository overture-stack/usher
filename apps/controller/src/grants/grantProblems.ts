import { problem } from '../http/index.js';
import { STANDING_PROBLEMS } from '../resourceStanding/index.js';
import { GIVEN_REVOCATION_REASONS } from './revocationReasons.js';

/** The refusals the grant operations answer, beside those every Management API operation may. */
export const GRANT_PROBLEMS = Object.freeze({
	addressForm: problem(
		'addressForm',
		422,
		'Not an address',
		"holder's email is one address: text before and after a single @, holding no whitespace and no comma.",
	),
	administratorGrantsNoConsumerAccess: problem(
		'administratorGrantsNoConsumerAccess',
		403,
		"Access to records is the owners' to grant",
		"A platform administrator grants the submitter and owner roles; any other role on a resource is its owners' to grant.",
	),
	administratorRoleNotGranted: problem(
		'administratorRoleNotGranted',
		422,
		'The administrator role is not granted',
		'No one grants the admin role: a person becomes an administrator by accepting a nomination.',
	),
	administratorSelfOwnership: problem(
		'administratorSelfOwnership',
		403,
		'An administrator names themself an owner',
		'A platform administrator makes anyone but themself an owner; another platform administrator may name them.',
	),
	alreadyHolds: problem(
		'alreadyHolds',
		409,
		'Grant already held',
		'The holder already holds a live grant of this role on this resource and category, whether pending, accepted or declined.',
	),
	alreadyRevoked: problem(
		'doesNotHold',
		409,
		'Grant revoked already',
		'The grant is revoked already, and keeps its first revocation.',
	),
	capabilitiesDiffer: problem(
		'capabilitiesDiffer',
		422,
		'Capabilities differ from the role',
		"capabilities lists exactly what the grant's role confers now; read the role's capabilities again and answer with those.",
	),
	categoryNotOffered: problem(
		'categoryNotOffered',
		422,
		'Category not offered',
		"category names a category the resource offers: a global one as global.<name>, or one of the resource's own as resource.<name>.",
	),
	categoryRequired: problem(
		'categoryRequired',
		422,
		'Category required',
		"A grant of a data-plane role names the record category it applies to in category; only a submitter's grant may leave it out.",
	),
	directoryUnavailable: problem(
		'directoryUnavailable',
		503,
		'Directory unavailable',
		"A holder named by address is found through the identity provider's directory, which cannot answer now. Name the holder by subject, or try again later.",
	),
	doesNotHold: problem(
		'doesNotHold',
		409,
		'Grant not in force',
		'The grant is revoked or has expired, and takes no answer.',
	),
	expiryNotAnInstant: problem(
		'expiryNotAnInstant',
		422,
		'Expiry not an instant',
		'expiresAt is an RFC 3339 instant with an offset, Z or ±hh:mm, such as 2026-11-03T15:04:05Z.',
	),
	expiryPassed: problem('expiryPassed', 422, 'Expiry passed', 'expiresAt is an instant in the future.'),
	fieldCategoryNotTaken: problem(
		'fieldCategoryNotTaken',
		422,
		'Field category not taken',
		'A grant names its record category alone: leave fieldCategory out.',
	),
	grantNotFound: problem('grantNotFound', 404, 'Grant not found', 'No grant you may act on has the id named.'),
	grantedByNotTaken: problem(
		'grantedByNotTaken',
		422,
		'Granter not taken',
		"The caller is the grant's granter: leave grantedBy out.",
	),
	holderNotOnePerson: problem(
		'holderNotOnePerson',
		422,
		'Holder not one person',
		'holder names exactly one person, by subject or by email, and nothing else.',
	),
	noAuthorityOnResource: STANDING_PROBLEMS.noAuthorityOnResource,
	ownerGrantsDoNotExpire: problem(
		'ownerGrantsDoNotExpire',
		422,
		'Owner grants do not expire',
		'An owner grant lasts until it is revoked: leave expiresAt out.',
	),
	resourceNeedsAnOwner: problem(
		'resourceNeedsAnOwner',
		409,
		'Resource needs an owner',
		"This is the resource's last accepted owner grant. Add another owner first, then try again.",
	),
	resourceNotFound: STANDING_PROBLEMS.resourceNotFound,
	selfNamed: problem(
		'selfNamed',
		422,
		'Holder is the caller',
		'This operation grants to someone other than the caller; a principal grants themself through POST /admin/grants/self.',
	),
	submitterCategoryNotOffered: problem(
		'categoryNotOffered',
		422,
		'Submitter category not offered',
		"The grant names no category, and the instance's submitter category is not one the store holds: name the category in category.",
	),
	unknownDecision: problem('unknownDecision', 422, 'Unknown decision', 'decision is accepted or rejected.'),
	unknownRevocationReason: problem(
		'unknownRevocationReason',
		422,
		'Unknown revocation reason',
		`reason is one of ${GIVEN_REVOCATION_REASONS.join(', ')}, or is left out with the body.`,
	),
	unknownRole: problem(
		'unknownRole',
		422,
		'Unknown role',
		'role names a role the instance defines, in its exact letter case.',
	),
	wholeResourceRole: problem(
		'wholeResourceRole',
		422,
		'Category not taken by this role',
		'A grant of a control-plane role, such as owner, takes the whole resource: leave category out.',
	),
});
