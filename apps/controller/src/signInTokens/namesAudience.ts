import type { TokenClaims } from '../identityProvider/index.js';

/**
 * Whether a token's `aud`, one string or a list as Keycloak sends it, names the audience given.
 *
 * @param claims the token's claims.
 * @param audience the audience it must name.
 */
export const namesAudience = (claims: TokenClaims, audience: string): boolean => {
	const { aud } = claims;
	const audiences: readonly unknown[] = Array.isArray(aud) ? aud : [aud];
	return audiences.includes(audience);
};
