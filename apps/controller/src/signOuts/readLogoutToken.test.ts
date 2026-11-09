import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { CLOCK_TOLERANCE_MILLISECONDS } from '../configuration/index.js';
import type { TokenClaims, TokenHeader } from '../identityProvider/index.js';
import {
  BACK_CHANNEL_LOGOUT_EVENT,
  readLogoutToken,
  REFUSED_SUBJECT_MAXIMUM_LENGTH,
} from './readLogoutToken.js';
import type { LogoutTokenReading, VerifiedLogoutToken } from './types.js';

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);

const SECONDS = NOW / 1000;

const TOLERANCE_SECONDS = CLOCK_TOLERANCE_MILLISECONDS / 1000;

const LONGEST_SIGN_IN_SECONDS = 3600;

const SETTINGS = Object.freeze({
  backChannelLogoutAudiences: ['portal-ui', 'submission-ui'],
  signInTokenMaximumLifetimeSeconds: LONGEST_SIGN_IN_SECONDS,
});

// A logout token's claims as OpenID Connect Back-Channel Logout 1.0 shapes them, with departures over
// them; a departure set to undefined leaves its claim out.
const claimsOf = (
  departures: Readonly<Record<string, unknown>> = {},
): TokenClaims =>
  Object.fromEntries(
    Object.entries({
      aud: ['portal-ui'],
      events: { [BACK_CHANNEL_LOGOUT_EVENT]: {} },
      exp: SECONDS + 120,
      iat: SECONDS,
      iss: 'https://auth.example.org/realms/usher',
      jti: '5f0c3a1e-8b2d-4e7f-9a6c-1d3e5b7f9a0c',
      sid: 'session-1',
      sub: 'subject-ana',
      ...departures,
    }).filter(([, value]) => value !== undefined),
  );

const headerOf = (typ: unknown): TokenHeader =>
  typ === undefined ? { alg: 'RS256' } : { alg: 'RS256', typ };

const tokenOf = (
  departures: Readonly<Record<string, unknown>> = {},
  typ: unknown = 'logout+jwt',
): VerifiedLogoutToken => ({
  claims: claimsOf(departures),
  header: headerOf(typ),
});

const read = (token: VerifiedLogoutToken): LogoutTokenReading =>
  readLogoutToken(token, SETTINGS, NOW);

const reasonOf = (token: VerifiedLogoutToken): string => {
  const reading = read(token);
  return reading.kind === 'refused' ? reading.reason : 'accepted';
};

// Every header type a logout token may carry, none among them.
const ACCEPTED_TYPES: readonly unknown[] = [
  undefined,
  'JWT',
  'jwt',
  'logout+jwt',
  'LOGOUT+JWT',
  'Logout+Jwt',
  'application/logout+jwt',
  'Application/Logout+JWT',
  'application/jwt',
];

suite('reading a verified logout token', () => {
  test('gives the session, the subject and when the token was issued, for a token naming a session and a subject', () => {
    assert.deepEqual(read(tokenOf()), {
      kind: 'accepted',
      signOut: {
        issuedAt: SECONDS,
        kind: 'session',
        sessionId: 'session-1',
        subject: 'subject-ana',
      },
    });
  });

  test('gives a session sign-out naming no subject for a token naming a session alone, and a subject sign-out for one naming a subject alone', () => {
    const sessionAlone = read(tokenOf({ sub: undefined }));
    const subjectAlone = read(tokenOf({ sid: undefined }));

    assert.deepEqual(sessionAlone, {
      kind: 'accepted',
      signOut: {
        issuedAt: SECONDS,
        kind: 'session',
        sessionId: 'session-1',
        subject: undefined,
      },
    });
    assert.deepEqual(subjectAlone, {
      kind: 'accepted',
      signOut: { issuedAt: SECONDS, kind: 'subject', subject: 'subject-ana' },
    });
  });

  test('reads aud as one configured client, or as a list of configured clients alone', () => {
    const reasons = [
      tokenOf({ aud: 'submission-ui' }),
      tokenOf({ aud: ['submission-ui', 'portal-ui'] }),
    ].map(reasonOf);

    assert.deepEqual(reasons, ['accepted', 'accepted']);
  });

  test('reads a token whose header typ is absent, or logout+jwt or JWT in any letter case, with or without the application/ prefix', () => {
    const reasons = ACCEPTED_TYPES.map((typ) => reasonOf(tokenOf({}, typ)));

    assert.deepEqual(
      reasons,
      ACCEPTED_TYPES.map(() => 'accepted'),
    );
  });

  test('reads events holding other members beside the back-channel logout one', () => {
    const reason = reasonOf(
      tokenOf({
        events: {
          [BACK_CHANNEL_LOGOUT_EVENT]: { reason: 'signed-out' },
          'https://example.org/event/other': {},
        },
      }),
    );

    assert.equal(reason, 'accepted');
  });

  test('reads a token issued ahead by less than the clock tolerance, expired by less than it or valid from no later than it, or issued the longest sign-in token lifetime ago', () => {
    const reasons = [
      tokenOf({ exp: SECONDS + 150, iat: SECONDS + TOLERANCE_SECONDS - 1 }),
      tokenOf({ exp: SECONDS - TOLERANCE_SECONDS + 1, iat: SECONDS - 150 }),
      tokenOf({ exp: SECONDS + 60, iat: SECONDS - LONGEST_SIGN_IN_SECONDS }),
      tokenOf({ nbf: SECONDS + TOLERANCE_SECONDS }),
    ].map(reasonOf);

    assert.deepEqual(reasons, ['accepted', 'accepted', 'accepted', 'accepted']);
  });
});

