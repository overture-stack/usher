import assert from 'node:assert/strict';
import { suite, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';

import type {
  Actor,
  AuditEvent,
  AuditTransaction,
  LineFields,
} from '../eventLog/index.js';
import { createServer } from '../http/index.js';
import type { TokenVerification } from '../identityProvider/index.js';
import { CommitUnconfirmed } from '../storeTimeout/index.js';
import {
  createSignOutRoute,
  SIGN_OUT_PATH,
  SIGN_OUT_STORE_FAILED,
  SIGN_OUT_UNEXPECTED_FAILURE,
} from './createSignOutRoute.js';
import { BACK_CHANNEL_LOGOUT_EVENT } from './readLogoutToken.js';

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);

const SECONDS = NOW / 1000;

const ISSUER = 'https://auth.example.org/realms/usher';

const SETTINGS = Object.freeze({
  backChannelLogoutAudiences: ['portal-ui'],
  clock: { now: () => NOW },
  databaseSchema: 'usher',
  identityProviderIssuer: ISSUER,
  signInTokenMaximumLifetimeSeconds: 3600,
});

// Opaque text standing for tokens: the verifier is the stand's, and gives each its verification.
const TOKEN = 'logout-token-ana';

const OTHER_AUDIENCE_TOKEN = 'logout-token-for-another-client';

const verifiedLogout = (
  claims: Readonly<Record<string, unknown>> = {},
): TokenVerification => ({
  claims: {
    aud: ['portal-ui'],
    events: { [BACK_CHANNEL_LOGOUT_EVENT]: {} },
    exp: SECONDS + 120,
    iat: SECONDS,
    iss: ISSUER,
    sid: 'session-1',
    sub: 'subject-ana',
    ...claims,
  },
  header: { alg: 'RS256', typ: 'logout+jwt' },
  kind: 'verified',
});

const VERIFICATIONS: Readonly<Record<string, TokenVerification>> = {
  [OTHER_AUDIENCE_TOKEN]: verifiedLogout({ aud: ['another-client'] }),
  [TOKEN]: verifiedLogout(),
  'unreadable-token': { kind: 'unverified', reason: 'unreadableToken' },
  'token-from-another-issuer': { kind: 'unverified', reason: 'otherIssuer' },
};

interface Line {
  fields: LineFields | undefined;
  message: string;
}

interface Statement {
  text: string;
  values: readonly unknown[] | undefined;
}

interface Stand {
  actors: Actor[];
  counted: string[];
  lines: Line[];
  recorded: AuditEvent[];

  /** The events recorded outside any transaction, each with its actor. */
  refusals: { actor: Actor; event: AuditEvent }[];

  server: FastifyInstance;
  statements: Statement[];
  verified: string[];
}

interface StandOptions {
  /** Settles when the transaction may commit; at once by default. */
  commit?: Promise<void>;

  /**
   * Whether an event recorded outside any transaction is written: true by default. False resolves its
   * recording to `undefined`, as the trail does for a row it could not write, having logged that itself.
   */
  eventsRecorded?: boolean;

  /** What the transaction throws once its work has run, as a store failing at its commit does. */
  failure?: unknown;

  /** The rows the store answers the sign-out's own statement with: one recorded by default. */
  signOutRows?: readonly Record<string, unknown>[];

  /** What the verifier gives each token, or throws for it; any other is refused as invalidSignature. */
  verifications?: Readonly<Record<string, TokenVerification | Error>>;
}

