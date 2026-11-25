/** The reasons a principal's revocation may name, the identity revocation reasons. */
export const PRINCIPAL_REVOCATION_REASONS = Object.freeze([
	'accountClosed',
	'credentialCompromise',
	'securityIncident',
	'termsViolation',
] as const);

/** The reasons a sign-out of everyone may name. */
export const SIGN_OUT_EVERYONE_REASONS = Object.freeze(['credentialCompromise', 'securityIncident'] as const);

/** A reason a principal's revocation may name. */
export type PrincipalRevocationReason = (typeof PRINCIPAL_REVOCATION_REASONS)[number];

/** A reason a sign-out of everyone may name. */
export type SignOutEveryoneReason = (typeof SIGN_OUT_EVERYONE_REASONS)[number];
