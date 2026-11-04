import { randomUUID } from 'node:crypto';

import { SignJWT } from 'jose';

import type { Clock } from './clocks.js';
import type { CryptoKey } from './keys.js';

/** The audience named by every channel assertion: the controller, for its exchange, push and poll. */
export const CHANNEL_ASSERTION_AUDIENCE = 'usher:controller';

/** The `typ` of every channel assertion. */
export const CHANNEL_ASSERTION_TYPE = 'usher-channel+jwt';

const LIFETIME_S = 60;

/**
 * Creates the signer of channel assertions, the short-lived tokens that tell the controller which
 * application is asking. Each call signs a new HS256 JWS under `assertionKey`, issued by
 * `application`, the bridge's own audience, and carrying no `kid`.
 *
 * @returns the signer; each promise it returns rejects when jose cannot sign under `assertionKey`.
 */
export const createChannelAssertion = ({
  application,
  assertionKey,
  wallClock,
}: {
  application: string;
  assertionKey: CryptoKey;
  wallClock: Clock;
}): (() => Promise<string>) => {
  return () => {
    const issuedAt = Math.floor(wallClock.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: CHANNEL_ASSERTION_TYPE })
      .setIssuer(application)
      .setAudience(CHANNEL_ASSERTION_AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + LIFETIME_S)
      .setJti(randomUUID())
      .sign(assertionKey);
  };
};
