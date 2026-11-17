import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { suite, test, type TestContext } from 'node:test';

import {
  CompactEncrypt,
  CompactSign,
  type CryptoKey,
  exportJWK,
  generateKeyPair,
  type JWK,
} from 'jose';

import type { Clock } from '../configuration/index.js';
import type { LineFields } from '../eventLog/index.js';
import {
  KEY_REFETCH_COOLDOWN_MILLISECONDS,
  KEY_SET_FETCH_FAILED,
  KEY_SET_MAXIMUM_AGE_MILLISECONDS,
} from './createSigningKeys.js';
import { createTokenVerifier } from './createTokenVerifier.js';
import type { KeySetFetchFailure } from './types.js';

interface SigningKey {
  jwk: JWK;
  kid: string;
  privateKey: CryptoKey;
}

interface StandIn {
  /** Each path asked for, in order. */
  asked: string[];

  /** What the discovery document names as the issuer, the stand-in's own by default. */
  discoveryIssuer: string | undefined;

  /** Whether it hangs up on every request, answering nothing. */
  hangingUp: boolean;

  issuer: string;

  /** The key set's body as sent, in place of the published keys, when set. */
  keySet: string | undefined;

  /** Where the discovery document locates the key set, the stand-in's own by default. */
  keySetLocation: string | undefined;

  /** The keys the key set publishes. */
  published: JWK[];

  /** Whether it answers the discovery document with a redirect to the key set. */
  redirecting: boolean;

  /** Whether it answers; a refusing stand-in answers every request 503. */
  refusing: boolean;
}

interface Line {
  fields: LineFields | undefined;
  message: string;
}

const DISCOVERY_PATH = '/realms/test/.well-known/openid-configuration';

const KEY_SET_PATH = '/realms/test/certs';

interface AdjustableClock extends Clock {
  advance(milliseconds: number): void;
}

const adjustableClock = (): AdjustableClock => {
  const state = { offset: 0 };
  return {
    advance: (milliseconds) => {
      state.offset += milliseconds;
    },
    now: () => Date.now() + state.offset,
  };
};

// A clock that stands still between a test's moves, so a time left in the cooldown is exact.
const controlledClock = (): AdjustableClock => {
  const state = { now: Date.now() };
  return {
    advance: (milliseconds) => {
      state.now += milliseconds;
    },
    now: () => state.now,
  };
};

const signingKey = async (
  algorithm: 'ES256' | 'RS256' = 'RS256',
): Promise<SigningKey> => {
  const kid = `key-${algorithm}-${Math.random().toString(36).slice(2)}`;
  const { privateKey, publicKey } = await generateKeyPair(algorithm, {
    extractable: true,
  });
  return {
    jwk: { ...(await exportJWK(publicKey)), alg: algorithm, kid, use: 'sig' },
    kid,
    privateKey,
  };
};

const signed = (
  key: SigningKey,
  claims: Readonly<Record<string, unknown>>,
  header: Readonly<Record<string, unknown>> = {},
): Promise<string> =>
  new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({
      alg: String(key.jwk.alg),
      kid: key.kid,
      typ: 'JWT',
      ...header,
    })
    .sign(key.privateKey);

const isAddress = (address: unknown): address is AddressInfo =>
  typeof address === 'object' && address !== null && 'port' in address;

const listening = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (isAddress(address)) {
        resolve(address.port);
      } else {
        reject(new Error('the stand-in listens on no TCP address'));
      }
    });
  });

const startStandIn = async (context: TestContext): Promise<StandIn> => {
  const standIn: StandIn = {
    asked: [],
    discoveryIssuer: undefined,
    hangingUp: false,
    issuer: '',
    keySet: undefined,
    keySetLocation: undefined,
    published: [],
    redirecting: false,
    refusing: false,
  };
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    standIn.asked.push(path);
    const answer = (body: string): void => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
    };
    if (standIn.hangingUp) {
      request.socket.destroy();
    } else if (standIn.refusing) {
      response.writeHead(503);
      response.end();
    } else if (path === DISCOVERY_PATH && standIn.redirecting) {
      response.writeHead(302, { location: `${standIn.issuer}/certs` });
      response.end();
    } else if (path === DISCOVERY_PATH) {
      answer(
        JSON.stringify({
          issuer: standIn.discoveryIssuer ?? standIn.issuer,
          jwks_uri: standIn.keySetLocation ?? `${standIn.issuer}/certs`,
        }),
      );
    } else if (path === KEY_SET_PATH) {
      answer(standIn.keySet ?? JSON.stringify({ keys: standIn.published }));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  const port = await listening(server);
  context.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  standIn.issuer = `http://127.0.0.1:${port}/realms/test`;
  return standIn;
};

