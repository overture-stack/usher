import { webcrypto } from 'node:crypto';

import type { Clock } from '@overture-stack/usher-express-bridge';
import { type NonEmpty, PAYLOAD_VERSION } from '@overture-stack/usher-types';

import {
  createChannelAssertion,
  createTokenReader,
  importApplicationKey,
  type TokenReading,
} from './bridgeWire.js';
import type { ControllerApplication } from './controller.js';
import type { IdentityProvider, MintOptions } from './identityProvider.js';

/** A person as the tests name one: the identity provider's subject for them, and their address. */
export interface Person {
  /** An address at example.org. */
  email: string;

  subject: string;
}

/** An answer as a test reads it: the status, the headers and the body's text. */
export interface WireResponse {
  body: string;
  headers: Headers;
  status: number;
}

/**
 * What one exchange sends. Every member but the application defaults to what the bridge sends; the
 * rest are for the malformed-request tests.
 */
export interface ExchangeRequest {
  /** The application whose channel assertion authenticates the exchange, signed under its key. */
  application: ControllerApplication;

  /** A channel assertion sent in place of a fresh one; `null` sends no `authorization` header. */
  assertion?: string | null;

  /** A raw body sent in place of the JSON the bridge builds. */
  body?: string;

  /**
   * The person's credential: a sign-in token, or an opaque credential such as an API key. Absent or
   * `null` for the anonymous exchange, whose body carries no `credential`.
   */
  credential?: string | null;

  /** Members merged over the body's own, so one can also replace `credential` or `payloadVersions`. */
  extraMembers?: Readonly<Record<string, unknown>>;

  /** Headers merged over the bridge's, by lower-case name; one set to `undefined` is left out. */
  headers?: Readonly<Record<string, string | undefined>>;

  /** The payload versions listed: `[1]`, the version usher-types reads, by default. */
  payloadVersions?: readonly number[];

  signal?: AbortSignal;
}

/** What reading an Usher token needs beyond the token. */
export interface UsherTokenReadOptions {
  /** The application the token was issued for: its id is the audience, its key decrypts. */
  application: ControllerApplication;

  /** The controller's issuer, which the token's `iss` must be. */
  issuer: string;

  /** The payload versions the reader accepts: `[1]` by default. */
  payloadVersions?: NonEmpty<number>;

  /** The clock `exp` is checked against: the system's by default. */
  wallClock?: Clock;
}

const person = (email: string, subject: string): Person =>
  Object.freeze({ email, subject });

/**
 * The people the tests name, one cast for every ticket, each an invented subject and an example.org
 * address. The subjects take the forms a provider can send: Keycloak's UUIDs (Ana, Dana, Eli, Fen),
 * characters needing escaping (Bo), a pair differing only in letter case (Cy and Cy2), non-ASCII text
 * beyond what OpenID Connect allows, as a hostile provider could send (Émile), and the 255 ASCII
 * characters OpenID Connect allows at most (Long). The administrator is one by the management token's
 * realm role alone; Fen is for a subject the controller has never seen, so no fixture seeds Fen.
 *
 * Four more carry subjects a generic provider can issue and an encoder or a query can mishandle: a
 * quote and a backslash (`quoted`); a quote, a backslash, a line break, U+2028 and markup (`markup`);
 * and SQL's `LIKE` wildcards (`wildcard`, `a_b%`), with a subject they would match
 * (`wildcardLookalike`, `axbyz`).
 */
export const PEOPLE = Object.freeze({
  administrator: person('admin@example.org', 'admin-0001'),
  ana: person('ana@example.org', '0b7c2f1e-5d1a-4c3e-9f2a-6e8d4b1a7c90'),
  bo: person('bo@example.org', 'auth0|bo+test/='),
  cy: person('cy@example.org', 'cy-CASE'),
  cy2: person('cy2@example.org', 'cy-case'),
  dana: person('dana@example.org', '5d7a3e90-b8c4-4f21-8e6b-0a9c7d2f1e43'),
  eli: person('eli@example.org', 'e1b6f2a8-9d03-4c7e-b5a4-6f8e0c3d2a17'),
  emile: person('emile@example.org', 'émile-ü'),
  fen: person('fen@example.org', '9c3e7a14-6b2d-4f80-a1e9-d4b8c5f07e62'),
  long: person(
    'long@example.org',
    'long-'.padEnd(255, 'abcdefghijklmnopqrstuvwxyz0123456789'),
  ),
  markup: person('markup@example.org', 'q"b\\l\nu  </script>'),
  owner: person('owner@example.org', 'owner-0001'),
  quoted: person('quoted@example.org', 'auth0|a"b\\c'),
  wildcard: person('wildcard@example.org', 'a_b%'),
  wildcardLookalike: person('lookalike@example.org', 'axbyz'),
});

