import type { Calculation } from '../tokenCalculation/index.js';
import type { VersionOnePayload } from '../usherToken/index.js';
import { versionOnePayload } from './versionOnePayload.js';

/** When and by whom a signed-in principal's token is issued, for which audience, and to whom. */
export interface SignedInIssuing {
	/** The application the token is issued for, its `aud`. */
	audience: string;

	/** The instant of issue and of the computation, in whole seconds since the Unix epoch. */
	issuedAt: number;

	/** The Controller's own issuer, its `iss`. */
	issuer: string;

	/** How long the token lives at most, in seconds. */
	lifetimeSeconds: number;

	/** The sign-in token's `exp`, in seconds since the Unix epoch: after `issuedAt`. */
	signInExpiresAt: number;

	/** The identity provider's subject, the sign-in token's `sub`. */
	subject: string;
}

/**
 * A signed-in principal's payload, version 1: `sub` the identity provider's subject, the configured
 * `iss`, the audience as one string in `aud`, `iat` and `generatedAt` the instant it is computed and
 * issued at, `exp` the soonest of a token lifetime later, the sign-in token's `exp` and the earliest
 * expiry among the recorded grants the calculation drew on, and what the calculation holds and offers.
 * The sign-in token's `exp` and that earliest expiry must each be after the instant of issue, so the
 * token lives at least one second. It carries version 1's members and no other, whatever else the
 * calculation holds.
 *
 * @param calculation what the principal holds, and what the audience offers.
 * @param issuing the audience, the instant, the issuer, the token lifetime, the sign-in token's `exp`
 *   and the subject.
 */
export const signedInPayload = (
	calculation: Calculation,
	{ audience, issuedAt, issuer, lifetimeSeconds, signInExpiresAt, subject }: SignedInIssuing,
): VersionOnePayload =>
	versionOnePayload(calculation, {
		audience,
		expiresAt: Math.min(
			issuedAt + lifetimeSeconds,
			signInExpiresAt,
			calculation.earliestGrantExpiry ?? Number.POSITIVE_INFINITY,
		),
		issuedAt,
		issuer,
		subject,
	});
