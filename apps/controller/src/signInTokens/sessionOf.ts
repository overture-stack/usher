import type { TokenClaims } from '../identityProvider/index.js';
import { isTime } from './isTime.js';
import type { Session } from './types.js';

/**
 * Reads the session a token names: its `iat` where that is a time, and its `sid` where that is text.
 * Read once `readNames` has accepted the token's names, which refuses a `sid` that is not text
 * the store can hold.
 *
 * @param claims the token's claims.
 */
export const sessionOf = (claims: TokenClaims): Session => {
	const { iat, sid } = claims;
	return {
		...(isTime(iat) ? { issuedAt: iat } : {}),
		...(typeof sid === 'string' ? { sid } : {}),
	};
};
