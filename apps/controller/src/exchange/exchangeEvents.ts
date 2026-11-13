import {
  type AuditEvent,
  eventInstant,
  REFUSED_SUBJECT_MAXIMUM_LENGTH,
} from '../eventLog/index.js';
import type { SignInRefusal, StoredRefusal } from '../signInTokens/index.js';
import type { ConferringRule } from '../tokenCalculation/index.js';

/** Why an exchange was not judged through a fault, the code answered: the identity provider's keys could not be had. */
export type ExchangeFault = 'identityProviderUnavailable';

/**
 * Why a credential's exchange was denied: the judgement's refusal; a signing key not confirmed yet,
 * which a made-up key id or a routine key rotation produces, so no fault in the controller; a service
 * account's token (`serviceAccountNotPermitted`); or the store's refusal of the principal.
 */
export type ExchangeDenial =
  | SignInRefusal
  | StoredRefusal
  | 'serviceAccountNotPermitted'
  | 'signingKeyUnconfirmed';

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
 * warning: `denied`, under its reason, naming no `userId`. It names the subject given in
 * `refusedSubject` whole when that is at most {@link REFUSED_SUBJECT_MAXIMUM_LENGTH} characters, and
 * leaves the member out for a longer one, never cut short, or where none is given. A subject given
 * must be that of a token whose signature verified, so a forged token can put no subject in the trail.
 *
 * @param refusal the reason, the verified token's subject if it is named, and the request's address.
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
    ...(refusedSubject !== undefined &&
    refusedSubject.length <= REFUSED_SUBJECT_MAXIMUM_LENGTH
      ? { refusedSubject }
      : {}),
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
