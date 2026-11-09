import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { CLOCK_TOLERANCE_MILLISECONDS } from '../configuration/index.js';
import { readManagementClaims } from './managementClaims.js';

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

const SECONDS = Math.floor(NOW / 1000);

const SETTINGS = Object.freeze({
  administratorRole: 'usher-platform-admin',
  managementAudience: 'usher-management',
  managementClients: ['usher-ui', 'usher-cli'],
});

const claimsWith = (
  departures: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    Object.entries({
      aud: ['usher-management'],
      azp: 'usher-ui',
      exp: SECONDS + 300,
      iat: SECONDS - 10,
      preferred_username: 'ana@example.org',
      realm_access: { roles: ['offline_access', 'usher-platform-admin'] },
      sid: 'session-1',
      sub: 'subject-ana',
      ...departures,
    }).filter(([, value]) => value !== undefined),
  );

const read = (departures?: Readonly<Record<string, unknown>>) =>
  readManagementClaims(claimsWith(departures), SETTINGS, NOW);

const refusal = (reason: string, subject = 'subject-ana') => ({
  kind: 'refused',
  reason,
  subject,
});

suite("reading a verified management token's claims", () => {
  test('accepts a person holding the administrator role, with the session the token names', () => {
    assert.deepEqual(read(), {
      kind: 'accepted',
      principal: {
        administrator: true,
        subject: 'subject-ana',
        type: 'human',
      },
      session: { issuedAt: SECONDS - 10, sid: 'session-1' },
    });
  });

  test('reads a person without the administrator role as no administrator', () => {
    const reading = read({ realm_access: { roles: ['offline_access'] } });

    assert.equal(
      reading.kind === 'accepted' ? reading.principal.administrator : undefined,
      false,
    );
  });

  test("tells a service account apart by either sign of Keycloak's client credentials, the administrator role notwithstanding", () => {
    const readings = [
      read({ client_id: 'lyric-svc' }),
      read({ preferred_username: 'service-account-lyric-svc' }),
    ];

    readings.forEach((reading) =>
      assert.equal(
        reading.kind === 'accepted' ? reading.principal.type : undefined,
        'serviceAccount',
      ),
    );
  });

  test('refuses a token naming no expiry, or one that is not a number, as missingExpiry', () => {
    assert.deepEqual(read({ exp: undefined }), refusal('missingExpiry'));
    assert.deepEqual(
      read({ exp: String(SECONDS + 300) }),
      refusal('missingExpiry'),
    );
  });

  test('refuses a token past its expiry by more than the clock tolerance as expiredToken, and accepts one within it', () => {
    const tolerance = CLOCK_TOLERANCE_MILLISECONDS / 1000;

    assert.deepEqual(
      read({ exp: SECONDS - tolerance }),
      refusal('expiredToken'),
    );
    assert.deepEqual(read({ exp: SECONDS - 60 }), refusal('expiredToken'));
    assert.equal(read({ exp: SECONDS - tolerance + 1 }).kind, 'accepted');
  });

  test('refuses a token whose nbf is ahead by more than the clock tolerance as notYetValid, and one whose nbf is no number', () => {
    const tolerance = CLOCK_TOLERANCE_MILLISECONDS / 1000;

    assert.deepEqual(read({ nbf: SECONDS + 120 }), refusal('notYetValid'));
    assert.deepEqual(read({ nbf: 'soon' }), refusal('notYetValid'));
    assert.equal(read({ nbf: SECONDS + tolerance }).kind, 'accepted');
  });

  test('accepts an aud naming the management API as a string or among others, and refuses every other as otherAudience', () => {
    const accepted = [
      read({ aud: 'usher-management' }),
      read({ aud: ['account', 'usher-management'] }),
    ];
    const refused = [
      undefined,
      'account',
      ['account'],
      'usher-management-staging',
      [],
    ].map((aud) => read({ aud }));

    accepted.forEach((reading) => assert.equal(reading.kind, 'accepted'));
    refused.forEach((reading) =>
      assert.deepEqual(reading, refusal('otherAudience')),
    );
  });

  test('accepts each configured management client as azp, and refuses any other or none as otherAudience', () => {
    assert.equal(read({ azp: 'usher-cli' }).kind, 'accepted');
    [undefined, 'portal', ['usher-ui']].forEach((azp) =>
      assert.deepEqual(read({ azp }), refusal('otherAudience')),
    );
  });

  test('names the refused subject whatever its length, leaving its omission to the event', () => {
    const subject = 'b'.repeat(300);

    assert.deepEqual(
      read({ exp: undefined, sub: subject }),
      refusal('missingExpiry', subject),
    );
  });

  test('reads a token naming no subject, or an empty or non-text one, as unreadable', () => {
    [undefined, '', 7].forEach((sub) =>
      assert.deepEqual(read({ sub }), { kind: 'unreadable' }),
    );
  });

  test('reads a subject or session holding text that cannot be stored as unrepresentable, before judging anything else', () => {
    const readings = [
      read({ sub: 'ana\u0000' }),
      read({ exp: undefined, sub: '\uD800ana' }),
      read({ sid: 'session\u0000' }),
    ];

    readings.forEach((reading) =>
      assert.deepEqual(reading, { kind: 'unrepresentable' }),
    );
  });
});
