import { problem } from '../http/index.js';

/**
 * The refusals the administrator operations answer, beside those every Management API operation
 * may.
 */
export const ADMINISTRATOR_PROBLEMS = Object.freeze({
	firstAdministratorAccepted: problem(
		'firstAdministratorAccepted',
		409,
		'First administrator accepted',
		"Usher's first administrator has accepted a nomination, and no first administrator is nominated or accepted after that.",
	),
	nominationNotFound: problem(
		'nominationNotFound',
		404,
		'Nomination not found',
		'No nomination naming you has the id named.',
	),
	nominationSuperseded: problem(
		'nominationSuperseded',
		409,
		'Nomination replaced',
		'A later nomination has replaced this one, and only the latest nomination may be accepted.',
	),
	nomineeNotFound: problem(
		'nomineeNotFound',
		404,
		'Nominee not found',
		'nominee names you, or by subject a person Usher has met through the trusted identity provider, such as one who has signed in to an ushered application.',
	),
});