/** A person's name in {@link PEOPLE}. */
export type PersonName = keyof typeof PEOPLE;

/** The system's wall clock, as the bridge's own default reads it. */
export const SYSTEM_CLOCK: Clock = Object.freeze({ now: () => Date.now() });

/**
 * Headers merged over a request's defaults by lower-case name, leaving out each set to `undefined`.
 *
 * @param defaults the request's own headers, by lower-case name.
 * @param overrides a test's headers.
 */
export const mergedHeaders = (
  defaults: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> =>
  Object.fromEntries(
    Object.entries({
      ...defaults,
      ...Object.fromEntries(
        Object.entries(overrides).map(([name, value]) => [
          name.toLowerCase(),
          value,
        ]),
      ),
    }).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])),
  );

/**
 * Signs a fresh channel assertion for an application as the bridge signs one, under the HKDF subkey
 * of its key, against the system's clock.
 *
 * @param application the application the assertion names as its issuer.
 */
export const freshAssertion = async (
  application: ControllerApplication,
): Promise<string> => {
  const { channelAssertionKey } = await importApplicationKey(application.key);
  return createChannelAssertion({
    application: application.id,
    assertionKey: channelAssertionKey,
    wallClock: SYSTEM_CLOCK,
  })();
};

/**
 * The `authorization` header a channel request carries: a fresh assertion by default, a given one,
 * or none.
 *
 * @param application the application signing.
 * @param assertion a given assertion, or `null` for none.
 */
export const authorizationFor = async (
  application: ControllerApplication,
  assertion: string | null | undefined,
): Promise<Readonly<Record<string, string>>> => {
  if (assertion === null) {
    return {};
  }
  return {
    authorization: `Bearer ${assertion ?? (await freshAssertion(application))}`,
  };
};

/**
 * Sends `POST exchange`, relative to the controller's URL, exactly as the bridge's controller client
 * sends it: `accept: application/jwt`, `authorization: Bearer` and a fresh channel assertion,
 * `content-type: application/json`, and the body `{ credential, payloadVersions }`, `credential`
 * left out for the anonymous exchange. A redirect is answered back rather than followed, as the bridge
 * never follows one. Follows `controllerClient.ts` `createFetchControllerClient`, its `exchange`.
 *
 * @param controllerUrl the controller's URL, ending in `/`.
 * @param request the application, the credential and any departure from the bridge's request.
 */
export const exchange = async (
  controllerUrl: URL,
  {
    application,
    assertion,
    body,
    credential,
    extraMembers = {},
    headers = {},
    payloadVersions = [PAYLOAD_VERSION],
    signal,
  }: ExchangeRequest,
): Promise<WireResponse> => {
  const response = await fetch(new URL('exchange', controllerUrl), {
    body:
      body ??
      JSON.stringify({
        ...(credential === undefined || credential === null
          ? {}
          : { credential }),
        payloadVersions,
        ...extraMembers,
      }),
    headers: mergedHeaders(
      {
        accept: 'application/jwt',
        ...(await authorizationFor(application, assertion)),
        'content-type': 'application/json',
      },
      headers,
    ),
    method: 'POST',
    redirect: 'manual',
    ...(signal === undefined ? {} : { signal }),
  });
  return {
    body: await response.text(),
    headers: response.headers,
    status: response.status,
  };
};

const COMPACT_JWE = /^[\w-]+\.[\w-]*\.[\w-]+\.[\w-]+\.[\w-]+$/u;

/**
 * Whether an answer's body is a compact JWE, the form an Usher token travels in, once trimmed.
 *
 * @param body the answer's body.
 */
export const carriesToken = (body: string): boolean =>
  COMPACT_JWE.test(body.trim());

/**
 * The headers whose value differs between any two answers by its nature, whatever was answered: the
 * instant the answer was sent (`date`), and a correlation id a server or a proxy in front of it may
 * set per request (`request-id`, `x-request-id`, `x-correlation-id`, the W3C trace context's
 * `traceparent` and `tracestate`, and the common tracing headers).
 */
export const PER_ANSWER_HEADERS: ReadonlySet<string> = new Set([
  'date',
  'request-id',
  'traceparent',
  'tracestate',
  'x-amzn-trace-id',
  'x-correlation-id',
  'x-request-id',
  'x-trace-id',
]);

