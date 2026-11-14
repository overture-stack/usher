import { CLOCK_TOLERANCE_MILLISECONDS } from '../configuration/index.js';
import type { TokenClaims } from '../identityProvider/index.js';
import { EXCESSIVE_LIFETIME } from './excessiveLifetime.js';
import { isTime } from './isTime.js';
import { MISSING_ISSUED_AT } from './missingIssuedAt.js';
import type {
  CurrencyRefusal,
  CurrencySettings,
  TokenCurrency,
} from './types.js';

const refused = (reason: CurrencyRefusal): TokenCurrency => ({
  kind: 'refused',
  reason,
});

/**
 * Judges a token's times at an instant, in this order. Its `exp` is required and must not have passed,
 * within {@link CLOCK_TOLERANCE_MILLISECONDS}. Its `iat` is required, else it is refused as
 * {@link MISSING_ISSUED_AT}, and its `exp` must fall at most the longest lifetime a token may have after
 * it, compared exactly, with no clock tolerance: a token living exactly that long is current, and one
 * living a second longer is refused as {@link EXCESSIVE_LIFETIME}. Its `nbf`, when present, must be a
 * time already reached, within the clock tolerance.
 *
 * @param claims the token's claims.
 * @param settings the longest lifetime a token may have, in seconds.
 * @param now the instant, in milliseconds since the Unix epoch.
 */
export const currencyOf = (
  claims: TokenClaims,
  { signInTokenMaximumLifetimeSeconds }: CurrencySettings,
  now: number,
): TokenCurrency => {
  const { exp, iat, nbf } = claims;
  if (!isTime(exp)) {
    return refused('missingExpiry');
  }
  if (now >= exp * 1000 + CLOCK_TOLERANCE_MILLISECONDS) {
    return refused('expiredToken');
  }
  if (!isTime(iat)) {
    return refused(MISSING_ISSUED_AT);
  }
  if (exp - iat > signInTokenMaximumLifetimeSeconds) {
    return refused(EXCESSIVE_LIFETIME);
  }
  return nbf === undefined ||
    (isTime(nbf) && nbf * 1000 <= now + CLOCK_TOLERANCE_MILLISECONDS)
    ? { expiresAt: exp, kind: 'current' }
    : refused('notYetValid');
};
