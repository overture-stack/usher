import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { suite, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { compactDecrypt, decodeProtectedHeader } from 'jose';
import pg from 'pg';

import { applicationSubkeys } from '../applicationKeyRing/index.js';
import type { ChannelAssertionCheck } from '../channelAssertion/index.js';
import type {
  Actor,
  AuditEvent,
  AuditTransaction,
  LineFields,
} from '../eventLog/index.js';
import { createServer } from '../http/index.js';
import type { SignInJudgement } from '../signInTokens/index.js';
import { CommitUnconfirmed } from '../storeTimeout/index.js';
import type { ServedResource } from '../tokenCalculation/index.js';
import {
  createExchange,
  EXCHANGE_PATH,
  EXCHANGE_STORE_FAILED,
  EXCHANGE_UNEXPECTED_FAILURE,
} from './createExchange.js';
import type { ExchangeKey } from './types.js';

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0, 750);

// Long enough for an answer given from memory, and far shorter than any wait on the store.
const ANSWER_WITHIN_MS = 1000;

const SECONDS = Math.floor(NOW / 1000);

const APPLICATION = '0d4c7e2a-8b1f-4a63-9e05-3f7a2c9d1b68';

const KEY_SUBKEYS = applicationSubkeys(randomBytes(32));

const KEY: ExchangeKey = {
  applicationId: APPLICATION,
  token: KEY_SUBKEYS.token,
};

const SETTINGS = Object.freeze({
  baseline: ['count', 'view', 'export'] as const,
  clock: { now: () => NOW },
  databaseSchema: 'usher',
  issuer: 'https://usher.example.org',
  tokenLifetimeSeconds: 300,
});

// Opaque text standing for assertions and credentials: the stand gives each its check or its
// judgement, so nothing here is read as a token.
const ASSERTIONS: Readonly<Record<string, ChannelAssertionCheck<ExchangeKey>>> =
  {
    'Bearer assertion-expired': {
      applicationId: APPLICATION,
      kind: 'refused',
      reason: 'expiredAssertion',
    },
    'Bearer assertion-for-another-audience': {
      applicationId: APPLICATION,
      kind: 'refused',
      reason: 'otherAudience',
    },
    'Bearer assertion-of-a-keyless-application': {
      applicationId: APPLICATION,
      kind: 'unverified',
      reason: 'noLiveKey',
    },
    'Bearer assertion-verified': {
      assertion: { acceptedUntil: NOW + 60_000, id: 'jti-1', key: KEY },
      kind: 'verified',
    },
  };

const VERIFIED = 'Bearer assertion-verified';

const ACCEPTED: SignInJudgement = {
  claims: { aud: [APPLICATION], exp: SECONDS + 300, sub: 'subject-ana' },
  expiresAt: SECONDS + 300,
  kind: 'accepted',
  session: { issuedAt: SECONDS - 10, sid: 'session-1' },
  subject: 'subject-ana',
};

const JUDGEMENTS: Readonly<Record<string, SignInJudgement>> = {
  '': { kind: 'recorded', reason: 'missingCredential' },
  'credential-accepted': ACCEPTED,
  'credential-expired': {
    kind: 'recorded',
    reason: 'expiredToken',
    refusedSubject: 'subject "ana" \\',
  },
  'credential-forged': { kind: 'recorded', reason: 'invalidSignature' },
  'credential-while-keys-unavailable': { kind: 'keysUnavailable' },
  'credential-under-a-new-key': {
    kind: 'signingKeyUnconfirmed',
    retryAfterSeconds: 17,
  },
  uak_example: { kind: 'recorded', reason: 'apiKeyVerifierNotConfigured' },
};

// The audience's policy as one read gives it: an open resource holding a category of its own, an open
// one, one open but suppressed, one registered and one retired.
const SERVED: readonly ServedResource[] = [
  {
    baseTier: 'open',
    externalId: 'STUDY-A1',
    ownCategories: ['local-panel'],
    retired: false,
    suppressed: false,
  },
  {
    baseTier: 'open',
    externalId: 'étude « Nord » "B2"',
    ownCategories: [],
    retired: false,
    suppressed: false,
  },
  {
    baseTier: 'open',
    externalId: 'STUDY-F6',
    ownCategories: [],
    retired: false,
    suppressed: true,
  },
  {
    baseTier: 'registered',
    externalId: 'STUDY-C3',
    ownCategories: [],
    retired: false,
    suppressed: false,
  },
  {
    baseTier: 'open',
    externalId: 'STUDY-E5',
    ownCategories: [],
    retired: true,
    suppressed: false,
  },
];

