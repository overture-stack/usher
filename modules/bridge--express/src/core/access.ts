import type { Enforcement, UsherPrincipal, UsherRequestAccess } from '@overture-stack/usher-types';

/**
 * Freezes a value and everything inside it, so an outcome handed to a host cannot be changed by the host
 * or by another request.
 *
 * @param value the value to freeze, in place.
 * @returns the same value, frozen.
 */
export const deepFreeze = <Value>(value: Value): Value => {
	if (typeof value === 'object' && value !== null) {
		Object.values(value).forEach(deepFreeze);
		Object.freeze(value);
	}
	return value;
};

/**
 * One request's access as the core attaches it to an outcome: the principal it is served as, each
 * catalogue's artifact-creation result, and each catalogue's result. The principal is copied, and the whole
 * is deep-frozen.
 *
 * @param principal who the request is served as.
 * @param maps `artifactCreate`, each catalogue's artifact-creation result, and `results`, each
 *   catalogue's result, both keyed by catalogue. They are named rather than positional, since two maps
 *   of one type passed in the wrong order would serve one rendering as the other.
 */
export const accessOf = (
	principal: UsherPrincipal,
	{
		artifactCreate,
		results,
	}: Readonly<{
		artifactCreate: Readonly<Record<string, Enforcement>>;
		results: Readonly<Record<string, Enforcement>>;
	}>,
): Readonly<UsherRequestAccess> =>
	deepFreeze({ artifactCreate, principal: { ...principal }, results, version: 1 as const });

/** The principal of a request presenting no credential: the open tier only, and not suspended. */
export const anonymousPrincipal = (): UsherPrincipal => ({
	credential: 'none',
	openTierOnly: true,
	suspended: false,
});

/**
 * The principal served for a credential the core could not confirm: suspended, the open tier only, and
 * naming no subject.
 */
export const unconfirmedSuspendedPrincipal = (): UsherPrincipal => ({
	credential: 'unconfirmed',
	openTierOnly: true,
	suspended: true,
});

/**
 * The principal served for a credential whose subject the Controller vouched for, while the core serves
 * the open tier only: suspended, and naming that subject for attribution alone.
 *
 * @param subject the subject the Controller vouched for.
 */
export const attributionOnlyPrincipal = (subject: string): UsherPrincipal => ({
	attributionOnlySubject: subject,
	credential: 'confirmed',
	openTierOnly: true,
	suspended: true,
});

/**
 * The principal served for a confirmed credential: not suspended, and naming its subject.
 *
 * @param subject the subject the Controller confirmed.
 * @param openTierOnly whether the subject's grants reach the open tier alone.
 */
export const confirmedPrincipal = (subject: string, openTierOnly: boolean): UsherPrincipal => ({
	credential: 'confirmed',
	openTierOnly,
	subject,
	suspended: false,
});
