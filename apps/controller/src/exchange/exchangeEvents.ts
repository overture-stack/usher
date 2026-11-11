import { type AuditEvent, eventInstant } from '../eventLog/index.js';
import type { SignInRefusal } from '../signInTokens/index.js';
import type { ConferringRule } from '../tokenCalculation/index.js';

/** Why an exchange was not judged through a fault, the code answered: the identity provider's keys could not be had. */
export type ExchangeFault = 'identityProviderUnavailable';

/**
 * Why a credential's exchange was denied: the judgement's refusal, or a signing key not confirmed yet,
 * which a made-up key id or a routine key rotation produces, so no fault in the controller.
 */
export type ExchangeDenial = SignInRefusal | 'signingKeyUnconfirmed';

/** An Usher token issued, as its `token.exchange` records it. */
export interface Issuance {
  /** The application the token was issued for. */
  audience: string;

  /** When its permissions were computed, in seconds since the Unix epoch. */
  generatedAt: number;

  /** The recorded grants that reached it. */
  grantCount: number;

  /** The rules that conferred an entry. */
  rules: readonly ConferringRule[];

  sourceIp: string;

  /** Its `sub`: the identity provider's subject, or `null` for the anonymous visitor. */
  subject: string | null;

  /** Its lifetime, `exp` less `iat`, in seconds. */
  tokenTtl: number;
}

const TYPE = 'token.exchange';

/**
 * The `token.exchange` of a token issued, at info: `succeeded`, its subject as `userId`, its lifetime
 * as `tokenTtl`, the recorded grants counted as `grantCount`, never their values, the conferring
 * `rules`, its `audience`, and `generatedAt` as an instant.
 *
 * @param issuance what was issued, and for whom.
 */
export const issuedExchangeEvent = ({
  audience,
  generatedAt,
  grantCount,
  rules,
  sourceIp,
  subject,
  tokenTtl,
}: Issuance): AuditEvent => ({
  data: {
    audience,
    generatedAt: eventInstant(generatedAt * 1000),
    grantCount,
    result: 'succeeded',
    rules: [...rules],
    sourceIp,
    tokenTtl,
    userId: subject,
  },
  severity: 'info',
  type: TYPE,
});

/**
 * The `token.exchange` of a credential refused, or of one whose signing key is not confirmed yet, at
 * warning: `denied`, under its reason, naming no `userId`, and the token's subject in `refusedSubject`
 * only where the judgement names it, so a token that did not verify can put no subject in the trail.
 *
 * @param refusal the reason, the subject the judgement names if any, and the request's address.
 */
export const deniedExchangeEvent = ({
  reason,
  refusedSubject,
  sourceIp,
}: {
  reason: ExchangeDenial;
  refusedSubject?: string;
  sourceIp: string;
}): AuditEvent => ({
  data: {
    reason,
    ...(refusedSubject === undefined ? {} : { refusedSubject }),
    result: 'denied',
    sourceIp,
    userId: null,
  },
  severity: 'warning',
  type: TYPE,
});

/**
 * The `token.exchange` of an exchange an identity provider that cannot be reached kept from being
 * judged, at error: `failed`, under the code answered, naming no `userId`.
 *
 * @param failure the code answered, and the request's address.
 */
export const failedExchangeEvent = ({
  reason,
  sourceIp,
}: {
  reason: ExchangeFault;
  sourceIp: string;
}): AuditEvent => ({
  data: { reason, result: 'failed', sourceIp, userId: null },
  severity: 'error',
  type: TYPE,
});
