import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { CLOCK_TOLERANCE_MILLISECONDS } from '../configuration/index.js';
import { REFUSED_SUBJECT_MAXIMUM_LENGTH } from '../eventLog/index.js';
import type { TokenClaims, TokenHeader } from '../identityProvider/index.js';
import { readSignInClaims } from './readSignInClaims.js';

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);

const SECONDS = Math.floor(NOW / 1000);

const TOLERANCE_SECONDS = CLOCK_TOLERANCE_MILLISECONDS / 1000;

const AUDIENCE = '7f3c2a9e-1d4b-4c8e-9a6f-2b5d8e1c0a47';

const BACK_CHANNEL_LOGOUT_EVENT =
  'http://schemas.openid.net/event/backchannel-logout';

const HEADER: TokenHeader = Object.freeze({
  alg: 'RS256',
  kid: 'key-1',
  typ: 'JWT',
});

// A Keycloak access token's claims for the calling application, its `aud` a list as Keycloak sends it.
const claimsWith = (
  departures: Readonly<Record<string, unknown>> = {},
): TokenClaims =>
  Object.fromEntries(
    Object.entries({
      aud: ['account', AUDIENCE],
      azp: 'search-portal',
      exp: SECONDS + 300,
      iat: SECONDS - 10,
      iss: 'https://auth.example.org/realms/usher',
      sid: 'session-1',
      sub: 'subject-ana',
      typ: 'Bearer',
      ...departures,
    }).filter(([, value]) => value !== undefined),
  );

const read = (
  departures?: Readonly<Record<string, unknown>>,
  header: TokenHeader = HEADER,
) =>
  readSignInClaims({ claims: claimsWith(departures), header }, AUDIENCE, NOW);

const naming = (reason: string, refusedSubject = 'subject-ana') => ({
  kind: 'refused',
  reason,
  refusedSubject,
});

const unnamed = (reason: string) => ({ kind: 'refused', reason });

