import type { Problem } from '../http/index.js';
import { type InputReading, unreadableBody } from '../managementApi/index.js';
import { GRANT_PROBLEMS } from './grantProblems.js';
import { instantOf } from './readInstant.js';
import type { SelfGrantCreation } from './types.js';

// The members a self-grant takes, each a string; `holder` is known so a body naming one breaks a
// rule rather than its shape.
const TEXT_MEMBERS = ['category', 'expiresAt', 'resource', 'role'] as const;

const TAKEN = [...TEXT_MEMBERS, 'holder'].toSorted();

const TAKEN_NAMED = `${TAKEN.slice(0, -1).join(', ')} and ${TAKEN.at(-1) ?? ''}`;

const REQUIRED = ['expiresAt', 'resource', 'role'] as const;

const refused = (problem: Problem): InputReading<never> => ({
	kind: 'refused',
	problem,
});

const shapeProblem = (body: Readonly<Record<string, unknown>>): Problem | undefined => {
	if (!Object.keys(body).every((name) => TAKEN.includes(name))) {
		return unreadableBody(`holds a member this operation does not take: it takes ${TAKEN_NAMED} alone`);
	}
	const missing = REQUIRED.find((name) => !Object.hasOwn(body, name));
	if (missing !== undefined) {
		return unreadableBody(`lacks the member ${missing}`);
	}
	const mistyped = TEXT_MEMBERS.find((name) => Object.hasOwn(body, name) && typeof body[name] !== 'string');
	return mistyped === undefined ? undefined : unreadableBody(`holds ${mistyped} as something other than a string`);
};

/**
 * Reads a self-grant's creation from its body. The body is first read by its shape alone, refused
 * 400: a member other than `category`, `expiresAt`, `holder`, `resource` and `role`; `expiresAt`,
 * `resource` or `role` missing; or `category`, `expiresAt`, `resource` or `role` holding anything
 * but a string, a `null` expiry among them. Its rules are then judged in turn, each refused 422: a
 * `holder`, whatever it holds, `holderNotTaken`; the `admin` role, which nobody grants; an expiry
 * that is no RFC 3339 instant with an offset, or names a day, an hour or an offset there is not; an
 * expiry at or before the request's instant; and one past the longest self-grant life of it,
 * `selfGrantTooLong`. A platform administrator naming the `owner` role is then refused 403
 * `administratorSelfOwnership`. Every text is kept exactly as given.
 *
 * @param body the body's object.
 * @param request whether the caller is a platform administrator, the longest a self-grant lives in
 *   seconds, and the configured clock's instant, in milliseconds since the Unix epoch.
 */
export const readSelfGrantCreation = (
	body: Readonly<Record<string, unknown>>,
	{ administrator, maximumSeconds, now }: { administrator: boolean; maximumSeconds: number; now: number },
): InputReading<SelfGrantCreation> => {
	const shape = shapeProblem(body);
	if (shape !== undefined) {
		return refused(shape);
	}
	const text = (name: (typeof TEXT_MEMBERS)[number]): string | undefined => {
		const value = body[name];
		return typeof value === 'string' ? value : undefined;
	};
	if (Object.hasOwn(body, 'holder')) {
		return refused(GRANT_PROBLEMS.holderNotTaken);
	}
	const role = text('role') ?? '';
	if (role === 'admin') {
		return refused(GRANT_PROBLEMS.administratorRoleNotGranted);
	}
	const expiresAt = instantOf(text('expiresAt') ?? '');
	if (expiresAt === undefined) {
		return refused(GRANT_PROBLEMS.expiryNotAnInstant);
	}
	if (expiresAt.getTime() <= now) {
		return refused(GRANT_PROBLEMS.expiryPassed);
	}
	if (expiresAt.getTime() > now + maximumSeconds * 1000) {
		return refused(GRANT_PROBLEMS.selfGrantTooLong);
	}
	if (administrator && role === 'owner') {
		return refused(GRANT_PROBLEMS.administratorSelfOwnership);
	}
	return {
		input: {
			category: text('category'),
			expiresAt,
			resource: text('resource') ?? '',
			role,
		},
		kind: 'read',
	};
};
