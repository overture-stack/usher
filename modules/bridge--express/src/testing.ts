/**
 * Access outcomes for a consumer's tests, each as the Bridge answers it in one state, with no running core.
 *
 * The outcomes are built by the core's own builders, so a test's stand-in answers what the core answers and
 * cannot drift from it. The module is for a consumer's tests only: it creates no core, reads no keys and
 * starts no clock or channel.
 */

import type { Enforcement } from '@overture-stack/usher-types';

import {
	accessOf,
	anonymousPrincipal,
	attributionOnlyPrincipal,
	confirmedPrincipal,
	unconfirmedSuspendedPrincipal,
} from './core/access.js';
import type { ResolveOutcome } from './core/core.js';

type Results = Readonly<Record<string, Enforcement>>;

/** The two maps of enforcement results an outcome carries: each catalogue's result, and its artifact-creation result. */
interface AccessResults {
	/** Each catalogue's artifact-creation result, keyed by catalogue. It holds the keys `results` holds. */
	artifactCreate: Results;

	/** Each catalogue's result, keyed by catalogue. */
	results: Results;
}

// The outcome every function here answers: always one carrying access, so a caller reads its access with no
// narrowing, and it still stands wherever a core's resolve answers a `ResolveOutcome`.
type AccessOutcome = Extract<ResolveOutcome, { kind: 'access' }>;

// The access an outcome carries is frozen as the core freezes it, so it is built from a copy of the caller's
// maps, leaving the caller's own objects as they were.
const copyOf = ({ artifactCreate, results }: AccessResults): AccessResults =>
	structuredClone({ artifactCreate, results });

/**
 * The outcome for a request presenting no credential, which the core answers the same in normal and
 * uncertain mode.
 *
 * @param maps each catalogue's artifact-creation and view results for the open tier, keyed by catalogue.
 */
export const anonymousAccess = (maps: AccessResults): AccessOutcome => {
	const { artifactCreate, results } = copyOf(maps);
	return { access: accessOf(anonymousPrincipal(), { artifactCreate, results }), kind: 'access' };
};

/**
 * The outcome for a confirmed principal served in normal mode.
 *
 * @param subject the subject the Controller confirmed.
 * @param maps each catalogue's artifact-creation and view results for the principal, keyed by catalogue.
 * @param options `openTierOnly` set when the subject's grants reach the open tier alone; false by default.
 */
export const signedInAccess = (
	subject: string,
	maps: AccessResults,
	options: Readonly<{ openTierOnly?: boolean }> = {},
): AccessOutcome => {
	const { artifactCreate, results } = copyOf(maps);
	return {
		access: accessOf(confirmedPrincipal(subject, options.openTierOnly ?? false), { artifactCreate, results }),
		kind: 'access',
	};
};

/**
 * The outcome the core gives what it cannot serve in full: uncertain mode, or one credential whose exchange
 * failed. A null credential is the anonymous principal. Any other is suspended, unconfirmed and naming no
 * subject, unless `attributionOnlySubject` names the subject the Controller vouched for, when it is suspended
 * and confirmed for attribution alone. An empty subject counts as none, as it does in the core.
 *
 * @param credential the presented credential, or null for a request presenting none.
 * @param maps each catalogue's artifact-creation and view results for the open tier, keyed by catalogue.
 * @param options `attributionOnlySubject`, the subject the Controller vouched for, if any.
 */
export const openTierAccess = (
	credential: string | null,
	maps: AccessResults,
	options: Readonly<{ attributionOnlySubject?: string }> = {},
): AccessOutcome => {
	if (credential === null) {
		return anonymousAccess(maps);
	}

	const subject = options.attributionOnlySubject;
	const principal =
		subject === undefined || subject.length === 0
			? unconfirmedSuspendedPrincipal()
			: attributionOnlyPrincipal(subject);

	const { artifactCreate, results } = copyOf(maps);
	return { access: accessOf(principal, { artifactCreate, results }), kind: 'access' };
};
