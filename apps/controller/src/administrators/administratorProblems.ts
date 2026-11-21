import { type Problem, problem } from '../http/index.js';

/**
 * The refusals the administrator operations answer, beside those every Management API operation
 * may.
 */
export const ADMINISTRATOR_PROBLEMS = Object.freeze({
	directoryUnavailable: problem(
		'directoryUnavailable',
		503,
		'Directory unavailable',
		"A nominee Usher has not met is found through the identity provider's directory, which cannot answer now. Nominate a person Usher has met, or try again later.",
	),
	firstAdministratorAccepted: problem(
		'firstAdministratorAccepted',
		409,
		'First administrator accepted',
		"Usher's first administrator has accepted a nomination, and no first administrator is nominated or accepted after that.",
	),
	nominationAlreadyDecided: problem(
		'nominationAlreadyDecided',
		409,
		'Nomination already decided',
		'The nominee has already accepted or declined this nomination, and each nomination is answered once.',
	),
	nominationNotFound: problem(
		'nominationNotFound',
		404,
		'Nomination not found',
		'No nomination you may answer or revoke has the nominationId named. GET /admin/me/nominations lists each nomination naming you, by its id.',
	),
	nominationReplaced: problem(
		'nominationReplaced',
		409,
		'Nomination replaced',
		'A later nomination has replaced this one, and only the latest nomination may be answered or revoked.',
	),
	nominationRevoked: problem(
		'nominationRevoked',
		409,
		'Nomination revoked',
		'The first user has revoked this nomination, so it can no longer be answered.',
	),
	unknownDecision: problem('unknownDecision', 422, 'Unknown decision', 'decision is accept or decline.'),
});

/** The detail of a nominee no account in the trusted realm holds, named by the realm's issuer. */
export const nomineeNotInRealm = (issuer: string): Problem =>
	problem(
		'nomineeNotFound',
		404,
		'Nominee not found',
		`No account in the realm Usher trusts, ${issuer}, has this subject. Name the nominee by their user ID in that realm.`,
	);

/** The refusal of a nominee who is neither the first user nor a person Usher has met, with no directory configured. */
export const NOMINEE_WITHOUT_DIRECTORY = problem(
	'nomineeNotFound',
	404,
	'Nominee not found',
	'No directory is configured, so only the first user or a person Usher has met can be nominated until one is configured.',
);

/**
 * The reasons a refused answer or revocation's event records beside the `404` `nominationNotFound`
 * it answers, one for each way the path's nomination is not one the caller may act on.
 */
export const NOMINATION_REFUSAL_REASONS = Object.freeze({
	malformedNominationId: 'malformedNominationId',
	nominationBySomeoneElse: 'nominationBySomeoneElse',
	nominationForSomeoneElse: 'nominationForSomeoneElse',
	unknownNominationId: 'unknownNominationId',
});