suite('refusing a token that is not a logout token', () => {
  test('refuses one whose events lack the back-channel logout member as a JSON object, whatever its header typ', () => {
    const departures: readonly Readonly<Record<string, unknown>>[] = [
      { events: undefined },
      { events: {} },
      { events: [BACK_CHANNEL_LOGOUT_EVENT] },
      { events: BACK_CHANNEL_LOGOUT_EVENT },
      { events: null },
      {
        events: { 'http://schemas.openid.net/event/frontchannel-logout': {} },
      },
      { events: { [BACK_CHANNEL_LOGOUT_EVENT]: true } },
      { events: { [BACK_CHANNEL_LOGOUT_EVENT]: 'logout' } },
      { events: { [BACK_CHANNEL_LOGOUT_EVENT]: [] } },
      { events: { [BACK_CHANNEL_LOGOUT_EVENT]: null } },
    ];

    const reasons = ACCEPTED_TYPES.flatMap((typ) =>
      departures.map((departure) => reasonOf(tokenOf(departure, typ))),
    );

    assert.equal(reasons.length, ACCEPTED_TYPES.length * departures.length);
    assert.deepEqual(
      reasons,
      reasons.map(() => 'notLogoutEvent'),
    );
  });

  test('refuses one carrying a nonce, as an ID token does, whatever its value and its header typ', () => {
    const nonces = ['n-0S6_WzA2Mj', '', null];

    const reasons = ACCEPTED_TYPES.flatMap((typ) =>
      nonces.map((nonce) => reasonOf(tokenOf({ nonce }, typ))),
    );

    assert.equal(reasons.length, ACCEPTED_TYPES.length * nonces.length);
    assert.deepEqual(
      reasons,
      reasons.map(() => 'carriesNonce'),
    );
  });

  test('refuses one whose header typ names any other type, whatever its letter case or prefix', () => {
    const types = [
      'at+jwt',
      'AT+JWT',
      'application/at+jwt',
      'secevent+jwt',
      'jose',
      'text/logout+jwt',
      'application/',
      'application/logout+jwt; charset=utf-8',
      'logout+jwt ',
      '',
      42,
      null,
    ];

    const reasons = types.map((typ) => reasonOf(tokenOf({}, typ)));

    assert.deepEqual(
      reasons,
      types.map(() => 'otherType'),
    );
  });
});

suite('refusing a logout token issued for another audience', () => {
  test('refuses one whose aud names no configured back-channel logout client', () => {
    const reasons = [
      tokenOf({ aud: undefined }),
      tokenOf({ aud: 'another-client' }),
      tokenOf({ aud: ['another-client'] }),
      tokenOf({ aud: [] }),
      tokenOf({ aud: 42 }),
      tokenOf({ aud: [['portal-ui']] }),
      tokenOf({ aud: 'PORTAL-UI' }),
    ].map(reasonOf);

    assert.deepEqual(
      reasons,
      reasons.map(() => 'otherAudience'),
    );
  });

  test('refuses one whose aud names a configured client beside any audience outside them', () => {
    const reasons = [
      tokenOf({ aud: ['another-client', 'portal-ui'] }),
      tokenOf({ aud: ['portal-ui', 'submission-ui', 'an-application-id'] }),
      tokenOf({ aud: ['portal-ui', 42] }),
      tokenOf({ aud: ['portal-ui', null] }),
    ].map(reasonOf);

    assert.deepEqual(
      reasons,
      reasons.map(() => 'otherAudience'),
    );
  });
});