const standUp = (
  context: TestContext,
  {
    commit = Promise.resolve(),
    eventsRecorded = true,
    failure,
    signOutRows = [{ subject: 'subject-ana' }],
    verifications = VERIFICATIONS,
  }: StandOptions = {},
): Stand => {
  const stand: Omit<Stand, 'server'> = {
    actors: [],
    counted: [],
    lines: [],
    recorded: [],
    refusals: [],
    statements: [],
    verified: [],
  };
  const query = async (text: string, values?: readonly unknown[]) => {
    stand.statements.push({ text, values });
    return { rows: stand.statements.length === 1 ? signOutRows : [] };
  };
  const transaction: AuditTransaction<pg.ClientBase> = {
    // A client that never connects, its query answered here.
    connection: Object.assign(new pg.Client(), { query }),
    record: async (event) => {
      stand.recorded.push(event);
      return 'event-id';
    },
  };
  const server = createServer({
    isLive: () => true,
    isReady: async () => true,
    trustedProxies: [],
  });
  server.route(
    createSignOutRoute({
      eventLog: {
        error: (message, fields) => {
          stand.lines.push({ fields, message });
        },
      },
      refusalTally: {
        count: (reason) => {
          stand.counted.push(reason);
        },
      },
      settings: SETTINGS,
      tokenVerifier: {
        verify: async (token) => {
          stand.verified.push(token);
          const verification = verifications[token] ?? {
            kind: 'unverified',
            reason: 'invalidSignature',
          };
          if (verification instanceof Error) {
            throw verification;
          }
          return verification;
        },
      },
      trail: {
        inTransaction: async (actor, work) => {
          stand.actors.push(actor);
          const result = await work(transaction);
          await commit;
          if (failure !== undefined) {
            throw failure;
          }
          return result;
        },
        recordEvent: async (actor, event) => {
          stand.refusals.push({ actor, event });
          return eventsRecorded ? 'event-id' : undefined;
        },
      },
    }),
  );
  context.after(() => server.close());
  return { ...stand, server };
};

const FORM = 'application/x-www-form-urlencoded';

const post = (
  { server }: Stand,
  {
    body = new URLSearchParams({ logout_token: TOKEN }).toString(),
    contentType = FORM,
    url = SIGN_OUT_PATH,
  }: { body?: string; contentType?: string; url?: string } = {},
): Promise<LightMyRequestResponse> =>
  server.inject({
    headers: { 'content-type': contentType },
    method: 'POST',
    payload: body,
    url,
  });

const formWith = (token: string): string =>
  new URLSearchParams({ logout_token: token }).toString();

const codeOf = (answer: LightMyRequestResponse): unknown => {
  const parsed: unknown = JSON.parse(answer.body);
  return typeof parsed === 'object' && parsed !== null
    ? Reflect.get(parsed, 'code')
    : undefined;
};

const refusalOf = (
  answer: LightMyRequestResponse,
): {
  cacheControl: unknown;
  code: unknown;
  mediaType: unknown;
  status: number;
} => ({
  cacheControl: answer.headers['cache-control'],
  code: codeOf(answer),
  mediaType: String(answer.headers['content-type']).split(';')[0],
  status: answer.statusCode,
});

const refusal = (
  status: number,
  code: string,
): ReturnType<typeof refusalOf> => ({
  cacheControl: 'no-store',
  code,
  mediaType: 'application/problem+json',
  status,
});

suite('relaying a back-channel logout', () => {
  test('records the sign-out a verified logout token relays, as the system, and answers 200 with no body and no-store', async (context) => {
    const stand = standUp(context);

    const answer = await post(stand);

    assert.equal(answer.statusCode, 200);
    assert.equal(answer.body, '');
    assert.equal(answer.headers['cache-control'], 'no-store');
    assert.deepEqual(stand.verified, [TOKEN]);
    assert.deepEqual(stand.actors, [{ type: 'system' }]);
    assert.deepEqual(stand.statements[0]?.values, [
      ISSUER,
      'session-1',
      'subject-ana',
      new Date(NOW),
      new Date(NOW + 3_600_000),
    ]);
    assert.deepEqual(stand.statements[1]?.values, ['subject-ana']);
    assert.deepEqual(
      stand.recorded.map(({ data, type }) => ({ data, type })),
      [
        {
          data: {
            result: 'succeeded',
            signedOutUserId: 'subject-ana',
            sourceIp: '127.0.0.1',
          },
          type: 'identity.signOut',
        },
      ],
    );
  });

  test('answers only once the sign-out has committed', async (context) => {
    const gate = Promise.withResolvers<void>();
    const stand = standUp(context, { commit: gate.promise });

    const answering = post(stand);
    const early = await Promise.race([
      answering.then(() => 'answered'),
      delay(100).then(() => 'waiting'),
    ]);
    gate.resolve();
    const answer = await answering;

    assert.equal(early, 'waiting');
    assert.equal(answer.statusCode, 200);
  });

  test('answers 200 for a sign-out the store holds already, writing no notice and no event', async (context) => {
    const stand = standUp(context, { signOutRows: [] });

    const answer = await post(stand);

    assert.equal(answer.statusCode, 200);
    assert.equal(stand.statements.length, 1);
    assert.deepEqual(stand.recorded, []);
  });
});

