import type { Calculation } from '../tokenCalculation/index.js';
import type { VersionOnePayload } from '../usherToken/index.js';
import { versionOnePayload } from './versionOnePayload.js';

/** When and by whom an anonymous token is issued, and for which audience. */
export interface AnonymousIssuing {
	/** The application the token is issued for, its `aud`. */
	audience: string;

	/** The instant of issue and of the computation, in whole seconds since the Unix epoch. */
	issuedAt: number;

	/** The Controller's own issuer, its `iss`. */
	issuer: string;

	/** How long the token lives, in seconds. */
	lifetimeSeconds: number;
}

/**
 * The anonymous visitor's payload, version 1: `sub` `null`, the configured `iss`, the audience as one
 * string in `aud`, `iat` and `generatedAt` the instant it is computed and issued at, `exp` a token
 * lifetime later, and what the calculation holds and offers. It is built member by member, so it
 * carries version 1's members and no other, whatever else the calculation holds.
 *
 * @param calculation what the anonymous visitor holds, and what the audience offers.
 * @param issuing the audience, the instant, the issuer and the token lifetime.
 */
export const anonymousPayload = (
	calculation: Calculation,
	{ audience, issuedAt, issuer, lifetimeSeconds }: AnonymousIssuing,
): VersionOnePayload =>
	versionOnePayload(calculation, {
		audience,
		expiresAt: issuedAt + lifetimeSeconds,
		issuedAt,
		issuer,
		subject: null,
	});
