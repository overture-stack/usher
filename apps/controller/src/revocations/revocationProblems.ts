import { problem, type Problem } from '../http/index.js';

/** The refusals the revocation operations answer, beside those every Management API operation may. */
export const REVOCATION_PROBLEMS = Object.freeze({
	alreadyRevoked: problem(
		'alreadyRevoked',
		409,
		'Already revoked',
		'The principal already holds a revocation that stands. Lift it before revoking them again.',
	),
	invalidRevocationReason: problem(
		'invalidRevocationReason',
		422,
		'Reason not accepted',
		'A principal revocation names one of accountClosed, credentialCompromise, securityIncident or termsViolation.',
	),
	invalidSignOutReason: problem(
		'invalidSignOutReason',
		422,
		'Reason not accepted',
		'A sign-out of everyone names credentialCompromise or securityIncident.',
	),
	lastAdministrator: problem(
		'lastAdministrator',
		409,
		'Last administrator',
		'Usher keeps at least one administrator who is not revoked, and this would leave none. Nominate another and have them accept first.',
	),
	notConfirmed: problem(
		'notConfirmed',
		422,
		'Revocation not confirmed',
		'A sign-out of everyone needs confirm set to true, so that it is not made by accident.',
	),
	notRevoked: problem(
		'notRevoked',
		409,
		'Not revoked',
		'The principal holds no revocation that stands: either Usher has never met them, or they are not revoked.',
	),
} satisfies Readonly<Record<string, Problem>>);
