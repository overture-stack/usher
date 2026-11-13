import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { CLOCK_TOLERANCE_MILLISECONDS } from '../configuration/index.js';
import type { TokenClaims, TokenHeader } from '../identityProvider/index.js';
import { readManagementClaims } from './readManagementClaims.js';

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

const SECONDS = Math.floor(NOW / 1000);

const SETTINGS = Object.freeze({
  administratorRole: 'usher-platform-admin',
  managementAudience: 'usher-management',
  managementClients: ['usher-ui', 'usher-cli'],
  serviceAccountRole: 'usher-service-account',
});

const HEADER: TokenHeader = Object.freeze({
  alg: 'RS256',
  kid: 'key-1',
  typ: 'JWT',
});

// A Keycloak access token's claims for the management UI, its `typ` the one given to an access token
// by Keycloak.
const claimsWith = (
  departures: Readonly<Record<string, unknown>> = {},
): TokenClaims =>
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
      typ: 'Bearer',
      ...departures,
    }).filter(([, value]) => value !== undefined),
  );

const read = (
  departures?: Readonly<Record<string, unknown>>,
  header: TokenHeader = HEADER,
) =>
  readManagementClaims(
    { claims: claimsWith(departures), header },
    SETTINGS,
    NOW,
  );

const principalTypeOf = (
  reading: ReturnType<typeof read>,
): string | undefined =>
  reading.kind === 'accepted' ? reading.principal.type : undefined;

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
      assert.equal(principalTypeOf(reading), 'serviceAccount'),
    );
  });

  test('reads a token holding the service-account realm role, and neither sign of client credentials, as a service account', () => {
    const reading = read({
      realm_access: { roles: ['offline_access', 'usher-service-account'] },
    });

    assert.deepEqual(
      reading.kind === 'accepted' ? reading.principal : undefined,
      {
        administrator: false,
        subject: 'subject-ana',
        type: 'serviceAccount',
      },
    );
  });

  test('reads a token holding the service-account realm role beside the administrator role as a service account', () => {
    const reading = read({
      realm_access: {
        roles: [
          'offline_access',
          'usher-platform-admin',
          'usher-service-account',
        ],
      },
    });

    assert.deepEqual(
      reading.kind === 'accepted' ? reading.principal : undefined,
      {
        administrator: true,
        subject: 'subject-ana',
        type: 'serviceAccount',
      },
    );
  });

  test('takes the configured service-account role as the mark, and the default name then as any other role', () => {
    const readWithRole = (roles: readonly string[]) =>
      readManagementClaims(
        { claims: claimsWith({ realm_access: { roles } }), header: HEADER },
        { ...SETTINGS, serviceAccountRole: 'lyric-service' },
        NOW,
      );

    assert.deepEqual(
      [
        principalTypeOf(readWithRole(['offline_access', 'lyric-service'])),
        principalTypeOf(
          readWithRole(['offline_access', 'usher-service-account']),
        ),
      ],
      ['serviceAccount', 'human'],
    );
  });

  test("reads a token as a person's when it carries neither sign of client credentials nor a realm role named exactly as the service-account role", () => {
    const readings = [
      read(),
      read({ realm_access: { roles: ['offline_access'] } }),
      read({ realm_access: undefined }),
      read({
        realm_access: {
          roles: [
            'Usher-Service-Account',
            'usher-service-account-x',
            ' usher-service-account',
            ['usher-service-account'],
          ],
        },
      }),
      read({ realm_access: { roles: 'usher-service-account' } }),
      read({ resource_access: { roles: ['usher-service-account'] } }),
    ];

    readings.forEach((reading) =>
      assert.equal(principalTypeOf(reading), 'human'),
    );
  });

  test('refuses a verified token other than an access token, an ID token among them, as otherType, naming its subject', () => {
    ['ID', 'Refresh', 'Logout', 'DPoP', undefined].forEach((typ) =>
      assert.deepEqual(read({ typ }), refusal('otherType')),
    );
  });

  test('accepts an access token whatever its header typ, JWT or at+jwt', () => {
    [HEADER, { ...HEADER, typ: 'at+jwt' }].forEach((header) =>
      assert.equal(read({}, header).kind, 'accepted'),
    );
  });

  test('judges the names before the type, and the type before the times, the audience and the client', () => {
    assert.deepEqual(read({ sub: undefined, typ: 'ID' }), {
      kind: 'unreadable',
    });
    assert.deepEqual(read({ sid: 'session\u0000', typ: 'ID' }), {
      kind: 'unrepresentable',
    });
    assert.deepEqual(
      read({ aud: 'account', azp: 'portal', exp: SECONDS - 60, typ: 'ID' }),
      refusal('otherType'),
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

  test('reads a sid that is not text as unrepresentable, since a session it cannot name cannot be matched against a sign-out of it', () => {
    [42, null, true, ['session-1'], { id: 'session-1' }].forEach((sid) =>
      assert.deepEqual(read({ sid }), { kind: 'unrepresentable' }),
    );
  });
});
