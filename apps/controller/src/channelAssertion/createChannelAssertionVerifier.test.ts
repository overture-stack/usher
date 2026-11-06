import assert from 'node:assert/strict';
import { hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import { CompactSign } from 'jose';

import {
  applicationSubkeys,
  type LiveApplicationKey,
  SUBKEY_LABELS,
} from '../applicationKeyRing/index.js';
import {
  CHANNEL_ASSERTION_AUDIENCE,
  CHANNEL_ASSERTION_TYPE,
  createChannelAssertionVerifier,
} from './createChannelAssertionVerifier.js';
import type {
  ChannelAssertionCheck,
  ChannelAssertionVerifier,
} from './types.js';

const NOW_SECONDS = 1_762_300_000;

const TOLERANCE_SECONDS = 30;

interface Application {
  id: string;
  keys: readonly { bytes: Buffer; live: LiveApplicationKey }[];
}

const applicationWith = (keyCount: number): Application => {
  const id = randomUUID();
  return {
    id,
    keys: Array.from({ length: keyCount }, () => {
      const bytes = randomBytes(32);
      return {
        bytes,
        live: {
          applicationId: id,
          keyId: randomUUID(),
          ...applicationSubkeys(bytes),
        },
      };
    }),
  };
};

const verifierFor = (
  ...applications: readonly Application[]
): ChannelAssertionVerifier<LiveApplicationKey> =>
  createChannelAssertionVerifier<LiveApplicationKey>({
    clock: { now: () => NOW_SECONDS * 1000 },
    keyRing: {
      liveKeysOf: (applicationId) =>
        applications
          .find(({ id }) => id === applicationId)
          ?.keys.map(({ live }) => live),
    },
  });

// An assertion signed as the bridge signs one, HS256 under the channel-assertion subkey of the key's
// own bytes, with a test's departures in its claims or its `typ`.
const signedBy = (
  keyBytes: Buffer,
  {
    claims = {},
    typ = CHANNEL_ASSERTION_TYPE,
  }: { claims?: Readonly<Record<string, unknown>>; typ?: string | null } = {},
  issuer = '',
): Promise<string> =>
  new CompactSign(
    new TextEncoder().encode(
      JSON.stringify(
        Object.fromEntries(
          Object.entries({
            aud: CHANNEL_ASSERTION_AUDIENCE,
            exp: NOW_SECONDS + 60,
            iat: NOW_SECONDS,
            iss: issuer,
            jti: randomUUID(),
            ...claims,
          }).filter(([, value]) => value !== undefined),
        ),
      ),
    ),
  )
    .setProtectedHeader(typ === null ? { alg: 'HS256' } : { alg: 'HS256', typ })
    .sign(
      new Uint8Array(
        hkdfSync(
          'sha256',
          keyBytes,
          Buffer.alloc(0),
          SUBKEY_LABELS.channelAssertion,
          32,
        ),
      ),
    );

const assertionOf = (
  application: Application,
  departures?: Parameters<typeof signedBy>[1],
  keyIndex = 0,
): Promise<string> =>
  signedBy(
    application.keys[keyIndex]?.bytes ?? assert.fail('no such key'),
    departures,
    application.id,
  );

const bearer = (assertion: string): readonly string[] => [
  'Authorization',
  `Bearer ${assertion}`,
];

// A refusal as the check gives it: whether the assertion verified, why it was refused, and the
// application it names, if any.
const refusalOf = (
  check: ChannelAssertionCheck<LiveApplicationKey>,
):
  | { applicationId?: string; kind: 'refused' | 'unverified'; reason: string }
  | undefined =>
  check.kind === 'verified'
    ? undefined
    : {
        ...(check.applicationId === undefined
          ? {}
          : { applicationId: check.applicationId }),
        kind: check.kind,
        reason: check.reason,
      };

suite('the channel assertion verifier', () => {
  test('accepts the assertion the bridge signs, naming the key it verified under, its jti, and how long it is accepted', async () => {
    const application = applicationWith(1);
    const id = randomUUID();
    const assertion = await assertionOf(application, { claims: { jti: id } });

    const check = await verifierFor(application).verify(bearer(assertion));

    assert.equal(check.kind, 'verified');
    assert.deepEqual(
      check.kind === 'verified'
        ? {
            acceptedUntil: check.assertion.acceptedUntil,
            id: check.assertion.id,
            keyId: check.assertion.key.keyId,
          }
        : undefined,
      {
        acceptedUntil: (NOW_SECONDS + 60 + TOLERANCE_SECONDS) * 1000,
        id,
        keyId: application.keys[0]?.live.keyId,
      },
    );
  });

  test('verifies under either live key of an application holding two, answering with the one that verified', async () => {
    const application = applicationWith(2);
    const verifier = verifierFor(application);

    const checks = await Promise.all(
      [0, 1].map(async (index) =>
        verifier.verify(bearer(await assertionOf(application, {}, index))),
      ),
    );

    assert.deepEqual(
      checks.map((check) =>
        check.kind === 'verified' ? check.assertion.key.keyId : check.reason,
      ),
      application.keys.map(({ live }) => live.keyId),
    );
  });

  test('accepts the scheme in any letter case, and times within the clock tolerance', async () => {
    const application = applicationWith(1);
    const verifier = verifierFor(application);
    const assertions = await Promise.all([
      assertionOf(application, {
        claims: {
          exp: NOW_SECONDS - TOLERANCE_SECONDS + 1,
          iat: NOW_SECONDS - 59,
        },
      }),
      assertionOf(application, {
        claims: {
          exp: NOW_SECONDS + TOLERANCE_SECONDS + 59,
          iat: NOW_SECONDS + TOLERANCE_SECONDS - 1,
        },
      }),
    ]);
    const lowerCase = await assertionOf(application);

    const checks = await Promise.all([
      ...assertions.map((assertion) => verifier.verify(bearer(assertion))),
      verifier.verify(['authorization', `bearer ${lowerCase}`]),
    ]);

    checks.forEach((check) => {
      assert.equal(check.kind, 'verified');
    });
  });

  test('refuses a request presenting no assertion as missingAssertion, naming no application', async () => {
    const application = applicationWith(1);
    const verifier = verifierFor(application);
    const assertion = await assertionOf(application);

    const checks = await Promise.all(
      [
        [],
        ['Authorization', 'Bearer'],
        ['Authorization', 'Bearer '],
        ['Authorization', `Basic ${assertion}`],
        ['Authorization', `DPoP ${assertion}`],
      ].map((rawHeaders) => verifier.verify(rawHeaders)),
    );

    checks.forEach((check) => {
      assert.deepEqual(refusalOf(check), {
        kind: 'unverified',
        reason: 'missingAssertion',
      });
    });
  });

  test('refuses an assertion it cannot read as one, or one of another type, as unreadableAssertion, naming no application', async () => {
    const application = applicationWith(1);
    const verifier = verifierFor(application);
    const typed = await Promise.all(
      [null, 'JWT', 'usher+jwt', 'USHER-CHANNEL+JWT'].map((typ) =>
        assertionOf(application, { typ }),
      ),
    );
    const assertion = await assertionOf(application);
    const requests: readonly (readonly string[])[] = [
      ...typed.map(bearer),
      bearer(
        await signedBy(application.keys[0]?.bytes ?? Buffer.alloc(0), {}, ''),
      ),
      [
        'Authorization',
        `Bearer ${assertion}`,
        'Authorization',
        `Bearer ${assertion}`,
      ],
    ];

    const checks = await Promise.all(
      requests.map((rawHeaders) => verifier.verify(rawHeaders)),
    );

    checks.forEach((check) => {
      assert.deepEqual(refusalOf(check), {
        kind: 'unverified',
        reason: 'unreadableAssertion',
      });
    });
  });

  test('refuses an assertion naming no registered application as unknownApplication, naming none', async () => {
    const registered = applicationWith(1);
    const assertion = await signedBy(
      registered.keys[0]?.bytes ?? Buffer.alloc(0),
      {},
      randomUUID(),
    );

    const check = await verifierFor(registered).verify(bearer(assertion));

    assert.deepEqual(refusalOf(check), {
      kind: 'unverified',
      reason: 'unknownApplication',
    });
  });

  test('refuses an assertion naming an application that holds no live key as noLiveKey, naming it', async () => {
    const revoked = applicationWith(1);
    const holdingNone: Application = { id: revoked.id, keys: [] };
    const assertion = await assertionOf(revoked);

    const check = await verifierFor(holdingNone).verify(bearer(assertion));

    assert.deepEqual(refusalOf(check), {
      applicationId: revoked.id,
      kind: 'unverified',
      reason: 'noLiveKey',
    });
  });

  test('refuses a verified assertion for another audience, or none, as otherAudience, naming its application', async () => {
    const application = applicationWith(1);
    const verifier = verifierFor(application);
    const assertions = await Promise.all(
      [undefined, 'usher:bridge', [CHANNEL_ASSERTION_AUDIENCE]].map((aud) =>
        assertionOf(application, { claims: { aud } }),
      ),
    );

    const checks = await Promise.all(
      assertions.map((assertion) => verifier.verify(bearer(assertion))),
    );

    checks.forEach((check) => {
      assert.deepEqual(refusalOf(check), {
        applicationId: application.id,
        kind: 'refused',
        reason: 'otherAudience',
      });
    });
  });

  test('refuses an assertion lacking a time or a jti, or whose exp is not after its iat, as unreadableAssertion before verifying it, naming its application', async () => {
    const application = applicationWith(1);
    const verifier = verifierFor(application);
    const assertions = await Promise.all(
      [
        { iat: undefined },
        { exp: undefined },
        { exp: String(NOW_SECONDS + 60) },
        { jti: undefined },
        { jti: '' },
        { exp: NOW_SECONDS, iat: NOW_SECONDS },
        { exp: NOW_SECONDS - 1, iat: NOW_SECONDS },
      ].map((claims) => assertionOf(application, { claims })),
    );

    const checks = await Promise.all(
      assertions.map((assertion) => verifier.verify(bearer(assertion))),
    );

    checks.forEach((check) => {
      assert.deepEqual(refusalOf(check), {
        applicationId: application.id,
        kind: 'unverified',
        reason: 'unreadableAssertion',
      });
    });
  });

  test('refuses a verified assertion living longer than 60 s as excessiveLifetime, naming its application', async () => {
    const application = applicationWith(1);
    const assertion = await assertionOf(application, {
      claims: { exp: NOW_SECONDS + 61, iat: NOW_SECONDS },
    });

    const check = await verifierFor(application).verify(bearer(assertion));

    assert.deepEqual(refusalOf(check), {
      applicationId: application.id,
      kind: 'refused',
      reason: 'excessiveLifetime',
    });
  });

  test('refuses a verified assertion past its exp by the clock tolerance or more as expiredAssertion, naming its application', async () => {
    const application = applicationWith(1);
    const verifier = verifierFor(application);
    const assertions = await Promise.all(
      [
        { exp: NOW_SECONDS - TOLERANCE_SECONDS, iat: NOW_SECONDS - 60 },
        { exp: NOW_SECONDS - 40, iat: NOW_SECONDS - 100 },
      ].map((claims) => assertionOf(application, { claims })),
    );

    const checks = await Promise.all(
      assertions.map((assertion) => verifier.verify(bearer(assertion))),
    );

    checks.forEach((check) => {
      assert.deepEqual(refusalOf(check), {
        applicationId: application.id,
        kind: 'refused',
        reason: 'expiredAssertion',
      });
    });
  });

  test('refuses a verified assertion issued ahead of the clock by the tolerance or more as notYetValid, naming its application', async () => {
    const application = applicationWith(1);
    const verifier = verifierFor(application);
    const assertions = await Promise.all(
      [
        {
          exp: NOW_SECONDS + TOLERANCE_SECONDS + 60,
          iat: NOW_SECONDS + TOLERANCE_SECONDS,
        },
        { exp: NOW_SECONDS + 100, iat: NOW_SECONDS + 40 },
      ].map((claims) => assertionOf(application, { claims })),
    );

    const checks = await Promise.all(
      assertions.map((assertion) => verifier.verify(bearer(assertion))),
    );

    checks.forEach((check) => {
      assert.deepEqual(refusalOf(check), {
        applicationId: application.id,
        kind: 'refused',
        reason: 'notYetValid',
      });
    });
  });
});

suite(
  'refuses an assertion verified under none of its application live keys as invalidSignature: the developer writes these cases by hand, since each needs an assertion signed by a wrong key or algorithm, or altered after signing',
  { todo: true },
  () => {},
);