/** A refusal in the form two refusals that must be identical on the wire are compared by. */
export interface ComparableWireRefusal {
  /** The body's text, exactly as received. */
  body: string;

  /**
   * Every header by lower-case name, sorted by name, each with its value; a header of
   * {@link PER_ANSWER_HEADERS} with its value left out, its name kept.
   */
  headers: readonly (readonly [string, string | null])[];

  status: number;
}

/**
 * A refusal at the exchange or the channel as two that must be identical are compared (#209, #210,
 * #215): the same status, the same body text, and the same headers, every name compared and every
 * value but those of {@link PER_ANSWER_HEADERS}, whose names alone are compared. A header one refusal
 * carries and the other lacks tells them apart, and so does a connection header's value, since it is
 * on the wire too and a controller sets it alike for every refusal; only a value that differs between
 * any two answers by its nature is left out.
 *
 * @param answer the exchange's or the poll's answer.
 */
export const comparableWireRefusal = (
  answer: WireResponse,
): ComparableWireRefusal => ({
  body: answer.body,
  headers: [...answer.headers]
    .map(([name, value]): readonly [string, string | null] => [
      name.toLowerCase(),
      PER_ANSWER_HEADERS.has(name.toLowerCase()) ? null : value,
    ])
    .toSorted(([first], [second]) => first.localeCompare(second)),
  status: answer.status,
});

/**
 * Reads an exchange's answer as the bridge reads the Usher token in it: trimmed, then through the
 * reproduced token reader in `bridgeWire.ts`, under the application key's token subkey.
 *
 * @param body the answer's body.
 * @param options the application, the controller's issuer, and the reader's versions and clock.
 */
export const readUsherToken = async (
  body: string,
  {
    application,
    issuer,
    payloadVersions = [PAYLOAD_VERSION],
    wallClock = SYSTEM_CLOCK,
  }: UsherTokenReadOptions,
): Promise<TokenReading> => {
  const { tokenKey } = await importApplicationKey(application.key);
  return createTokenReader({
    audience: application.id,
    issuer,
    payloadVersions,
    tokenKey,
    wallClock,
  }).read(body.trim());
};

/**
 * The claims of a person's sign-in token for an application, over the stand-in's Keycloak-shaped
 * defaults: `aud` the application's id alone, and the person's subject and address.
 *
 * @param person who signs in.
 * @param application the application's id, the audience.
 */
export const signInClaims = (
  person: Person,
  application: string,
): Readonly<Record<string, unknown>> => ({
  aud: [application],
  email: person.email,
  preferred_username: person.email,
  sub: person.subject,
});

/**
 * Mints a person's sign-in token for an application from the identity provider stand-in.
 *
 * @param provider the stand-in.
 * @param person who signs in.
 * @param application the application's id, the audience.
 * @param options claims and header members over these, and the key and lifetime.
 */
export const mintSignInToken = (
  provider: IdentityProvider,
  person: Person,
  application: string,
  options: MintOptions = {},
): Promise<string> =>
  provider.mint({
    ...options,
    claims: { ...signInClaims(person, application), ...options.claims },
  });

/**
 * An application key's 32 bytes.
 *
 * @param application the application.
 */
export const applicationKeyBytes = (
  application: ControllerApplication,
): Uint8Array => new Uint8Array(Buffer.from(application.key, 'base64url'));

/**
 * Imports 32 bytes as an AES-GCM key for decryption alone, the form in which the bridge holds its
 * token key.
 *
 * @param bytes the key's bytes.
 */
export const decryptionKey = (
  bytes: Uint8Array,
): Promise<webcrypto.CryptoKey> =>
  webcrypto.subtle.importKey(
    'raw',
    bytes,
    { length: 256, name: 'AES-GCM' },
    false,
    ['decrypt'],
  );

/**
 * Reads an exchange's answer through the bridge's token reader under a key of the test's choosing,
 * such as another application's, to show a token opens under its own application's token subkey
 * alone.
 *
 * @param body the answer's body.
 * @param options the audience and issuer pinned, and the key.
 */
export const readUnderKey = (
  body: string,
  {
    audience,
    issuer,
    tokenKey,
  }: { audience: string; issuer: string; tokenKey: webcrypto.CryptoKey },
): Promise<TokenReading> =>
  createTokenReader({
    audience,
    issuer,
    payloadVersions: [PAYLOAD_VERSION],
    tokenKey,
    wallClock: SYSTEM_CLOCK,
  }).read(body.trim());