const POLICY_ROW = {
  globalCategories: ['community-governed', 'controlled', 'unmarked'],
  served: SERVED,
};

const ANONYMOUS_PAYLOAD = {
  aud: APPLICATION,
  exp: SECONDS + 300,
  generatedAt: SECONDS,
  globalCategories: ['global.community-governed', 'global.controlled'],
  iat: SECONDS,
  iss: 'https://usher.example.org',
  payloadVersion: 1,
  permissions: {
    'STUDY-A1': { 'global.unmarked': { record: ['count', 'view', 'export'] } },
    'étude « Nord » "B2"': {
      'global.unmarked': { record: ['count', 'view', 'export'] },
    },
  },
  resourceCategories: {
    'STUDY-A1': ['resource.local-panel'],
    'étude « Nord » "B2"': [],
  },
  servedResources: ['STUDY-A1', 'étude « Nord » "B2"', 'STUDY-F6', 'STUDY-C3'],
  sub: null,
};

interface Deferred {
  promise: Promise<void>;
  release(): void;
}

const deferred = (): Deferred => {
  const held: { release: () => void } = { release: () => undefined };
  const promise = new Promise<void>((resolve) => {
    held.release = resolve;
  });
  return { promise, release: () => held.release() };
};

interface Line {
  fields: LineFields | undefined;
  message: string;
}

interface Statement {
  text: string;
  values: readonly unknown[] | undefined;
}

/** One transaction the stand ran: its actor, its statements, and the events recorded in it. */
interface Transaction {
  actor: Actor;
  recorded: AuditEvent[];
  statements: Statement[];
}

interface Stand {
  counted: { applicationId: string | undefined; reason: string }[];
  judged: { audience: string; credential: string; now: number }[];
  lines: Line[];

  /** The events recorded outside any transaction, each with its actor. */
  outside: { actor: Actor; event: AuditEvent }[];

  server: FastifyInstance;
  stop(): Promise<void>;

  /** Every transaction begun, whether or not it committed. */
  transactions: Transaction[];
}

interface StandOptions {
  /** What the transaction throws once its work has run, as a store failing at its commit does. */
  commitFailure?: unknown;

  /** Settles when an event recorded outside any transaction is written: at once by default. */
  outsideRecorded?: Promise<void>;

  /** What the store's read throws, as a store failing within the transaction does. */
  readFailure?: unknown;
}

const standUp = (
  context: TestContext,
  {
    commitFailure,
    outsideRecorded = Promise.resolve(),
    readFailure,
  }: StandOptions = {},
): Stand => {
  const stand: Omit<Stand, 'server' | 'stop'> = {
    counted: [],
    judged: [],
    lines: [],
    outside: [],
    transactions: [],
  };
  const server = createServer({
    isLive: () => true,
    isReady: async () => true,
    trustedProxies: [],
  });
  const exchange = createExchange({
    assertionRejections: {
      count: (reason, applicationId) => {
        stand.counted.push({ applicationId, reason });
      },
    },
    assertions: {
      verify: async (rawHeaders) => {
        const index = rawHeaders.findIndex(
          (name, at) => at % 2 === 0 && name.toLowerCase() === 'authorization',
        );
        const presented = index === -1 ? undefined : rawHeaders[index + 1];
        return (
          ASSERTIONS[presented ?? ''] ?? {
            kind: 'unverified',
            reason: 'missingAssertion',
          }
        );
      },
    },
    eventLog: {
      error: (message, fields) => {
        stand.lines.push({ fields, message });
      },
    },
    judgeCredential: async (credential, { audience, now }) => {
      stand.judged.push({ audience, credential, now });
      const judgement = JUDGEMENTS[credential];
      if (judgement === undefined) {
        throw new TypeError('the stand holds no judgement for the credential');
      }
      return judgement;
    },
    settings: SETTINGS,
    trail: {
      inTransaction: async (actor, work) => {
        const transaction: Transaction = {
          actor,
          recorded: [],
          statements: [],
        };
        stand.transactions.push(transaction);
        const query = async (text: string, values?: readonly unknown[]) => {
          transaction.statements.push({ text, values });
          if (readFailure !== undefined) {
            throw readFailure;
          }
          return { rows: [POLICY_ROW] };
        };
        const opened: AuditTransaction<pg.ClientBase> = {
          // A client that never connects, its query answered here.
          connection: Object.assign(new pg.Client(), { query }),
          record: async (event) => {
            transaction.recorded.push(event);
            return 'event-id';
          },
        };
        const result = await work(opened);
        if (commitFailure !== undefined) {
          throw commitFailure;
        }
        return result;
      },
      recordEvent: async (actor, event) => {
        await outsideRecorded;
        stand.outside.push({ actor, event });
        return 'event-id';
      },
    },
  });
  server.route(exchange.route);
  context.after(async () => {
    await exchange.stop();
    await server.close();
  });
  return { ...stand, server, stop: () => exchange.stop() };
};

