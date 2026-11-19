import type { Calculation } from '../tokenCalculation/index.js';
import type { VersionOnePayload } from '../usherToken/index.js';

/** What a payload names beside what the calculation holds and offers. */
export interface PayloadNames {
	/** The application the token is issued for, its `aud`. */
	audience: string;

	/** When the token expires, its `exp`, in whole seconds since the Unix epoch. */
	expiresAt: number;

	/** The instant of issue and of the computation, in whole seconds since the Unix epoch. */
	issuedAt: number;

	/** The Controller's own issuer, its `iss`. */
	issuer: string;

	/** Its `sub`: the identity provider's subject, or `null` for the anonymous visitor. */
	subject: string | null;
}

/**
 * A version 1 payload: the subject, the issuer, the audience as one string in `aud`, `iat` and
 * `generatedAt` the instant it is computed and issued at, the expiry given as `exp`, and what the
 * calculation holds and offers. It is built member by member, so it carries version 1's members and
 * no other, whatever else the calculation holds.
 *
 * @param calculation what the principal holds, and what the audience offers.
 * @param names the audience, the expiry, the instant, the issuer and the subject.
 */
export const versionOnePayload = (
	{ globalCategories, permissions, resourceCategories, servedResources }: Calculation,
	{ audience, expiresAt, issuedAt, issuer, subject }: PayloadNames,
): VersionOnePayload => ({
	aud: audience,
	exp: expiresAt,
	generatedAt: issuedAt,
	globalCategories,
	iat: issuedAt,
	iss: issuer,
	payloadVersion: 1,
	permissions,
	resourceCategories,
	servedResources,
	sub: subject,
});