const claimsFor = (
  issuer: string,
  extra: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> => ({
  exp: Math.floor(Date.now() / 1000) + 300,
  iss: issuer,
  sub: 'subject-ana',
  ...extra,
});

const verifierFor = (
  standIn: StandIn,
  clock: Clock = adjustableClock(),
  lines: Line[] = [],
): ReturnType<typeof createTokenVerifier> =>
  createTokenVerifier(
    { clock, identityProviderIssuer: standIn.issuer },
    {
      error: (message, fields) => {
        lines.push({ fields, message });
      },
    },
  );

const failedFetch = (cause: KeySetFetchFailure): Line => ({
  fields: { cause },
  message: KEY_SET_FETCH_FAILED,
});

suite('verifying a token from the trusted identity provider', () => {
  test('verifies a token signed by a published key, giving its claims and its protected header, its keys found through the discovery document', async (context) => {
    const standIn = await startStandIn(context);
    const key = await signingKey();
    standIn.published = [key.jwk];
    const claims = claimsFor(standIn.issuer);

    const verification = await verifierFor(standIn).verify(
      await signed(key, claims, { typ: 'logout+jwt' }),
    );

    assert.deepEqual(verification, {
      claims,
      header: { alg: key.jwk.alg, kid: key.kid, typ: 'logout+jwt' },
      kind: 'verified',
    });
    assert.deepEqual(standIn.asked, [DISCOVERY_PATH, KEY_SET_PATH]);
  });

  test('verifies an ES256 token, and keeps the keys it fetched for the next token', async (context) => {
    const standIn = await startStandIn(context);
    const key = await signingKey('ES256');
    standIn.published = [key.jwk];
    const verifier = verifierFor(standIn);

    const first = await verifier.verify(
      await signed(key, claimsFor(standIn.issuer)),
    );
    const second = await verifier.verify(
      await signed(key, claimsFor(standIn.issuer)),
    );

    assert.equal(first.kind, 'verified');
    assert.equal(second.kind, 'verified');
    assert.equal(standIn.asked.length, 2);
  });

  test("refuses another issuer's token as otherIssuer without fetching any key", async (context) => {
    const standIn = await startStandIn(context);
    const key = await signingKey();
    standIn.published = [key.jwk];

    const verifications = await Promise.all(
      [`${standIn.issuer}/`, 'http://127.0.0.1:1/realms/test', undefined].map(
        async (iss) =>
          verifierFor(standIn).verify(
            await signed(key, claimsFor(standIn.issuer, { iss })),
          ),
      ),
    );

    verifications.forEach((verification) =>
      assert.deepEqual(verification, {
        kind: 'unverified',
        reason: 'otherIssuer',
      }),
    );
    assert.deepEqual(standIn.asked, []);
  });

  test('refuses as unreadableToken what is no compact signed token, an encrypted one included', async (context) => {
    const standIn = await startStandIn(context);
    const { publicKey } = await generateKeyPair('RSA-OAEP-256');
    const encrypted = await new CompactEncrypt(
      new TextEncoder().encode(JSON.stringify(claimsFor(standIn.issuer))),
    )
      .setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM' })
      .encrypt(publicKey);

    const verifications = await Promise.all(
      ['', 'not-a-token', 'a.b.c', encrypted].map((token) =>
        verifierFor(standIn).verify(token),
      ),
    );

    verifications.forEach((verification) =>
      assert.deepEqual(verification, {
        kind: 'unverified',
        reason: 'unreadableToken',
      }),
    );
    assert.deepEqual(standIn.asked, []);
  });

  test('never verifies under a key the provider publishes for encryption', async (context) => {
    const standIn = await startStandIn(context);
    const key = await signingKey();
    standIn.published = [{ ...key.jwk, use: 'enc' }];

    const verification = await verifierFor(standIn).verify(
      await signed(key, claimsFor(standIn.issuer)),
    );

    assert.deepEqual(verification, {
      kind: 'unverified',
      reason: 'invalidSignature',
    });
  });

  test('fetches the keys again for a key it lacks, at most once in the cooldown, and so verifies under a key published since', async (context) => {
    const standIn = await startStandIn(context);
    const first = await signingKey();
    const rotated = await signingKey();
    standIn.published = [first.jwk];
    const clock = controlledClock();
    const verifier = verifierFor(standIn, clock);
    await verifier.verify(await signed(first, claimsFor(standIn.issuer)));
    clock.advance(KEY_REFETCH_COOLDOWN_MILLISECONDS);
    standIn.published = [first.jwk, rotated.jwk];

    const afterRotation = await verifier.verify(
      await signed(rotated, claimsFor(standIn.issuer)),
    );
    const unknown = await signingKey();
    const withinCooldown = await verifier.verify(
      await signed(unknown, claimsFor(standIn.issuer)),
    );

    assert.equal(afterRotation.kind, 'verified');
    assert.deepEqual(withinCooldown, {
      kind: 'signingKeyUnconfirmed',
      retryAfterSeconds: 30,
    });
    assert.equal(standIn.asked.length, 4);
  });

  test('answers keysUnavailable while the keys cannot be fetched, trying again only once the cooldown has passed on its clock', async (context) => {
    const standIn = await startStandIn(context);
    const key = await signingKey();
    standIn.published = [key.jwk];
    standIn.refusing = true;
    const clock = adjustableClock();
    const verifier = verifierFor(standIn, clock);
    const token = await signed(key, claimsFor(standIn.issuer));

    const whileRefusing = await verifier.verify(token);
    standIn.refusing = false;
    const withinCooldown = await verifier.verify(token);
    clock.advance(KEY_REFETCH_COOLDOWN_MILLISECONDS);
    const afterCooldown = await verifier.verify(token);

    assert.deepEqual(whileRefusing, { kind: 'keysUnavailable' });
    assert.deepEqual(withinCooldown, { kind: 'keysUnavailable' });
    assert.equal(afterCooldown.kind, 'verified');
    assert.equal(standIn.asked.length, 3);
  });

  test('stops trusting the keys it holds once they pass their maximum age, fetching them again', async (context) => {
    const standIn = await startStandIn(context);
    const key = await signingKey();
    standIn.published = [key.jwk];
    const clock = adjustableClock();
    const verifier = verifierFor(standIn, clock);
    const token = await signed(key, claimsFor(standIn.issuer));
    await verifier.verify(token);
    standIn.published = [];
    clock.advance(KEY_SET_MAXIMUM_AGE_MILLISECONDS);

    const afterWithdrawal = await verifier.verify(token);

    assert.deepEqual(afterWithdrawal, {
      kind: 'unverified',
      reason: 'invalidSignature',
    });
  });

  test('answers keysUnavailable when the discovery document names another issuer', async (context) => {
    const standIn = await startStandIn(context);
    const key = await signingKey();
    standIn.published = [key.jwk];
    standIn.discoveryIssuer = `${standIn.issuer}/`;

    const verification = await verifierFor(standIn).verify(
      await signed(key, claimsFor(standIn.issuer)),
    );

    assert.deepEqual(verification, { kind: 'keysUnavailable' });
  });

  test('shares one fetch among the tokens verified at once', async (context) => {
    const standIn = await startStandIn(context);
    const key = await signingKey();
    standIn.published = [key.jwk];
    const verifier = verifierFor(standIn);
    const token = await signed(key, claimsFor(standIn.issuer));

    const verifications = await Promise.all(
      [1, 2, 3].map(() => verifier.verify(token)),
    );

    assert.deepEqual(
      verifications.map(({ kind }) => kind),
      ['verified', 'verified', 'verified'],
    );
    assert.equal(standIn.asked.length, 2);
  });
});

suite(
  "a token whose key is not among those held, by the key set's latest fetch",
  () => {
    test('answers keysUnavailable while the latest fetch has failed, for a key rotated in during the outage too, and verifies that key once the provider answers again', async (context) => {
      const standIn = await startStandIn(context);
      const first = await signingKey();
      const rotated = await signingKey();
      standIn.published = [first.jwk];
      const clock = adjustableClock();
      const verifier = verifierFor(standIn, clock);
      const firstToken = await signed(first, claimsFor(standIn.issuer));
      const rotatedToken = await signed(rotated, claimsFor(standIn.issuer));
      await verifier.verify(firstToken);
      clock.advance(KEY_REFETCH_COOLDOWN_MILLISECONDS);
      standIn.refusing = true;
      standIn.published = [first.jwk, rotated.jwk];

      const duringOutage = await verifier.verify(rotatedToken);
      const withinCooldown = await verifier.verify(rotatedToken);
      const underHeldKey = await verifier.verify(firstToken);
      standIn.refusing = false;
      clock.advance(KEY_REFETCH_COOLDOWN_MILLISECONDS);
      const onceAnswering = await verifier.verify(rotatedToken);

      assert.deepEqual(duringOutage, { kind: 'keysUnavailable' });
      assert.deepEqual(withinCooldown, { kind: 'keysUnavailable' });
      assert.equal(underHeldKey.kind, 'verified');
      assert.equal(onceAnswering.kind, 'verified');
      assert.equal(standIn.asked.length, 5);
    });

    test('answers signingKeyUnconfirmed within the cooldown after a fetch that succeeded, a key published since among them, with the seconds left in the cooldown rounded up, fetching nothing', async (context) => {
      const standIn = await startStandIn(context);
      const first = await signingKey();
      const rotated = await signingKey();
      standIn.published = [first.jwk];
      const clock = controlledClock();
      const verifier = verifierFor(standIn, clock);
      await verifier.verify(await signed(first, claimsFor(standIn.issuer)));
      standIn.published = [first.jwk, rotated.jwk];
      const token = await signed(rotated, claimsFor(standIn.issuer));

      clock.advance(12_345);
      const early = await verifier.verify(token);
      clock.advance(KEY_REFETCH_COOLDOWN_MILLISECONDS - 12_345 - 1);
      const last = await verifier.verify(token);

      assert.deepEqual(early, {
        kind: 'signingKeyUnconfirmed',
        retryAfterSeconds: 18,
      });
      assert.deepEqual(last, {
        kind: 'signingKeyUnconfirmed',
        retryAfterSeconds: 1,
      });
      assert.equal(standIn.asked.length, 2);
    });

    test('looks for it again once the cooldown has passed: verifies it once published, refuses it as invalidSignature while still absent, and answers keysUnavailable when that fetch fails', async (context) => {
      const standIn = await startStandIn(context);
      const first = await signingKey();
      const rotated = await signingKey();
      standIn.published = [first.jwk];
      const clock = controlledClock();
      const verifier = verifierFor(standIn, clock);
      await verifier.verify(await signed(first, claimsFor(standIn.issuer)));
      standIn.published = [first.jwk, rotated.jwk];
      const absent = (kid: string): Promise<string> =>
        signed(first, claimsFor(standIn.issuer), { kid });

      const withinCooldown = await verifier.verify(
        await signed(rotated, claimsFor(standIn.issuer)),
      );
      clock.advance(KEY_REFETCH_COOLDOWN_MILLISECONDS);
      const published = await verifier.verify(
        await signed(rotated, claimsFor(standIn.issuer)),
      );
      clock.advance(KEY_REFETCH_COOLDOWN_MILLISECONDS);
      const stillAbsent = await verifier.verify(
        await absent('never-published'),
      );
      clock.advance(KEY_REFETCH_COOLDOWN_MILLISECONDS);
      standIn.refusing = true;
      const fetchFailed = await verifier.verify(await absent('during-outage'));

      assert.equal(withinCooldown.kind, 'signingKeyUnconfirmed');
      assert.equal(published.kind, 'verified');
      assert.deepEqual(stillAbsent, {
        kind: 'unverified',
        reason: 'invalidSignature',
      });
      assert.deepEqual(fetchFailed, { kind: 'keysUnavailable' });
      assert.deepEqual(standIn.asked, [
        DISCOVERY_PATH,
        KEY_SET_PATH,
        DISCOVERY_PATH,
        KEY_SET_PATH,
        DISCOVERY_PATH,
        KEY_SET_PATH,
        DISCOVERY_PATH,
      ]);
    });

    test('fetches at most once in a cooldown however many made-up key ids arrive, answering each signingKeyUnconfirmed but the one whose fetch refuses it', async (context) => {
      const standIn = await startStandIn(context);
      const key = await signingKey();
      standIn.published = [key.jwk];
      const clock = controlledClock();
      const verifier = verifierFor(standIn, clock);
      await verifier.verify(await signed(key, claimsFor(standIn.issuer)));
      const madeUp = (prefix: string): Promise<string[]> =>
        Promise.all(
          Array.from({ length: 50 }, (_, index) =>
            signed(key, claimsFor(standIn.issuer), {
              kid: `${prefix}-${index}`,
            }),
          ),
        );
      const [within, after] = await Promise.all([
        madeUp('within'),
        madeUp('after'),
      ]);

      const atOnce = await Promise.all(
        within.map((token) => verifier.verify(token)),
      );
      const askedWithin = standIn.asked.length;
      clock.advance(KEY_REFETCH_COOLDOWN_MILLISECONDS);
      const oneByOne = await after.reduce<Promise<readonly string[]>>(
        async (kinds, token) => [
          ...(await kinds),
          (await verifier.verify(token)).kind,
        ],
        Promise.resolve([]),
      );

      assert.deepEqual(
        atOnce.map(({ kind }) => kind),
        within.map(() => 'signingKeyUnconfirmed'),
      );
      assert.equal(askedWithin, 2);
      assert.deepEqual(oneByOne, [
        'unverified',
        ...after.slice(1).map(() => 'signingKeyUnconfirmed'),
      ]);
      assert.equal(standIn.asked.length, 4);
    });

    test('refuses it as invalidSignature when the keys were fetched for the token itself, none being held before', async (context) => {
      const standIn = await startStandIn(context);
      const key = await signingKey();
      standIn.published = [key.jwk];
      const verifier = verifierFor(standIn, controlledClock());

      const verification = await verifier.verify(
        await signed(key, claimsFor(standIn.issuer), {
          kid: 'never-published',
        }),
      );

      assert.deepEqual(verification, {
        kind: 'unverified',
        reason: 'invalidSignature',
      });
      assert.equal(standIn.asked.length, 2);
    });
  },
);

suite('verifying a token under the keys already held, fetching nothing', () => {
  test('reads a token as keyNotHeld while no keys are held, asking the provider for nothing', async (context) => {
    const standIn = await startStandIn(context);
    const key = await signingKey();
    standIn.published = [key.jwk];

    const verification = await verifierFor(standIn).verifyHeld(
      await signed(key, claimsFor(standIn.issuer)),
    );

    assert.deepEqual(verification, { kind: 'keyNotHeld' });
    assert.deepEqual(standIn.asked, []);
  });

  test('verifies a token under a key held, giving its claims and its protected header, asking the provider for nothing more', async (context) => {
    const standIn = await startStandIn(context);
    const key = await signingKey();
    standIn.published = [key.jwk];
    const verifier = verifierFor(standIn);
    await verifier.verify(await signed(key, claimsFor(standIn.issuer)));
    const claims = claimsFor(standIn.issuer, { sub: 'subject-bo' });

    const verification = await verifier.verifyHeld(await signed(key, claims));

    assert.deepEqual(verification, {
      claims,
      header: { alg: key.jwk.alg, kid: key.kid, typ: 'JWT' },
      kind: 'verified',
    });
    assert.deepEqual(standIn.asked, [DISCOVERY_PATH, KEY_SET_PATH]);
  });

  test('reads a token under a key published since the keys were fetched as keyNotHeld, asking the provider for nothing within the cooldown or after it', async (context) => {
    const standIn = await startStandIn(context);
    const first = await signingKey();
    const rotated = await signingKey();
    standIn.published = [first.jwk];
    const clock = controlledClock();
    const verifier = verifierFor(standIn, clock);
    await verifier.verify(await signed(first, claimsFor(standIn.issuer)));
    standIn.published = [first.jwk, rotated.jwk];
    const token = await signed(rotated, claimsFor(standIn.issuer));

    const withinCooldown = await verifier.verifyHeld(token);
    clock.advance(KEY_REFETCH_COOLDOWN_MILLISECONDS);
    const afterCooldown = await verifier.verifyHeld(token);

    assert.deepEqual(
      [withinCooldown, afterCooldown],
      [{ kind: 'keyNotHeld' }, { kind: 'keyNotHeld' }],
    );
    assert.deepEqual(standIn.asked, [DISCOVERY_PATH, KEY_SET_PATH]);
  });

  test('reads a token as keyNotHeld once the keys held pass their maximum age, asking the provider for nothing', async (context) => {
    const standIn = await startStandIn(context);
    const key = await signingKey();
    standIn.published = [key.jwk];
    const clock = adjustableClock();
    const verifier = verifierFor(standIn, clock);
    const token = await signed(key, claimsFor(standIn.issuer));
    await verifier.verify(token);
    clock.advance(KEY_SET_MAXIMUM_AGE_MILLISECONDS);

    const verification = await verifier.verifyHeld(token);

    assert.deepEqual(verification, { kind: 'keyNotHeld' });
    assert.deepEqual(standIn.asked, [DISCOVERY_PATH, KEY_SET_PATH]);
  });

  test("refuses what is no compact signed token as unreadableToken, and another issuer's token as otherIssuer, before looking for any key", async (context) => {
    const standIn = await startStandIn(context);
    const key = await signingKey();
    standIn.published = [key.jwk];
    const verifier = verifierFor(standIn);

    const verifications = [
      await verifier.verifyHeld('not-a-token'),
      await verifier.verifyHeld('a.b.c'),
      await verifier.verifyHeld(
        await signed(
          key,
          claimsFor(standIn.issuer, { iss: 'http://127.0.0.1:1/realms/test' }),
        ),
      ),
    ];

    assert.deepEqual(verifications, [
      { kind: 'unverified', reason: 'unreadableToken' },
      { kind: 'unverified', reason: 'unreadableToken' },
      { kind: 'unverified', reason: 'otherIssuer' },
    ]);
    assert.deepEqual(standIn.asked, []);
  });
});

suite(
  'refuses as invalidSignature a token not signed by a published key under its own algorithm, whatever became of the latest fetch',
  { todo: true },
  () => {},
);

suite('writing a failed fetch of the key set', () => {
  test('writes one line at error for a failed fetch, naming its cause alone and never a URL or what the provider answered', async (context) => {
    const cases: readonly {
      cause: KeySetFetchFailure;
      departure: Partial<StandIn>;
    }[] = [
      { cause: 'unreachable', departure: { hangingUp: true } },
      { cause: 'status', departure: { refusing: true } },
      { cause: 'status', departure: { redirecting: true } },
      {
        cause: 'discoveryIssuer',
        departure: {
          discoveryIssuer: 'https://elsewhere.example.org/realms/test',
        },
      },
      {
        cause: 'keySetLocation',
        departure: {
          keySetLocation: 'http://auth.example.org/realms/test/certs',
        },
      },
      { cause: 'keySetShape', departure: { keySet: '{"keys":"none"}' } },
      { cause: 'keySetShape', departure: { keySet: 'not json' } },
    ];

    const written = await Promise.all(
      cases.map(async ({ departure }) => {
        const standIn = Object.assign(await startStandIn(context), departure);
        const key = await signingKey();
        standIn.published = [key.jwk];
        const lines: Line[] = [];
        const verification = await verifierFor(
          standIn,
          adjustableClock(),
          lines,
        ).verify(await signed(key, claimsFor(standIn.issuer)));
        return { asked: standIn.asked, lines, verification };
      }),
    );

    assert.deepEqual(
      written.map(({ lines }) => lines),
      cases.map(({ cause }) => [failedFetch(cause)]),
    );
    written.forEach(({ verification }) =>
      assert.deepEqual(verification, { kind: 'keysUnavailable' }),
    );
    assert.deepEqual(written[2]?.asked, [DISCOVERY_PATH]);
  });

  test('writes one line for each fetch attempted, one for tokens verified at once, none within the cooldown and none for a fetch that succeeds', async (context) => {
    const standIn = await startStandIn(context);
    const key = await signingKey();
    standIn.published = [key.jwk];
    standIn.refusing = true;
    const clock = adjustableClock();
    const lines: Line[] = [];
    const verifier = verifierFor(standIn, clock, lines);
    const token = await signed(key, claimsFor(standIn.issuer));

    await Promise.all([1, 2, 3].map(() => verifier.verify(token)));
    await verifier.verify(token);
    const withinCooldown = [...lines];
    clock.advance(KEY_REFETCH_COOLDOWN_MILLISECONDS);
    await verifier.verify(token);
    standIn.refusing = false;
    clock.advance(KEY_REFETCH_COOLDOWN_MILLISECONDS);
    const onceAnswering = await verifier.verify(token);

    assert.deepEqual(withinCooldown, [failedFetch('status')]);
    assert.deepEqual(lines, [failedFetch('status'), failedFetch('status')]);
    assert.equal(onceAnswering.kind, 'verified');
    assert.equal(standIn.asked.length, 4);
  });
});
