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

// The outcome every function here answers: always one carrying access, so a caller reads its access with no
// narrowing, and it still stands wherever a core's resolve answers a `ResolveOutcome`.
type AccessOutcome = Extract<ResolveOutcome, { kind: 'access' }>;

// The access an outcome carries is frozen as the core freezes it, so it is built from a copy of the caller's
// results, leaving the caller's own objects as they were.
const copyOf = (results: Results): Results => structuredClone(results);

/**
 * The outcome for a request presenting no credential, which the core answers the same in normal and
 * uncertain mode.
 *
 * @param openTierResults each catalogue's result for the open tier, keyed by catalogue.
 */
export const anonymousAccess = (openTierResults: Results): AccessOutcome => ({
	access: accessOf(anonymousPrincipal(), copyOf(openTierResults)),
	kind: 'access',
});

/**
 * The outcome for a confirmed principal served in normal mode.
 *
 * @param subject the subject the Controller confirmed.
 * @param results each catalogue's result for the principal, keyed by catalogue.
 * @param options `openTierOnly` set when the subject's grants reach the open tier alone; false by default.
 */
export const signedInAccess = (
	subject: string,
	results: Results,
	options: Readonly<{ openTierOnly?: boolean }> = {},
): AccessOutcome => ({
	access: accessOf(confirmedPrincipal(subject, options.openTierOnly ?? false), copyOf(results)),
	kind: 'access',
});

/**
 * The outcome the core gives what it cannot serve in full: uncertain mode, or one credential whose exchange
 * failed. A null credential is the anonymous principal. Any other is suspended, unconfirmed and naming no
 * subject, unless `attributionOnlySubject` names the subject the Controller vouched for, when it is suspended
 * and confirmed for attribution alone. An empty subject counts as none, as it does in the core.
 *
 * @param credential the presented credential, or null for a request presenting none.
 * @param openTierResults each catalogue's result for the open tier, keyed by catalogue.
 * @param options `attributionOnlySubject`, the subject the Controller vouched for, if any.
 */
export const openTierAccess = (
	credential: string | null,
	openTierResults: Results,
	options: Readonly<{ attributionOnlySubject?: string }> = {},
): AccessOutcome => {
	if (credential === null) {
		return anonymousAccess(openTierResults);
	}

	const subject = options.attributionOnlySubject;
	const principal =
		subject === undefined || subject.length === 0
			? unconfirmedSuspendedPrincipal()
			: attributionOnlyPrincipal(subject);

	return { access: accessOf(principal, copyOf(openTierResults)), kind: 'access' };
};
