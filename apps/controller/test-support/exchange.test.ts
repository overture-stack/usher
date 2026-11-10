import assert from 'node:assert/strict';
import { hkdfSync, randomBytes } from 'node:crypto';
import { suite, type TestContext, test } from 'node:test';

import { CompactEncrypt, decodeJwt, jwtVerify } from 'jose';

import { SUBKEY_LABELS } from './bridgeWire.js';
import {
  applicationKeyBytes,
  carriesToken,
  comparableWireRefusal,
  decryptionKey,
  exchange,
  freshAssertion,
  mintSignInToken,
  PEOPLE,
  readUnderKey,
  readUsherToken,
  type WireResponse,
} from './exchange.js';
import { startIdentityProvider } from './identityProvider.js';
import {
  type RecordingServer,
  type ScriptedAnswer,
  startRecordingServer,
} from './recordingServer.js';

const KEY_BYTES = new Uint8Array(randomBytes(32));

const APPLICATION = Object.freeze({
  id: 'arranger-test',
  key: Buffer.from(KEY_BYTES).toString('base64url'),
});

const ISSUER = 'https://usher.example.org';

const recording = async (
  context: TestContext,
  answer?: () => ScriptedAnswer,
): Promise<RecordingServer> => {
  const server = await startRecordingServer(answer);
  context.after(() => server.stop());
  return server;
};

const assertionClaims = async (
  authorization: string | string[] | undefined,
): Promise<Readonly<Record<string, unknown>>> => {
  assert.equal(typeof authorization, 'string');
  const [scheme, assertion = ''] = String(authorization).split(' ');
  assert.equal(scheme, 'Bearer');
  const subkey = new Uint8Array(
    hkdfSync(
      'sha256',
      KEY_BYTES,
      new Uint8Array(0),
      SUBKEY_LABELS.channelAssertion,
      32,
    ),
  );
  const { payload } = await jwtVerify(assertion, subkey, {
    algorithms: ['HS256'],
    audience: 'usher:controller',
    issuer: APPLICATION.id,
    typ: 'usher-channel+jwt',
  });
  return payload;
};

const TOKEN_SUBKEY = new Uint8Array(
  hkdfSync('sha256', KEY_BYTES, new Uint8Array(0), SUBKEY_LABELS.token, 32),
);