suite('refusing a back-channel logout request by its shape', () => {
  test('refuses 400 a query, or a body not carrying one form-encoded logout_token, verifying no token and recording nothing', async (context) => {
    const stand = standUp(context);
    const token = formWith(TOKEN);

    const answers = await Promise.all([
      post(stand, { url: `${SIGN_OUT_PATH}?${token}` }),
      post(stand, {
        body: JSON.stringify({ logout_token: TOKEN }),
        contentType: 'application/json',
      }),
      post(stand, { body: 'state=signed-out' }),
      post(stand, { body: `${token}&${token}` }),
    ]);

    assert.deepEqual(answers.map(refusalOf), [
      refusal(400, 'unreadableQuery'),
      refusal(400, 'unreadableBody'),
      refusal(400, 'unreadableBody'),
      refusal(400, 'unreadableBody'),
    ]);
    assert.deepEqual(stand.verified, []);
    assert.deepEqual(stand.actors, []);
  });

  test('refuses 400 bodyTooLarge a body larger than 64 KiB, verifying no token', async (context) => {
    const stand = standUp(context);

    const answer = await post(stand, {
      body: `${formWith(TOKEN)}&padding=${'a'.repeat(64 * 1024)}`,
    });

    assert.deepEqual(refusalOf(answer), refusal(400, 'bodyTooLarge'));
    assert.deepEqual(stand.verified, []);
  });
});

suite('refusing a back-channel logout by its token', () => {
  test('refuses 400 every token the verifier does not verify, counting each by its reason and recording no event', async (context) => {
    const stand = standUp(context);

    const answers = await Promise.all(
      [
        'unreadable-token',
        'token-from-another-issuer',
        'token-under-no-published-key',
      ].map((token) => post(stand, { body: formWith(token) })),
    );

    assert.deepEqual(
      answers.map(refusalOf),
      answers.map(() => refusal(400, 'logoutTokenRefused')),
    );
    assert.deepEqual(stand.counted.toSorted(), [
      'invalidSignature',
      'otherIssuer',
      'unreadableToken',
    ]);
    assert.deepEqual(stand.refusals, []);
    assert.deepEqual(stand.actors, []);
  });

  test('refuses 400 a verified token that is not a logout token for this deployment, recording one refusal as anonymous naming its reason, the request and its refused subject, and counting nothing', async (context) => {
    const stand = standUp(context);

    const answer = await post(stand, { body: formWith(OTHER_AUDIENCE_TOKEN) });

    assert.deepEqual(refusalOf(answer), refusal(400, 'logoutTokenRefused'));
    assert.deepEqual(stand.refusals, [
      {
        actor: { type: 'anonymous' },
        event: {
          data: {
            reason: 'otherAudience',
            result: 'denied',
            refusedSubject: 'subject-ana',
            sourceIp: '127.0.0.1',
          },
          severity: 'warning',
          type: 'logoutToken.refusal',
        },
      },
    ]);
    assert.deepEqual(stand.counted, []);
    assert.deepEqual(stand.actors, []);
  });

  test('answers 400 logoutTokenRefused with no-store for a verified token refused anyway whose refusal could not be recorded, writing no line of its own', async (context) => {
    const stand = standUp(context, { eventsRecorded: false });

    const answer = await post(stand, { body: formWith(OTHER_AUDIENCE_TOKEN) });

    assert.deepEqual(refusalOf(answer), refusal(400, 'logoutTokenRefused'));
    assert.equal(stand.refusals.length, 1);
    assert.deepEqual(stand.lines, []);
    assert.deepEqual(stand.actors, []);
  });

  test("answers 400 identityProviderUnavailable while the identity provider's keys cannot be fetched to verify the token, recording and counting nothing", async (context) => {
    const stand = standUp(context, {
      verifications: { [TOKEN]: { kind: 'keysUnavailable' } },
    });

    const answer = await post(stand);

    assert.deepEqual(
      refusalOf(answer),
      refusal(400, 'identityProviderUnavailable'),
    );
    assert.deepEqual(stand.counted, []);
    assert.deepEqual(stand.refusals, []);
    assert.deepEqual(stand.actors, []);
  });

  test('answers 400 signingKeyUnconfirmed with no Retry-After for a signing key not confirmed yet, recording and counting nothing', async (context) => {
    const stand = standUp(context, {
      verifications: {
        [TOKEN]: { kind: 'signingKeyUnconfirmed', retryAfterSeconds: 17 },
      },
    });

    const answer = await post(stand);

    assert.deepEqual(refusalOf(answer), refusal(400, 'signingKeyUnconfirmed'));
    assert.equal(answer.headers['retry-after'], undefined);
    assert.deepEqual(stand.counted, []);
    assert.deepEqual(stand.refusals, []);
    assert.deepEqual(stand.actors, []);
  });

  test('records and counts nothing for a request refused before its token is verified', async (context) => {
    const stand = standUp(context);

    await Promise.all([
      post(stand, { body: 'state=signed-out' }),
      post(stand, { url: `${SIGN_OUT_PATH}?${formWith(TOKEN)}` }),
    ]);

    assert.deepEqual(stand.counted, []);
    assert.deepEqual(stand.refusals, []);
  });
});