interface Sent {
  assertion?: string | null;
  body?: string;
  contentType?: string;
}

const post = (
  { server }: Stand,
  {
    assertion = VERIFIED,
    body = JSON.stringify({ payloadVersions: [1] }),
    contentType = 'application/json',
  }: Sent = {},
): Promise<LightMyRequestResponse> =>
  server.inject({
    headers: {
      'content-type': contentType,
      ...(assertion === null ? {} : { authorization: assertion }),
    },
    method: 'POST',
    payload: body,
    url: EXCHANGE_PATH,
  });

const withCredential = (credential: string): Sent => ({
  body: JSON.stringify({ credential, payloadVersions: [1] }),
});

// An answer as two that must be identical are compared: its status, its body, and every header but
// the date, by name and value.
const onTheWire = (answer: LightMyRequestResponse) => ({
  body: answer.body,
  headers: Object.entries(answer.headers)
    .filter(([name]) => name !== 'date')
    .toSorted(([first], [second]) => first.localeCompare(second)),
  status: answer.statusCode,
});

const problemOf = (
  answer: LightMyRequestResponse,
): { code: unknown; status: number } => ({
  code: (JSON.parse(answer.body) as Readonly<Record<string, unknown>>)['code'],
  status: answer.statusCode,
});

const recordedIn = (stand: Stand): readonly AuditEvent[] =>
  stand.transactions.flatMap(({ recorded }) => recorded);

const storeFailure = (code: string): Error =>
  Object.assign(new Error('the store refused the statement'), { code });