const usherToken = (payload: object): Promise<string> =>
  new CompactEncrypt(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', typ: 'usher+jwt' })
    .encrypt(TOKEN_SUBKEY);

suite('the exchange client', () => {
  test('posts a sign-in token as the bridge does: its three headers, a fresh channel assertion and { credential, payloadVersions }', async (context) => {
    const server = await recording(context);

    await exchange(server.url, {
      application: APPLICATION,
      credential: 'sign-in-token',
    });
    const [request] = server.requests;

    assert.equal(request?.method, 'POST');
    assert.equal(request?.target, '/exchange');
    assert.equal(request?.headers.accept, 'application/jwt');
    assert.equal(request?.headers['content-type'], 'application/json');
    assert.equal(
      request?.body,
      '{"credential":"sign-in-token","payloadVersions":[1]}',
    );
    const claims = await assertionClaims(request?.headers.authorization);
    assert.equal(Number(claims.exp) - Number(claims.iat), 60);
  });

  test('leaves the credential out of the anonymous exchange', async (context) => {
    const server = await recording(context);

    await exchange(server.url, { application: APPLICATION });
    await exchange(server.url, { application: APPLICATION, credential: null });

    assert.deepEqual(
      server.requests.map(({ body }) => body),
      ['{"payloadVersions":[1]}', '{"payloadVersions":[1]}'],
    );
  });

  test("resolves the exchange against the controller's URL, as the bridge does", async (context) => {
    const server = await recording(context);

    await exchange(new URL('usher/', server.url), { application: APPLICATION });

    assert.equal(server.requests[0]?.target, '/usher/exchange');
  });

  test("sends what a malformed-request test asks for in place of the bridge's request", async (context) => {
    const server = await recording(context);
    const otherAssertion = await freshAssertion({
      id: 'lyric-test',
      key: APPLICATION.key,
    });

    await exchange(server.url, { application: APPLICATION, assertion: null });
    await exchange(server.url, {
      application: APPLICATION,
      assertion: otherAssertion,
    });
    await exchange(server.url, { application: APPLICATION, body: '[1, 2' });
    await exchange(server.url, {
      application: APPLICATION,
      credential: 'sign-in-token',
      extraMembers: { audience: 'lyric-test', payloadVersions: ['1'] },
    });
    await exchange(server.url, {
      application: APPLICATION,
      headers: { 'Content-Type': 'text/plain', accept: undefined },
      payloadVersions: [2, 1],
    });
    const [unsigned, other, raw, extra, retyped] = server.requests;

    assert.equal(unsigned?.headers.authorization, undefined);
    assert.equal(other?.headers.authorization, `Bearer ${otherAssertion}`);
    assert.equal(raw?.body, '[1, 2');
    assert.equal(
      extra?.body,
      '{"credential":"sign-in-token","payloadVersions":["1"],"audience":"lyric-test"}',
    );
    assert.equal(retyped?.headers['content-type'], 'text/plain');
    assert.equal(retyped?.headers.accept, '*/*');
    assert.equal(retyped?.body, '{"payloadVersions":[2,1]}');
  });

  test('answers back a redirect rather than following it', async (context) => {
    const server = await recording(context, () => ({
      headers: { location: 'https://elsewhere.example.org/exchange' },
      status: 307,
    }));

    const response = await exchange(server.url, { application: APPLICATION });

    assert.equal(response.status, 307);
    assert.equal(server.requests.length, 1);
  });

  test("reads an Usher token from the answer as the bridge reads one, trimmed, under the application key's token subkey", async (context) => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const payload = {
      aud: APPLICATION.id,
      exp: issuedAt + 300,
      generatedAt: issuedAt,
      globalCategories: ['global.controlled'],
      iat: issuedAt,
      iss: ISSUER,
      payloadVersion: 1,
      permissions: {},
      resourceCategories: {},
      servedResources: ['STUDY-A1'],
      sub: null,
    };
    const token = await usherToken(payload);
    const server = await recording(context, () => ({
      body: `${token}\n`,
      headers: { 'content-type': 'application/jwt' },
      status: 200,
    }));

    const response = await exchange(server.url, { application: APPLICATION });
    const reading = await readUsherToken(response.body, {
      application: APPLICATION,
      issuer: ISSUER,
    });
    const elsewhere = await readUsherToken(response.body, {
      application: { ...APPLICATION, id: 'lyric-test' },
      issuer: ISSUER,
    });

    assert.deepEqual(reading, { kind: 'payload', payload });
    assert.deepEqual(elsewhere, {
      kind: 'rejected',
      reason: 'audienceRejected',
    });
  });

  test("mints a person's sign-in token for an application, its audience that application alone", async (context) => {
    const provider = await startIdentityProvider();
    context.after(() => provider.stop());

    const token = await mintSignInToken(
      provider,
      {
        email: 'ana@example.org',
        subject: '0b7c2f1e-5d1a-4c3e-9f2a-6e8d4b1a7c90',
      },
      'lyric-test',
      { claims: { sid: 'session-1' } },
    );
    const claims = decodeJwt(token);

    assert.deepEqual(claims.aud, ['lyric-test']);
    assert.equal(claims.sub, '0b7c2f1e-5d1a-4c3e-9f2a-6e8d4b1a7c90');
    assert.equal(claims['email'], 'ana@example.org');
    assert.equal(claims['sid'], 'session-1');
    assert.equal(claims.iss, provider.issuer);
  });
});

