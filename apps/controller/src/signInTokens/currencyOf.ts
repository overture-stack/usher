import { CLOCK_TOLERANCE_MILLISECONDS } from '../configuration/index.js';
import type { TokenClaims } from '../identityProvider/index.js';
import { isTime } from './isTime.js';
import type { CurrencyRefusal, TokenCurrency } from './types.js';

const refused = (reason: CurrencyRefusal): TokenCurrency => ({
  kind: 'refused',
  reason,
});

/**
 * Judges a token's times at an instant, each within {@link CLOCK_TOLERANCE_MILLISECONDS}: its `exp`,
 * which is required and must not have passed, then its `nbf`, which, when present, must be a time
 * already reached.
 *
 * @param claims the token's claims.
 * @param now the instant, in milliseconds since the Unix epoch.
 */
export const currencyOf = (claims: TokenClaims, now: number): TokenCurrency => {
  const { exp, nbf } = claims;
  if (!isTime(exp)) {
    return refused('missingExpiry');
  }
  if (now >= exp * 1000 + CLOCK_TOLERANCE_MILLISECONDS) {
    return refused('expiredToken');
  }
  return nbf === undefined ||
    (isTime(nbf) && nbf * 1000 <= now + CLOCK_TOLERANCE_MILLISECONDS)
    ? { expiresAt: exp, kind: 'current' }
    : refused('notYetValid');
};
