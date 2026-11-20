import { type Problem, problem } from '../http/index.js';
import { STANDING_PROBLEMS } from '../resourceStanding/index.js';
import { EXTERNAL_ID_MAXIMUM_LENGTH } from './externalId.js';
import type { ExternalIdRule } from './types.js';

/** The longest a resource's display name may be, in characters once normalized to NFC. */
export const DISPLAY_NAME_MAXIMUM_LENGTH = 256;

/** The longest a resource's description may be, in characters once normalized to NFC. */
export const DESCRIPTION_MAXIMUM_LENGTH = 4096;

/** The refusals the resource operations answer, beside those every Management API operation may. */
export const RESOURCE_PROBLEMS = Object.freeze({
	accessLevelRequired: problem(
		'accessLevelRequired',
		422,
		'Access level required',
		'A registration names its accessLevel: open, registered or grant.',
	),
	alreadyExists: problem(
		'alreadyExists',
		409,
		'Resource already registered',
		'A resource holds this externalId in some letter case, a retired one included: one externalId names one resource.',
	),
	applicationNotFound: problem(
		'applicationNotFound',
		404,
		'Application not found',
		'No registered application has the id named.',
	),
	descriptionTooLong: problem(
		'descriptionTooLong',
		422,
		'Description too long',
		`description holds at most ${DESCRIPTION_MAXIMUM_LENGTH} characters once normalized to NFC.`,
	),
	displayNameBlank: problem(
		'displayNameBlank',
		422,
		'Display name blank',
		'displayName must hold more than whitespace.',
	),
	displayNameTooLong: problem(
		'displayNameTooLong',
		422,
		'Display name too long',
		`displayName holds at most ${DISPLAY_NAME_MAXIMUM_LENGTH} characters once normalized to NFC.`,
	),
	ownerNamedTwice: problem(
		'ownerNamedTwice',
		422,
		'Owner named twice',
		'owners names each person once, by one subject or one address.',
	),
	resourceNotFound: STANDING_PROBLEMS.resourceNotFound,
	retiredListedToAdministrators: problem(
		'administratorOnly',
		403,
		'For platform administrators alone',
		'Retired resources are listed to platform administrators alone: leave includeRetired out, or send it false.',
	),
	unknownAccessLevel: problem(
		'unknownAccessLevel',
		422,
		'Unknown access level',
		'accessLevel is one of open, registered and grant.',
	),
	unknownApplication: problem(
		'unknownApplication',
		422,
		'Unknown application',
		'Each id in applications names a registered application; nothing of the registration was written.',
	),
	unknownResourceField: problem(
		'unknownResourceField',
		422,
		'Unknown resource field',
		'Each member of fields names a resource field the instance defines, and it defines none.',
	),
});

// One refusal for each rule of an externalId's form, each naming its rule alone.
const EXTERNAL_ID_PROBLEMS: Readonly<Record<ExternalIdRule, Problem>> = Object.freeze({
	characters: problem(
		'externalIdCharacters',
		422,
		'externalId holds a character it may not',
		'externalId starts with an ASCII letter or digit, and holds ASCII letters, digits, dots, underscores and hyphens alone.',
	),
	filterMarker: problem(
		'externalIdFilterMarker',
		422,
		'externalId holds a filter marker',
		'externalId holds none of the filter markers *, __missing__ and set_id:.',
	),
	length: problem(
		'externalIdLength',
		422,
		'externalId length',
		`externalId holds from 1 to ${EXTERNAL_ID_MAXIMUM_LENGTH} characters.`,
	),
	normalization: problem(
		'externalIdNotNormalized',
		422,
		'externalId not in NFC',
		'externalId is sent in Unicode normalization form C.',
	),
});

/**
 * The refusal of an externalId breaking a rule of its form, naming that rule.
 *
 * @param rule the rule broken.
 */
export const externalIdProblem = (rule: ExternalIdRule): Problem => EXTERNAL_ID_PROBLEMS[rule];
