import { GRANT_PROBLEMS, type HolderReading, type NamedHolder, readHolder } from '../grants/index.js';
import type { Problem } from '../http/index.js';
import { type InputReading, unreadableBody } from '../managementApi/index.js';
import { externalIdRuleBroken } from './externalId.js';
import {
	DESCRIPTION_MAXIMUM_LENGTH,
	DISPLAY_NAME_MAXIMUM_LENGTH,
	externalIdProblem,
	RESOURCE_PROBLEMS,
} from './resourceProblems.js';
import type { AccessLevel, Registration } from './types.js';

/** The access levels a resource takes, by the names the API gives them. */
export const ACCESS_LEVELS: readonly AccessLevel[] = Object.freeze(['grant', 'open', 'registered']);

// What each member a registration takes must hold, by its shape alone.
const MEMBER_SHAPES = {
	accessLevel: 'a string',
	applications: 'a list of strings',
	description: 'a string',
	displayName: 'a string',
	externalId: 'a string',
	fields: 'an object of strings',
	owners: 'a list of objects',
} as const;

type Member = keyof typeof MEMBER_SHAPES;

const MEMBERS = Object.keys(MEMBER_SHAPES).toSorted();

const REQUIRED: readonly Member[] = Object.freeze(['displayName', 'externalId']);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const isTaken = (name: string): name is Member => Object.hasOwn(MEMBER_SHAPES, name);

const holdsShape = (member: Member, value: unknown): boolean => {
	const shape = MEMBER_SHAPES[member];
	if (shape === 'a string') {
		return typeof value === 'string';
	}
	if (shape === 'a list of strings') {
		return Array.isArray(value) && value.every((item) => typeof item === 'string');
	}
	if (shape === 'a list of objects') {
		return Array.isArray(value) && value.every(isRecord);
	}
	return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
};

const isAccessLevel = (value: string): value is AccessLevel => ACCESS_LEVELS.some((level) => level === value);

// Characters once normalized to NFC, a character outside the Basic Multilingual Plane counting once.
const charactersOnceNormalized = (text: string): number => [...text.normalize('NFC')].length;

const refused = (problem: Problem): InputReading<never> => ({
	kind: 'refused',
	problem,
});

// The refusal a body earns by its shape: a member not taken, a required one missing, or one holding
// a value of the wrong type, each named by the rule alone.
const shapeProblem = (body: Readonly<Record<string, unknown>>): Problem | undefined => {
	if (!Object.keys(body).every(isTaken)) {
		return unreadableBody(
			`holds a member this operation does not take: it takes ${MEMBERS.slice(0, -1).join(', ')} and ${MEMBERS.at(-1) ?? ''} alone`,
		);
	}
	const missing = REQUIRED.find((name) => !Object.hasOwn(body, name));
	if (missing !== undefined) {
		return unreadableBody(`lacks the member ${missing}`);
	}
	const mistyped = Object.keys(body)
		.filter(isTaken)
		.find((name) => !holdsShape(name, body[name]));
	return mistyped === undefined
		? undefined
		: unreadableBody(`holds ${mistyped} as something other than ${MEMBER_SHAPES[mistyped]}`);
};

// One person as owners name them: a subject exactly, and an address in any letter case.
const personKey = (holder: NamedHolder): string =>
	holder.kind === 'subject' ? `subject:${holder.subject}` : `address:${holder.email.toLowerCase()}`;

// The owners a registration names, each read as a grant's holder is.
const ownerReadings = (owners: unknown): readonly HolderReading[] =>
	Array.isArray(owners) ? owners.map((owner) => readHolder(owner, 'an owner')) : [];

// The refusal of an owner by its shape, the first one's, or none.
const ownerShapeProblem = (owners: unknown): Problem | undefined =>
	ownerReadings(owners).flatMap((reading) =>
		reading.kind === 'refused' && reading.problem.status === 400 ? [reading.problem] : [],
	)[0];