suite("the exchange's reading of a sign-in token's claims", () => {
  test('accepts a token whose aud names the calling application, giving its subject, its session and its exp', () => {
    assert.deepEqual(read(), {
      expiresAt: SECONDS + 300,
      kind: 'accepted',
      session: { issuedAt: SECONDS - 10, sid: 'session-1' },
      subject: 'subject-ana',
    });
  });

  test('accepts an aud naming the calling application as a string or among a list, and refuses every other as otherAudience, naming the subject', () => {
    const accepted = [read({ aud: AUDIENCE }), read({ aud: [AUDIENCE] })];
    const refused = [
      undefined,
      'account',
      ['account'],
      [],
      AUDIENCE.toUpperCase(),
      `${AUDIENCE} `,
      [[AUDIENCE]],
      { [AUDIENCE]: true },
    ].map((aud) => read({ aud }));

    accepted.forEach((reading) => assert.equal(reading.kind, 'accepted'));
    refused.forEach((reading) =>
      assert.deepEqual(reading, naming('otherAudience')),
    );
  });

  test('refuses a token naming no expiry, or one that is not a number, as missingExpiry, naming the subject', () => {
    [undefined, String(SECONDS + 300), null].forEach((exp) =>
      assert.deepEqual(read({ exp }), naming('missingExpiry')),
    );
  });

  test('refuses a token past its expiry by the clock tolerance or more as expiredToken, naming the subject, and accepts one within it', () => {
    assert.deepEqual(
      read({ exp: SECONDS - TOLERANCE_SECONDS }),
      naming('expiredToken'),
    );
    assert.deepEqual(read({ exp: SECONDS - 3600 }), naming('expiredToken'));
    assert.equal(
      read({ exp: SECONDS - TOLERANCE_SECONDS + 1 }).kind,
      'accepted',
    );
  });

  test('refuses a token whose nbf is ahead by more than the clock tolerance, or is no number, as notYetValid, naming the subject, and accepts one within it', () => {
    [SECONDS + TOLERANCE_SECONDS + 1, 'soon', null].forEach((nbf) =>
      assert.deepEqual(read({ nbf }), naming('notYetValid')),
    );
    assert.equal(read({ nbf: SECONDS + TOLERANCE_SECONDS }).kind, 'accepted');
  });

  test("refuses every other token issued by Keycloak, by its payload's typ, as otherType, naming no subject", () => {
    ['ID', 'Refresh', 'Offline', 'Logout', 'DPoP', 'Serialized-ID'].forEach(
      (typ) => assert.deepEqual(read({ typ }), unnamed('otherType')),
    );
  });

  test('refuses a token naming no payload typ, or one that is not the text Bearer, as otherType, naming no subject', () => {
    [undefined, 7, ['Bearer']].forEach((typ) =>
      assert.deepEqual(read({ typ }), unnamed('otherType')),
    );
  });

  test("refuses a logout token as otherType by its events or its header's type, whatever else it carries, a payload typ of Bearer included, naming no subject", () => {
    const logoutEvents = [
      { [BACK_CHANNEL_LOGOUT_EVENT]: {} },
      { [BACK_CHANNEL_LOGOUT_EVENT]: true },
    ];
    const logoutTypes = [
      'logout+jwt',
      'Logout+JWT',
      'application/logout+jwt',
      'APPLICATION/LOGOUT+JWT',
    ];
    const readings = [
      ...logoutEvents.map((events) => read({ events })),
      ...logoutTypes.map((typ) => read({}, { ...HEADER, typ })),
      read({ events: logoutEvents[0], exp: SECONDS - 3600, sub: undefined }),
      read({ aud: 'account', events: logoutEvents[0], sid: 'session\u0000' }),
    ];

    readings.forEach((reading) =>
      assert.deepEqual(reading, unnamed('otherType')),
    );
  });

  test("accepts an access token whatever its header's type: JWT, at+jwt, another kind, or none", () => {
    const headers: readonly TokenHeader[] = [
      HEADER,
      { ...HEADER, typ: 'at+jwt' },
      { ...HEADER, typ: 'application/jwt' },
      Object.fromEntries(
        Object.entries(HEADER).filter(([name]) => name !== 'typ'),
      ),
    ];

    headers.forEach((header) =>
      assert.equal(read({}, header).kind, 'accepted'),
    );
  });

  test('refuses an access token naming no subject, an empty one or one that is not text as missingSubject, naming none', () => {
    [undefined, '', 7, null, ['subject-ana']].forEach((sub) =>
      assert.deepEqual(read({ sub }), unnamed('missingSubject')),
    );
  });

  test('refuses a subject holding text the store cannot hold as unrepresentableSubject, naming none', () => {
    ['subject\u0000ana', 'subject-\uD800ana', '\uDC00'].forEach((sub) =>
      assert.deepEqual(read({ sub }), unnamed('unrepresentableSubject')),
    );
  });

  test('refuses a sid that is not text the store can hold, one that is not text among them, as unrepresentableSubject, naming no subject', () => {
    ['session\u0000', 'session-\uD800', 42, null, { id: 'session-1' }].forEach(
      (sid) =>
        assert.deepEqual(read({ sid }), unnamed('unrepresentableSubject')),
    );
  });

  test('reads the session of a token naming no sid, or no iat that is a time, without it', () => {
    const readings = [
      read({ sid: undefined }),
      read({ iat: undefined }),
      read({ iat: String(SECONDS - 10) }),
    ];

    assert.deepEqual(
      readings.map((reading) =>
        reading.kind === 'accepted' ? reading.session : undefined,
      ),
      [{ issuedAt: SECONDS - 10 }, { sid: 'session-1' }, { sid: 'session-1' }],
    );
  });

  test('names a subject of 255 characters whole as refusedSubject, and leaves one of 256 out, never cut short', () => {
    const atTheLimit = 'a'.repeat(REFUSED_SUBJECT_MAXIMUM_LENGTH);
    const pastTheLimit = 'b'.repeat(REFUSED_SUBJECT_MAXIMUM_LENGTH + 1);

    assert.equal(REFUSED_SUBJECT_MAXIMUM_LENGTH, 255);
    assert.deepEqual(
      read({ exp: SECONDS - 3600, sub: atTheLimit }),
      naming('expiredToken', atTheLimit),
    );
    assert.deepEqual(
      read({ exp: SECONDS - 3600, sub: pastTheLimit }),
      unnamed('expiredToken'),
    );
  });

  test('judges the type before the subject and session, those before the times, and the times before the audience', () => {
    assert.deepEqual(read({ sub: undefined, typ: 'ID' }), unnamed('otherType'));
    assert.deepEqual(
      read({ aud: 'account', exp: SECONDS - 3600, typ: 'Refresh' }),
      unnamed('otherType'),
    );
    assert.deepEqual(
      read({ exp: SECONDS - 3600, sub: 'subject\u0000ana' }),
      unnamed('unrepresentableSubject'),
    );
    assert.deepEqual(
      read({ exp: undefined, sid: 'session\u0000' }),
      unnamed('unrepresentableSubject'),
    );
    assert.deepEqual(
      read({ sid: 42, sub: undefined }),
      unnamed('missingSubject'),
    );
    assert.deepEqual(
      read({ aud: 'account', exp: SECONDS - 3600 }),
      naming('expiredToken'),
    );
  });
});