suite('refusing a logout token that is not current', () => {
  test('refuses one naming no time of issue', () => {
    const reasons = [
      tokenOf({ iat: undefined }),
      tokenOf({ iat: String(SECONDS) }),
      tokenOf({ iat: null }),
    ].map(reasonOf);

    assert.deepEqual(reasons, [
      'missingIssuedAt',
      'missingIssuedAt',
      'missingIssuedAt',
    ]);
  });

  test('refuses one issued ahead of the clock by the clock tolerance or more as not yet valid', () => {
    const reasons = [
      tokenOf({ exp: SECONDS + 240, iat: SECONDS + TOLERANCE_SECONDS }),
      tokenOf({ exp: SECONDS + 240, iat: SECONDS + 120 }),
    ].map(reasonOf);

    assert.deepEqual(reasons, ['notYetValid', 'notYetValid']);
  });

  test('refuses one issued longer ago than the longest sign-in token lifetime, so a sign-out still held is never relayed again', () => {
    const reason = reasonOf(
      tokenOf({
        exp: SECONDS + 60,
        iat: SECONDS - LONGEST_SIGN_IN_SECONDS - 1,
      }),
    );

    assert.equal(reason, 'issuedLongAgo');
  });

  test('refuses one naming no expiry, or expired by the clock tolerance or more', () => {
    const reasons = [
      tokenOf({ exp: undefined }),
      tokenOf({ exp: String(SECONDS + 120) }),
      tokenOf({ exp: SECONDS - TOLERANCE_SECONDS, iat: SECONDS - 150 }),
      tokenOf({ exp: SECONDS - 60, iat: SECONDS - 240 }),
    ].map(reasonOf);

    assert.deepEqual(reasons, [
      'missingExpiry',
      'missingExpiry',
      'expiredToken',
      'expiredToken',
    ]);
  });

  test('refuses one not valid until later than the clock tolerance', () => {
    const reasons = [
      tokenOf({ nbf: SECONDS + TOLERANCE_SECONDS + 1 }),
      tokenOf({ nbf: 'soon' }),
    ].map(reasonOf);

    assert.deepEqual(reasons, ['notYetValid', 'notYetValid']);
  });
});

suite('refusing a logout token naming no one the store can hold', () => {
  test('refuses one naming neither a session nor a subject', () => {
    const reason = reasonOf(tokenOf({ sid: undefined, sub: undefined }));

    assert.equal(reason, 'namesNoOne');
  });

  test('refuses one whose sub or sid is not text, or is empty', () => {
    const reasons = [
      tokenOf({ sub: '' }),
      tokenOf({ sub: 42 }),
      tokenOf({ sub: null }),
      tokenOf({ sid: '' }),
      tokenOf({ sid: ['session-1'] }),
      tokenOf({ sid: null, sub: undefined }),
    ].map(reasonOf);

    assert.deepEqual(
      reasons,
      reasons.map(() => 'unreadableName'),
    );
  });

  test('refuses one whose sub or sid holds a NUL character or an unpaired surrogate', () => {
    const reasons = [
      tokenOf({ sub: 'subject\u0000ana' }),
      tokenOf({ sub: 'subject-\ud800' }),
      tokenOf({ sid: 'session\u00001' }),
      tokenOf({ sid: '\udc00session-1' }),
    ].map(reasonOf);

    assert.deepEqual(
      reasons,
      reasons.map(() => 'unrepresentableName'),
    );
  });
});

suite('naming the subject of a refused logout token', () => {
  test('names its sub when that is non-empty storable text of at most 255 characters, whatever the refusal', () => {
    const longest = 's'.repeat(REFUSED_SUBJECT_MAXIMUM_LENGTH);

    const readings = [
      read(tokenOf({ nonce: 'n-0S6_WzA2Mj' })),
      read(tokenOf({ aud: 'another-client' })),
      read(tokenOf({ sid: '' })),
      read(tokenOf({ events: undefined, sub: longest }, 'at+jwt')),
    ];

    assert.deepEqual(readings, [
      { kind: 'refused', reason: 'carriesNonce', subject: 'subject-ana' },
      { kind: 'refused', reason: 'otherAudience', subject: 'subject-ana' },
      { kind: 'refused', reason: 'unreadableName', subject: 'subject-ana' },
      { kind: 'refused', reason: 'notLogoutEvent', subject: longest },
    ]);
  });

  test('names no subject for a sub absent, not text, empty, unstorable or longer than 255 characters, never one cut short', () => {
    const subjects = [
      undefined,
      42,
      '',
      'subject\u0000ana',
      's'.repeat(REFUSED_SUBJECT_MAXIMUM_LENGTH + 1),
    ];

    const named = subjects.map((sub) => {
      const reading = read(tokenOf({ nonce: 'n-0S6_WzA2Mj', sub }));
      return reading.kind === 'refused' ? reading.subject : 'accepted';
    });

    assert.deepEqual(
      named,
      subjects.map(() => undefined),
    );
    assert.equal(REFUSED_SUBJECT_MAXIMUM_LENGTH, 255);
  });
});