suite('the people the tests name', () => {
  test('gives each a subject of its own and an address at example.org, in the forms a provider can send', () => {
    const people = Object.values(PEOPLE);

    assert.equal(
      new Set(people.map(({ subject }) => subject)).size,
      people.length,
    );
    assert.ok(people.every(({ email }) => email.endsWith('@example.org')));
    assert.equal(PEOPLE.cy.subject.toLowerCase(), PEOPLE.cy2.subject);
    assert.equal(PEOPLE.long.subject.length, 255);
    assert.match(
      PEOPLE.ana.subject,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  test('includes subjects an encoder or a pattern match can mishandle', () => {
    const likePattern = new RegExp(
      `^${PEOPLE.wildcard.subject.replaceAll('%', '.*').replaceAll('_', '.')}$`,
      'u',
    );

    assert.match(PEOPLE.wildcardLookalike.subject, likePattern);
    assert.ok(
      ['"', '\\'].every((held) => PEOPLE.quoted.subject.includes(held)),
    );
    assert.ok(
      ['"', '\\', '\n', '\u2028', '</script>'].every((held) =>
        PEOPLE.markup.subject.includes(held),
      ),
    );
  });
});

suite("reading a token under a key of the test's choosing", () => {
  test("opens a token under its application's token subkey, and refuses it under the application key itself and under another application's", async () => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = await usherToken({
      aud: APPLICATION.id,
      exp: issuedAt + 300,
      generatedAt: issuedAt,
      globalCategories: [],
      iat: issuedAt,
      iss: ISSUER,
      payloadVersion: 1,
      permissions: {},
      resourceCategories: {},
      servedResources: [],
      sub: null,
    });

    const own = await readUnderKey(token, {
      audience: APPLICATION.id,
      issuer: ISSUER,
      tokenKey: await decryptionKey(TOKEN_SUBKEY),
    });
    const others = await Promise.all(
      [applicationKeyBytes(APPLICATION), new Uint8Array(randomBytes(32))].map(
        async (bytes) =>
          readUnderKey(token, {
            audience: APPLICATION.id,
            issuer: ISSUER,
            tokenKey: await decryptionKey(bytes),
          }),
      ),
    );

    assert.equal(own.kind, 'payload');
    assert.deepEqual(others, [
      { kind: 'rejected', reason: 'decryptionFailed' },
      { kind: 'rejected', reason: 'decryptionFailed' },
    ]);
  });
});

const answer = (
  status: number,
  body: string,
  headers: Readonly<Record<string, string>>,
): WireResponse => ({ body, headers: new Headers(headers), status });

suite('two refusals on the wire, compared', () => {
  test('finds two refusals alike when only the instant and a per-request correlation id differ', () => {
    const first = answer(403, '', {
      Date: 'Fri, 23 Oct 2026 12:00:00 GMT',
      'content-length': '0',
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      'x-request-id': 'one',
    });
    const second = answer(403, '', {
      'content-length': '0',
      date: 'Fri, 23 Oct 2026 12:00:07 GMT',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      'x-request-id': 'two',
    });

    assert.deepEqual(
      comparableWireRefusal(first),
      comparableWireRefusal(second),
    );
  });

  test('tells two refusals apart by status, by body, by a value, and by a header one carries alone', () => {
    const reference = answer(403, '', {
      connection: 'keep-alive',
      'content-length': '0',
      date: 'Fri, 23 Oct 2026 12:00:00 GMT',
    });
    const others = [
      answer(401, '', {
        connection: 'keep-alive',
        'content-length': '0',
        date: 'Fri, 23 Oct 2026 12:00:00 GMT',
      }),
      answer(403, 'unreadableToken', {
        connection: 'keep-alive',
        'content-length': '15',
        date: 'Fri, 23 Oct 2026 12:00:00 GMT',
      }),
      answer(403, '', {
        connection: 'close',
        'content-length': '0',
        date: 'Fri, 23 Oct 2026 12:00:00 GMT',
      }),
      answer(403, '', {
        connection: 'keep-alive',
        'content-length': '0',
        date: 'Fri, 23 Oct 2026 12:00:00 GMT',
        'x-request-id': 'only here',
      }),
      answer(403, '', {
        connection: 'keep-alive',
        'content-length': '0',
        date: 'Fri, 23 Oct 2026 12:00:00 GMT',
        'www-authenticate': 'Bearer error="invalid_token"',
      }),
    ];

    others.forEach((other) => {
      assert.notDeepEqual(
        comparableWireRefusal(other),
        comparableWireRefusal(reference),
      );
    });
  });
});

suite('an Usher token in an answer', () => {
  test('finds a compact JWE, trimmed, and nothing else', () => {
    assert.equal(carriesToken('  aa.bb.cc.dd.ee\n'), true);
    assert.equal(carriesToken('aa..cc.dd.ee'), true);
    assert.equal(carriesToken('aa.bb.cc'), false);
    assert.equal(carriesToken('{"code":"unreadableToken"}'), false);
    assert.equal(carriesToken(''), false);
  });
});
