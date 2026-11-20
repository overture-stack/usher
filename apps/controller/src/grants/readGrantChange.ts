import type { Problem } from '../http/index.js';
import { type InputReading, unreadableBody } from '../managementApi/index.js';
import { GRANT_PROBLEMS } from './grantProblems.js';
import { instantOf } from './readInstant.js';
import type { GrantChange } from './types.js';

const TAKEN = ['expiresAt', 'role'];

const refused = (problem: Problem): InputReading<never> => ({
	kind: 'refused',
	problem,
});

/**
 * Reads a grant's change from its JSON Merge Patch: `expiresAt`, an instant or `null` to remove it,
 * and `role`, each left out to keep it as it is. A body holding another member, an expiry neither
 * text nor `null`, or a role that is no string, is refused 400. Its rules are then judged in turn,
 * each refused 422: an expiry that is no RFC 3339 instant with an offset; one at or before the
 * configured instant; and the `admin` role, which nobody grants. Every text is kept exactly as
 * given.
 *
 * @param body the body's object.
 * @param now the configured clock's instant, in milliseconds since the Unix epoch.
 */
export const readGrantChange = (body: Readonly<Record<string, unknown>>, now: number): InputReading<GrantChange> => {
	const { expiresAt, role } = body;
	if (!Object.keys(body).every((name) => TAKEN.includes(name))) {
		return refused(
			unreadableBody('holds a member this operation does not take: it takes expiresAt and role alone'),
		);
	}
	if (Object.hasOwn(body, 'expiresAt') && typeof expiresAt !== 'string' && expiresAt !== null) {
		return refused(unreadableBody('holds expiresAt as something other than a string or null'));
	}
	if (Object.hasOwn(body, 'role') && typeof role !== 'string') {
		return refused(unreadableBody('holds role as something other than a string'));
	}
	const instant = typeof expiresAt === 'string' ? instantOf(expiresAt) : null;
	if (instant === undefined) {
		return refused(GRANT_PROBLEMS.expiryNotAnInstant);
	}
	if (instant !== null && instant.getTime() <= now) {
		return refused(GRANT_PROBLEMS.expiryPassed);
	}
	if (role === 'admin') {
		return refused(GRANT_PROBLEMS.administratorRoleNotGranted);
	}
	return {
		input: {
			...(Object.hasOwn(body, 'expiresAt') ? { expiresAt: instant } : {}),
			...(typeof role === 'string' ? { role } : {}),
		},
		kind: 'read',
	};
};
