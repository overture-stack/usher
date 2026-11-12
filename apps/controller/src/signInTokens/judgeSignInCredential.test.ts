import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type {
  HeldKeyVerification,
  TokenClaims,
  TokenVerification,
  UnverifiedReason,
} from '../identityProvider/index.js';
import {
  judgeSignedToken,
  judgeSignInCredential,
} from './judgeSignInCredential.js';
import type { ContentsRefusal, SignInJudgementContext } from './types.js';

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);

const SECONDS = Math.floor(NOW / 1000);

const AUDIENCE = '7f3c2a9e-1d4b-4c8e-9a6f-2b5d8e1c0a47';

// Arbitrary text in base64url, only to take the compact serializations' form: no segment is a token's
// header, payload, key or signature, so nothing here is read as a token's contents, and what the
// verifier is faked to find decides.
const segment = (text: string): string =>
  Buffer.from(text).toString('base64url');

const SIGNED_SHAPE = ['first', 'second', 'third'].map(segment).join('.');

const ENCRYPTED_SHAPE = ['first', '', 'third', 'fourth', 'fifth']
  .map(segment)
  .join('.');

// A Keycloak access token's claims for the calling application, its `typ` the one given to an
// access token by Keycloak.
const claimsWith = (
  departures: Readonly<Record<string, unknown>> = {},
): TokenClaims =>
  Object.fromEntries(
    Object.entries({
      aud: ['account', AUDIENCE],
      exp: SECONDS + 300,
      iat: SECONDS - 10,
      iss: 'https://auth.example.org/realms/usher',
      sid: 'session-1',
      sub: 'subject-ana',
      typ: 'Bearer',
      ...departures,
    }).filter(([, value]) => value !== undefined),
  );

const verified = (
  departures?: Readonly<Record<string, unknown>>,
): Extract<TokenVerification, { kind: 'verified' }> => ({
  claims: claimsWith(departures),
  header: { alg: 'RS256', kid: 'key-1', typ: 'JWT' },
  kind: 'verified',
});

const UNVERIFIED_REASONS: readonly UnverifiedReason[] = [
  'invalidSignature',
  'otherIssuer',
  'unreadableToken',
];

interface Asked {
  method: 'verify' | 'verifyHeld';
  token: string;
}

interface Answers {
  /** What a full verification finds, the keys fetched if need be. */
  full?: TokenVerification;

  /** What a verification under the keys held finds, nothing fetched. */
  held?: HeldKeyVerification;
}

// A verifier answering each way of verifying with what it is given, a verified token by default,
// keeping each token it is asked about and how.
const answering = ({ full = verified(), held = verified() }: Answers = {}): {
  asked: Asked[];
  context: SignInJudgementContext;
} => {
  const asked: Asked[] = [];
  return {
    asked,
    context: {
      audience: AUDIENCE,
      now: NOW,
      verifier: {
        verify: async (token) => {
          asked.push({ method: 'verify', token });
          return full;
        },
        verifyHeld: async (token) => {
          asked.push({ method: 'verifyHeld', token });
          return held;
        },
      },
    },
  };
};

const judgeSigned = async (
  contentsRefusal: ContentsRefusal | undefined,
  answers: Answers,
) => {
  const { asked, context } = answering(answers);
  const judgement = await judgeSignedToken(
    SIGNED_SHAPE,
    contentsRefusal,
    context,
  );
  return { asked, judgement };
};

const recorded = (reason: string, refusedSubject?: string) => ({
  kind: 'recorded',
  reason,
  ...(refusedSubject === undefined ? {} : { refusedSubject }),
});

suite('judging a credential presented at the exchange', () => {
  test('records an empty, an encrypted and an opaque credential refused by their shape, and never verifies them', async () => {
    const { asked, context } = answering();

    const judgements = await Promise.all(
      ['', ENCRYPTED_SHAPE, 'uak_example'].map((credential) =>
        judgeSignInCredential(credential, context),
      ),
    );

    assert.deepEqual(judgements, [
      recorded('missingCredential'),
      recorded('unreadableToken'),
      recorded('apiKeyVerifierNotConfigured'),
    ]);
    assert.deepEqual(asked, []);
  });

  test('records a signed token whose contents cannot be read as unreadableToken, naming no subject, without checking its signature', async () => {
    const { asked, context } = answering();

    const judgement = await judgeSignInCredential(SIGNED_SHAPE, context);

    assert.deepEqual(judgement, recorded('unreadableToken'));
    assert.deepEqual(asked, []);
  });
});