// The owners a registration names, in order: refused for the first owner breaking a rule, then for
// one person named twice, then for the caller named.
const ownersNamed = (owners: unknown, callerSubject: string): InputReading<readonly NamedHolder[]> => {
	const readings = ownerReadings(owners);
	const broken = readings.find((reading) => reading.kind === 'refused');
	if (broken?.kind === 'refused') {
		return broken;
	}
	const holders = readings.flatMap((reading) => (reading.kind === 'read' ? [reading.holder] : []));
	if (new Set(holders.map(personKey)).size < holders.length) {
		return refused(RESOURCE_PROBLEMS.ownerNamedTwice);
	}
	return holders.some((holder) => holder.kind === 'subject' && holder.subject === callerSubject)
		? refused(GRANT_PROBLEMS.administratorSelfOwnership)
		: { input: holders, kind: 'read' };
};

/**
 * Reads a resource's registration from its body. A body is first read by its shape alone, refused
 * 400: a member other than `accessLevel`, `applications`, `description`, `displayName`,
 * `externalId`, `fields` and `owners`; `externalId` or `displayName` missing; a member holding a
 * value of another type, `null` included; or an owner naming its subject or its address as anything
 * but a string. Its rules are then judged in turn, each refused 422: the externalId's form; a
 * display name blank, or longer than {@link DISPLAY_NAME_MAXIMUM_LENGTH} characters once normalized
 * to NFC; a description longer than {@link DESCRIPTION_MAXIMUM_LENGTH} characters once normalized
 * to NFC; an access level missing, or other than `open`, `registered` and `grant`; a value for any
 * resource field, since the instance defines none; an owner naming other than exactly one person,
 * or an address out of an address's form, as a grant's holder is read; and one person named twice,
 * by one subject or by one address in any letter case, `ownerNamedTwice`. A registration naming its
 * caller an owner is then refused 403 `administratorSelfOwnership`. A display name is blank when it
 * holds nothing once trimmed. The display name and the description are stored exactly as given, a
 * description left out as none, and the owners kept in the order named.
 *
 * @param body the body's object, or none for a request sending none.
 * @param callerSubject the subject of the platform administrator registering.
 */
export const readRegistration = (
	body: Readonly<Record<string, unknown>> | undefined,
	callerSubject: string,
): InputReading<Registration> => {
	const sent = body ?? {};
	const shape = shapeProblem(sent) ?? ownerShapeProblem(sent['owners']);
	if (shape !== undefined) {
		return refused(shape);
	}
	const text = (name: Member): string | undefined => {
		const value = sent[name];
		return typeof value === 'string' ? value : undefined;
	};
	const externalId = text('externalId') ?? '';
	const displayName = text('displayName') ?? '';
	const description = text('description');
	const accessLevel = text('accessLevel');
	const fields = sent['fields'];
	const owners = sent['owners'];
	const applications = sent['applications'];
	const broken = externalIdRuleBroken(externalId);
	if (broken !== undefined) {
		return refused(externalIdProblem(broken));
	}
	if (displayName.trim() === '') {
		return refused(RESOURCE_PROBLEMS.displayNameBlank);
	}
	if (charactersOnceNormalized(displayName) > DISPLAY_NAME_MAXIMUM_LENGTH) {
		return refused(RESOURCE_PROBLEMS.displayNameTooLong);
	}
	if (description !== undefined && charactersOnceNormalized(description) > DESCRIPTION_MAXIMUM_LENGTH) {
		return refused(RESOURCE_PROBLEMS.descriptionTooLong);
	}
	if (accessLevel === undefined) {
		return refused(RESOURCE_PROBLEMS.accessLevelRequired);
	}
	if (!isAccessLevel(accessLevel)) {
		return refused(RESOURCE_PROBLEMS.unknownAccessLevel);
	}
	if (isRecord(fields) && Object.keys(fields).length > 0) {
		return refused(RESOURCE_PROBLEMS.unknownResourceField);
	}
	const named = ownersNamed(owners, callerSubject);
	if (named.kind === 'refused') {
		return named;
	}
	return {
		input: {
			accessLevel,
			applications: Array.isArray(applications) ? applications.filter((id) => typeof id === 'string') : [],
			description: description ?? null,
			displayName,
			externalId,
			owners: named.input,
		},
		kind: 'read',
	};
};