suite('answering a sign-out the controller could not take', () => {
  test("answers 400 storeUnavailable, writing one line naming the failure's code and the route alone", async (context) => {
    const failure = Object.assign(
      new Error(`terminating connection while writing ${TOKEN}`),
      { code: '57P01' },
    );
    const stand = standUp(context, { failure });

    const answer = await post(stand);

    assert.deepEqual(refusalOf(answer), refusal(400, 'storeUnavailable'));
    assert.deepEqual(stand.lines, [
      {
        fields: { code: '57P01', route: SIGN_OUT_PATH },
        message: SIGN_OUT_STORE_FAILED,
      },
    ]);
  });

  test('answers 400 outcomeUnknown for a commit the store did not confirm, writing no line of its own', async (context) => {
    const stand = standUp(context, { failure: new CommitUnconfirmed() });

    const answer = await post(stand);

    assert.deepEqual(refusalOf(answer), refusal(400, 'outcomeUnknown'));
    assert.deepEqual(stand.lines, []);
  });

  test('writes a store failure whose code is not an identifier by the route alone', async (context) => {
    const failure = Object.assign(new Error('the store failed'), {
      code: `refused ${TOKEN}`,
    });
    const stand = standUp(context, { failure });

    const answer = await post(stand);

    assert.deepEqual(refusalOf(answer), refusal(400, 'storeUnavailable'));
    assert.deepEqual(stand.lines, [
      { fields: { route: SIGN_OUT_PATH }, message: SIGN_OUT_STORE_FAILED },
    ]);
  });

  test('answers 400 internalError for a failure it did not expect, writing its code, else its name only when an identifier, else Error', async (context) => {
    const coded = Object.assign(new Error(`reset while reading ${TOKEN}`), {
      code: 'ECONNRESET',
    });
    const named = Object.assign(new Error(`failed reading ${TOKEN}`), {
      name: 'VerifierFailure',
    });
    const misnamed = Object.assign(new Error('failed'), {
      name: `failed reading ${TOKEN}`,
    });
    const stand = standUp(context, {
      verifications: {
        'coded-failure': coded,
        'misnamed-failure': misnamed,
        'named-failure': named,
      },
    });

    const answers = await Promise.all(
      ['coded-failure', 'named-failure', 'misnamed-failure'].map((token) =>
        post(stand, { body: formWith(token) }),
      ),
    );

    assert.deepEqual(
      answers.map(refusalOf),
      answers.map(() => refusal(400, 'internalError')),
    );
    assert.deepEqual(
      stand.lines.map(({ fields }) => fields?.['error']).toSorted(),
      ['ECONNRESET', 'Error', 'VerifierFailure'],
    );
    assert.ok(
      stand.lines.every(
        ({ fields, message }) =>
          message === SIGN_OUT_UNEXPECTED_FAILURE &&
          fields?.['route'] === SIGN_OUT_PATH,
      ),
    );
  });
});