suite(
  "judging a signed token by its contents' refusal and its signature",
  () => {
    test('verifies a token its contents did not refuse, the keys fetched if need be, and accepts it by its verified claims, giving its subject, session, exp and claims', async () => {
      const { asked, judgement } = await judgeSigned(undefined, {
        full: verified(),
      });

      assert.deepEqual(asked, [{ method: 'verify', token: SIGNED_SHAPE }]);
      assert.deepEqual(judgement, {
        claims: claimsWith(),
        expiresAt: SECONDS + 300,
        kind: 'accepted',
        session: { issuedAt: SECONDS - 10, sid: 'session-1' },
        subject: 'subject-ana',
      });
    });

    test('records a verified token its verified claims refuse, naming its subject for its times or its audience alone', async () => {
      const departures: readonly Readonly<Record<string, unknown>>[] = [
        { exp: SECONDS - 3600 },
        { exp: undefined },
        { nbf: SECONDS + 3600 },
        { aud: ['account'] },
        {
          events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
        },
        { typ: 'ID' },
        { sub: undefined },
        { sub: 'subject\u0000ana' },
        { sid: 'session\u0000' },
      ];

      const judged = await Promise.all(
        departures.map((departure) =>
          judgeSigned(undefined, { full: verified(departure) }),
        ),
      );

      assert.deepEqual(
        judged.map(({ judgement }) => judgement),
        [
          recorded('expiredToken', 'subject-ana'),
          recorded('missingExpiry', 'subject-ana'),
          recorded('notYetValid', 'subject-ana'),
          recorded('otherAudience', 'subject-ana'),
          recorded('otherType'),
          recorded('otherType'),
          recorded('missingSubject'),
          recorded('unrepresentableSubject'),
          recorded('unrepresentableSubject'),
        ],
      );
    });

    test("records a token its contents did not refuse but the verifier does under the verifier's reason, naming no subject", async () => {
      const judged = await Promise.all(
        UNVERIFIED_REASONS.map((reason) =>
          judgeSigned(undefined, { full: { kind: 'unverified', reason } }),
        ),
      );

      assert.deepEqual(
        judged.map(({ judgement }) => judgement),
        UNVERIFIED_REASONS.map((reason) => recorded(reason)),
      );
    });

    test('answers that the keys are unavailable, or that the signing key is unconfirmed with the wait, for a token its contents did not refuse', async () => {
      const judged = await Promise.all([
        judgeSigned(undefined, { full: { kind: 'keysUnavailable' } }),
        judgeSigned(undefined, {
          full: { kind: 'signingKeyUnconfirmed', retryAfterSeconds: 7 },
        }),
      ]);

      assert.deepEqual(
        judged.map(({ judgement }) => judgement),
        [
          { kind: 'keysUnavailable' },
          { kind: 'signingKeyUnconfirmed', retryAfterSeconds: 7 },
        ],
      );
    });

    test('checks a token its contents refused for its times or its audience under the keys held alone, never the full verification, and names its subject once that verifies it', async () => {
      const refusals: readonly {
        departure: Readonly<Record<string, unknown>>;
        reason: ContentsRefusal;
      }[] = [
        { departure: { exp: SECONDS - 3600 }, reason: 'expiredToken' },
        { departure: { exp: undefined }, reason: 'missingExpiry' },
        { departure: { nbf: SECONDS + 3600 }, reason: 'notYetValid' },
        { departure: { aud: ['account'] }, reason: 'otherAudience' },
      ];

      const judged = await Promise.all(
        refusals.map(({ departure, reason }) =>
          judgeSigned(reason, { held: verified(departure) }),
        ),
      );

      judged.forEach(({ asked }) =>
        assert.deepEqual(asked, [
          { method: 'verifyHeld', token: SIGNED_SHAPE },
        ]),
      );
      assert.deepEqual(
        judged.map(({ judgement }) => judgement),
        refusals.map(({ reason }) => recorded(reason, 'subject-ana')),
      );
    });

    test('records a token its contents refused for its type, its names or its readability without any check of its signature, naming no subject', async () => {
      const refusals: readonly ContentsRefusal[] = [
        'otherType',
        'missingSubject',
        'unrepresentableSubject',
        'unreadableToken',
      ];

      const judged = await Promise.all(
        refusals.map((reason) =>
          judgeSigned(reason, { full: verified(), held: verified() }),
        ),
      );

      assert.deepEqual(
        judged.map(({ asked }) => asked),
        refusals.map(() => []),
      );
      assert.deepEqual(
        judged.map(({ judgement }) => judgement),
        refusals.map((reason) => recorded(reason)),
      );
    });

    test('records a token its contents refused under that refusal, naming no subject, when its key is not held or the verifier refuses it', async () => {
      const helds: readonly HeldKeyVerification[] = [
        { kind: 'keyNotHeld' },
        ...UNVERIFIED_REASONS.map((reason): HeldKeyVerification => ({
          kind: 'unverified',
          reason,
        })),
      ];

      const judged = await Promise.all(
        helds.map((held) => judgeSigned('otherAudience', { held })),
      );

      judged.forEach(({ asked, judgement }) => {
        assert.deepEqual(judgement, recorded('otherAudience'));
        assert.deepEqual(asked, [
          { method: 'verifyHeld', token: SIGNED_SHAPE },
        ]);
      });
    });

    test('keeps refused a token its contents refused even where its verified claims would accept it, naming no subject', async () => {
      const { judgement } = await judgeSigned('notYetValid', {
        held: verified(),
      });

      assert.deepEqual(judgement, recorded('notYetValid'));
    });
  },
);