suite('the token exchange', () => {
  suite('a channel assertion it refuses', () => {
    test('answers one identical 401 to every refused assertion, whatever the request carries, and does nothing else for the caller', async (context) => {
      const stand = standUp(context);

      const answers = await Promise.all([
        post(stand, { assertion: null }),
        post(stand, {
          assertion: 'Bearer assertion-expired',
          ...withCredential('credential-accepted'),
        }),
        post(stand, {
          assertion: 'Bearer assertion-of-a-keyless-application',
          body: '{"payloadVersions":',
        }),
        post(stand, {
          assertion: 'Bearer assertion-for-another-audience',
          body: 'x'.repeat(70_000),
        }),
      ]);

      const [first] = answers;
      answers.forEach((answer) => {
        assert.equal(answer.statusCode, 401);
        assert.deepEqual(onTheWire(answer), first && onTheWire(first));
      });
      assert.deepEqual(problemOf(answers[0] ?? assert.fail()), {
        code: 'channelAssertionRefused',
        status: 401,
      });
      assert.equal(first?.headers['www-authenticate'], 'Bearer');
      assert.equal(first?.headers['cache-control'], 'no-store');
      assert.deepEqual(stand.judged, []);
      assert.deepEqual(stand.transactions, []);
    });

    test('counts an assertion it could not verify by reason and the registered application it names, recording no event for it', async (context) => {
      const stand = standUp(context);

      await post(stand, { assertion: null });
      await post(stand, {
        assertion: 'Bearer assertion-of-a-keyless-application',
      });

      assert.deepEqual(stand.counted, [
        { applicationId: undefined, reason: 'missingAssertion' },
        { applicationId: APPLICATION, reason: 'noLiveKey' },
      ]);
      assert.deepEqual(stand.outside, []);
    });

    test("records an assertion verified and refused anyway as channelAssertion.rejection, denied, naming its application and the request's address, its actor the system, counting nothing", async (context) => {
      const stand = standUp(context);

      await post(stand, { assertion: 'Bearer assertion-expired' });
      await stand.stop();

      assert.deepEqual(stand.outside, [
        {
          actor: { type: 'system' },
          event: {
            data: {
              applicationId: APPLICATION,
              reason: 'expiredAssertion',
              result: 'denied',
              sourceIp: '127.0.0.1',
            },
            severity: 'warning',
            type: 'channelAssertion.rejection',
          },
        },
      ]);
      assert.deepEqual(stand.counted, []);
    });

    test('answers before the rejection is recorded, so the store never delays the answer, and its stop settles only once the recording has', async (context) => {
      const written = deferred();
      const stand = standUp(context, { outsideRecorded: written.promise });

      const answering = post(stand, { assertion: 'Bearer assertion-expired' });
      const answeredFirst = await Promise.race([
        answering.then(() => true),
        delay(ANSWER_WITHIN_MS).then(() => false),
      ]);
      const stopping = stand.stop().then(() => stand.outside.length);
      await delay(0);
      const beforeWritten = stand.outside.length;
      written.release();

      assert.equal(answeredFirst, true);
      assert.equal((await answering).statusCode, 401);
      assert.equal(beforeWritten, 0);
      assert.equal(await stopping, 1);
    });
  });

  suite('the request', () => {
    test('answers 400 to a body unreadable by its shape and 406 to one listing no version served, judging nothing and opening no transaction', async (context) => {
      const stand = standUp(context);

      const answers = await Promise.all([
        post(stand, { body: '{"credential":' }),
        post(stand, { body: '[1]' }),
        post(stand, { body: '{"payloadVersions":[1.5]}' }),
        post(stand, { body: '{"credential":42,"payloadVersions":[1]}' }),
        post(stand, {
          body: '{"payloadVersions":[1]}',
          contentType: 'text/plain',
        }),
        post(stand, { body: '{"payloadVersions":[2]}' }),
      ]);

      assert.deepEqual(answers.map(problemOf), [
        { code: 'unreadableBody', status: 400 },
        { code: 'unreadableBody', status: 400 },
        { code: 'unreadableBody', status: 400 },
        { code: 'unreadableBody', status: 400 },
        { code: 'unreadableBody', status: 400 },
        { code: 'payloadVersionUnserved', status: 406 },
      ]);
      answers.forEach((answer) =>
        assert.equal(answer.headers['cache-control'], 'no-store'),
      );
      assert.deepEqual(stand.judged, []);
      assert.deepEqual(stand.transactions, []);
    });

    test('answers 413 to a body larger than 64 KiB from a caller its assertion authenticates', async (context) => {
      const stand = standUp(context);

      const answer = await post(stand, {
        body: JSON.stringify({
          padding: 'x'.repeat(65_536),
          payloadVersions: [1],
        }),
      });

      assert.deepEqual(problemOf(answer), {
        code: 'bodyTooLarge',
        status: 413,
      });
      assert.deepEqual(stand.transactions, []);
    });

    test('issues for the application the assertion names, whatever the body names', async (context) => {
      const stand = standUp(context);

      const answer = await post(stand, {
        body: JSON.stringify({
          aud: 'another-application',
          audience: 'another-application',
          payloadVersions: [2, 1],
        }),
      });
      const { plaintext } = await compactDecrypt(
        answer.body,
        KEY_SUBKEYS.token,
      );

      assert.equal(answer.statusCode, 200);
      assert.equal(
        (JSON.parse(new TextDecoder().decode(plaintext)) as { aud: unknown })
          .aud,
        APPLICATION,
      );
      assert.deepEqual(stand.transactions[0]?.statements[0]?.values, [
        APPLICATION,
      ]);
    });
  });

  suite('the anonymous exchange', () => {
    test("answers one compact token as an application/jwt body, no-store, sealed under the token subkey of the key the assertion verified under, holding the anonymous visitor's version 1 payload exactly", async (context) => {
      const stand = standUp(context);

      const answer = await post(stand);
      const { plaintext } = await compactDecrypt(
        answer.body,
        KEY_SUBKEYS.token,
        {
          contentEncryptionAlgorithms: ['A256GCM'],
          keyManagementAlgorithms: ['dir'],
        },
      );

      assert.equal(answer.statusCode, 200);
      assert.equal(answer.headers['content-type'], 'application/jwt');
      assert.equal(answer.headers['cache-control'], 'no-store');
      assert.match(answer.body, /^[\w-]+\.\.[\w-]+\.[\w-]+\.[\w-]+$/u);
      assert.deepEqual(decodeProtectedHeader(answer.body), {
        alg: 'dir',
        enc: 'A256GCM',
        typ: 'usher+jwt',
      });
      assert.deepEqual(
        JSON.parse(new TextDecoder().decode(plaintext)),
        ANONYMOUS_PAYLOAD,
      );
    });

    test("reads the audience's policy in one statement and records its token.exchange in the same transaction, succeeded, its actor anonymous", async (context) => {
      const stand = standUp(context);

      await post(stand);

      assert.equal(stand.transactions.length, 1);
      assert.deepEqual(stand.transactions[0]?.actor, { type: 'anonymous' });
      assert.equal(stand.transactions[0]?.statements.length, 1);
      assert.deepEqual(stand.transactions[0]?.recorded, [
        {
          data: {
            audience: APPLICATION,
            generatedAt: new Date(SECONDS * 1000).toISOString(),
            grantCount: 0,
            result: 'succeeded',
            rules: ['baseline'],
            sourceIp: '127.0.0.1',
            tokenTtl: 300,
            userId: null,
          },
          severity: 'info',
          type: 'token.exchange',
        },
      ]);
      assert.deepEqual(stand.outside, []);
    });

    test('answers 503 storeUnavailable, issuing no token, when the store cannot answer its read, writing the failure by its code alone', async (context) => {
      const stand = standUp(context, { readFailure: storeFailure('57P01') });

      const answer = await post(stand);

      assert.deepEqual(problemOf(answer), {
        code: 'storeUnavailable',
        status: 503,
      });
      assert.deepEqual(stand.lines, [
        {
          fields: { code: '57P01', route: EXCHANGE_PATH },
          message: EXCHANGE_STORE_FAILED,
        },
      ]);
    });

    test('answers 503 storeUnavailable, issuing no token, when its token.exchange cannot be committed', async (context) => {
      const stand = standUp(context, { commitFailure: storeFailure('40001') });

      const answer = await post(stand);

      assert.deepEqual(problemOf(answer), {
        code: 'storeUnavailable',
        status: 503,
      });
      assert.equal(recordedIn(stand).length, 1);
    });

    test('answers 503 outcomeUnknown, issuing no token, when its commit goes unconfirmed, writing no line of its own', async (context) => {
      const stand = standUp(context, {
        commitFailure: new CommitUnconfirmed(),
      });

      const answer = await post(stand);

      assert.deepEqual(problemOf(answer), {
        code: 'outcomeUnknown',
        status: 503,
      });
      assert.deepEqual(stand.lines, []);
    });
  });

  suite('a credential', () => {
    test("is judged only once its assertion verifies, for the application the assertion names, at the clock's instant", async (context) => {
      const stand = standUp(context);

      await post(stand, {
        assertion: 'Bearer assertion-expired',
        ...withCredential('credential-expired'),
      });
      await post(stand, withCredential('credential-expired'));

      assert.deepEqual(stand.judged, [
        { audience: APPLICATION, credential: 'credential-expired', now: NOW },
      ]);
    });

    test('is answered one identical 403 for every refusal of the judgement, each recorded as denied under its own reason in a transaction of its own, naming refusedSubject only as the judgement does', async (context) => {
      const stand = standUp(context);
      const credentials = [
        'credential-expired',
        'credential-forged',
        '',
        'uak_example',
      ];

      const answers = await Promise.all(
        credentials.map((credential) =>
          post(stand, withCredential(credential)),
        ),
      );

      const [first] = answers;
      answers.forEach((answer) => {
        assert.equal(answer.statusCode, 403);
        assert.deepEqual(onTheWire(answer), first && onTheWire(first));
      });
      assert.deepEqual(problemOf(answers[0] ?? assert.fail()), {
        code: 'credentialRefused',
        status: 403,
      });
      assert.deepEqual(
        stand.transactions.map(({ actor, recorded, statements }) => ({
          actor,
          recorded: recorded.map(({ data, severity }) => ({ data, severity })),
          statements: statements.length,
        })),
        [
          {
            data: {
              reason: 'expiredToken',
              refusedSubject: 'subject "ana" \\',
              result: 'denied',
              sourceIp: '127.0.0.1',
              userId: null,
            },
          },
          {
            data: {
              reason: 'invalidSignature',
              result: 'denied',
              sourceIp: '127.0.0.1',
              userId: null,
            },
          },
          {
            data: {
              reason: 'missingCredential',
              result: 'denied',
              sourceIp: '127.0.0.1',
              userId: null,
            },
          },
          {
            data: {
              reason: 'apiKeyVerifierNotConfigured',
              result: 'denied',
              sourceIp: '127.0.0.1',
              userId: null,
            },
          },
        ].map(({ data }) => ({
          actor: { type: 'anonymous' },
          recorded: [{ data, severity: 'warning' }],
          statements: 0,
        })),
      );
    });

    test('is refused alike when the judgement accepts it, recorded as apiKeyVerifierNotConfigured naming no subject, so no token carries an identity', async (context) => {
      const stand = standUp(context);

      const accepted = await post(stand, withCredential('credential-accepted'));
      const refused = await post(stand, withCredential('credential-forged'));

      assert.equal(accepted.statusCode, 403);
      assert.deepEqual(onTheWire(accepted), onTheWire(refused));
      assert.deepEqual(recordedIn(stand)[0], {
        data: {
          reason: 'apiKeyVerifierNotConfigured',
          result: 'denied',
          sourceIp: '127.0.0.1',
          userId: null,
        },
        severity: 'warning',
        type: 'token.exchange',
      });
      assert.equal(accepted.body.includes('subject-ana'), false);
    });

    test("is answered 503 identityProviderUnavailable while the identity provider's keys cannot be had, the exchange recorded as failed", async (context) => {
      const stand = standUp(context);

      const answer = await post(
        stand,
        withCredential('credential-while-keys-unavailable'),
      );

      assert.deepEqual(problemOf(answer), {
        code: 'identityProviderUnavailable',
        status: 503,
      });
      assert.equal(Object.hasOwn(answer.headers, 'retry-after'), false);
      assert.deepEqual(recordedIn(stand), [
        {
          data: {
            reason: 'identityProviderUnavailable',
            result: 'failed',
            sourceIp: '127.0.0.1',
            userId: null,
          },
          severity: 'error',
          type: 'token.exchange',
        },
      ]);
    });

    test('is answered 503 signingKeyUnconfirmed with its seconds in Retry-After while its signing key is not confirmed yet, the exchange recorded as denied at warning', async (context) => {
      const stand = standUp(context);

      const answer = await post(
        stand,
        withCredential('credential-under-a-new-key'),
      );

      assert.deepEqual(problemOf(answer), {
        code: 'signingKeyUnconfirmed',
        status: 503,
      });
      assert.equal(answer.headers['retry-after'], '17');
      assert.deepEqual(recordedIn(stand), [
        {
          data: {
            reason: 'signingKeyUnconfirmed',
            result: 'denied',
            sourceIp: '127.0.0.1',
            userId: null,
          },
          severity: 'warning',
          type: 'token.exchange',
        },
      ]);
    });

    test('is answered 503 storeUnavailable rather than 403 when its refusal cannot be recorded, so no refusal goes unrecorded while looking answered', async (context) => {
      const stand = standUp(context, { commitFailure: storeFailure('57P01') });

      const answers = await Promise.all(
        [
          'credential-forged',
          'credential-accepted',
          'credential-while-keys-unavailable',
        ].map((credential) => post(stand, withCredential(credential))),
      );

      assert.deepEqual(
        answers.map(problemOf),
        answers.map(() => ({ code: 'storeUnavailable', status: 503 })),
      );
      assert.equal(stand.lines.length, 3);
    });

    test("is answered 503 outcomeUnknown when its refusal's commit goes unconfirmed", async (context) => {
      const stand = standUp(context, {
        commitFailure: new CommitUnconfirmed(),
      });

      const answer = await post(stand, withCredential('credential-forged'));

      assert.deepEqual(problemOf(answer), {
        code: 'outcomeUnknown',
        status: 503,
      });
    });

    test('is answered 500 internalError when judging it fails unexpectedly, the failure written by its name alone and nothing recorded', async (context) => {
      const stand = standUp(context);

      const answer = await post(
        stand,
        withCredential('a credential the stand cannot judge'),
      );

      assert.deepEqual(problemOf(answer), {
        code: 'internalError',
        status: 500,
      });
      assert.deepEqual(stand.lines, [
        {
          fields: { error: 'TypeError', route: EXCHANGE_PATH },
          message: EXCHANGE_UNEXPECTED_FAILURE,
        },
      ]);
      assert.deepEqual(stand.transactions, []);
    });
  });
});
