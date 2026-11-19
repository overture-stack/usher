/** The reasons a caller may give for revoking a grant, each recorded on its `grant.revocation`. */
export const GIVEN_REVOCATION_REASONS: readonly string[] = Object.freeze([
	'accessNoLongerNeeded',
	'accessReview',
	'custodianRequest',
	'grantedInError',
	'holderLeftProject',
	'requestedByHolder',
	'termsViolation',
]);

/** The reason recorded for a revocation given none, which no caller may give. */
export const UNSPECIFIED_REASON = 'unspecified';
