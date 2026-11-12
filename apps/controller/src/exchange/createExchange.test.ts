import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Readable, Writable } from 'node:stream';
import { suite, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { CONTROLLER_EXCHANGE_DEADLINE_MILLISECONDS } from '@overture-stack/usher-types';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { compactDecrypt, decodeProtectedHeader } from 'jose';
import pg from 'pg';

import { applicationSubkeys } from '../applicationKeyRing/index.js';
import {
  type ChannelAssertionCheck,
  createAssertionRefusals,
  createRefusedAssertions,
} from '../channelAssertion/index.js';
import {
  type Actor,
  type AuditEvent,
  type AuditTransaction,
  createAuditTrail,
  createEventLog,
  type LineFields,
  type TransactionOptions,
} from '../eventLog/index.js';
import { createServer } from '../http/index.js';
import type { SignInJudgement } from '../signInTokens/index.js';
import {
  COMMIT_WINDOW_MILLISECONDS,
  CommitUnconfirmed,
  type Deadline,
} from '../storeTimeout/index.js';
import type { ServedResource } from '../tokenCalculation/index.js';
import {
  createExchange,
  EXCHANGE_PATH,
  EXCHANGE_REQUEST_TIMEOUT,
  EXCHANGE_STORE_FAILED,
  EXCHANGE_UNEXPECTED_FAILURE,
  LATE_REQUEST_THRESHOLD_MILLISECONDS,
  MINIMUM_JUDGEMENT_BUDGET_MILLISECONDS,
  RECORDING_RESERVE_MILLISECONDS,
} from './createExchange.js';
import type { CredentialJudge, ExchangeKey } from './types.js';

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0, 750);

// Long enough for an answer given from memory, and far shorter than any wait on the store.
const ANSWER_WITHIN_MS = 1000;

// How far past the moment it is due an answer may come, for the timers and the event loop to run.
const SCHEDULING_SLACK_MS = 200;

const SECONDS = Math.floor(NOW / 1000);

const APPLICATION = '0d4c7e2a-8b1f-4a63-9e05-3f7a2c9d1b68';

const KEY_SUBKEYS = applicationSubkeys(randomBytes(32));

const KEY: ExchangeKey = {
  applicationId: APPLICATION,
  keyId: '6a1e9c3b-2f4d-4b8a-9c7e-1d5f3a8b2e90',
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
      signingInputDigest: 'digest-of-the-expired-assertion',
    },
    'Bearer assertion-for-another-audience': {
      applicationId: APPLICATION,
      kind: 'refused',
      reason: 'otherAudience',
      signingInputDigest: 'digest-of-the-assertion-for-another-audience',
    },
    'Bearer assertion-of-a-keyless-application': {
      applicationId: APPLICATION,
      kind: 'unverified',
      reason: 'noLiveKey',
    },
    'Bearer assertion-verified': {
      assertion: {
        acceptedUntil: NOW + 60_000,
        id: 'jti-1',
        key: KEY,
        signingInputDigest: 'digest-of-the-verified-assertion',
      },
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

/** One transaction the stand ran: its actor, its options, its statements, and the events recorded in it. */
interface Transaction {
  actor: Actor;
  options: TransactionOptions | undefined;
  recorded: AuditEvent[];
  statements: Statement[];
}

interface Stand {
  /** Each key the exchange asked to confirm, as its confirmation settled. */
  confirmed: { applicationId: string; keyId: string }[];

  /** The deadline given with each key's confirmation, as it was asked for. */
  confirmationDeadlines: (Deadline | undefined)[];

  counted: { applicationId: string | undefined; reason: string }[];
  judged: { audience: string; credential: string; now: number }[];

  /** The lines written at error. */
  lines: Line[];

  /** The events recorded outside any transaction, each with its actor. */
  outside: { actor: Actor; event: AuditEvent }[];

  server: FastifyInstance;
  stop(): Promise<void>;

  /** Every transaction begun, whether or not it committed. */
  transactions: Transaction[];

  /** The lines written at warning. */
  warnings: Line[];
}

interface StandOptions {
  /** What the transaction throws once its work has run, as a store failing at its commit does. */
  commitFailure?: unknown;

  /** Settles when a key's confirmation does: at once by default. */
  confirmationSettled?: Promise<void>;

  /** The exchange's deadline: the controller's own by default. */
  deadlineMilliseconds?: number;

  /**
   * The late-request threshold: the controller's own by default. A test shortening the deadline to
   * reach the store's bound within it names a shorter one, so its request is not answered as late.
   */
  lateRequestThresholdMilliseconds?: number;

  /** Judges each credential in place of the stand's own judgements. */
  judge?: CredentialJudge;

  /** Settles when a refused assertion's recording, outside any exchange's transaction, is written: at once by default. */
  outsideRecorded?: Promise<void>;

  /** What the store's read throws, as a store failing within the transaction does. */
  readFailure?: unknown;
}

const standUp = (
  context: TestContext,
  {
    commitFailure,
    confirmationSettled = Promise.resolve(),
    deadlineMilliseconds = CONTROLLER_EXCHANGE_DEADLINE_MILLISECONDS,
    judge,
    lateRequestThresholdMilliseconds = LATE_REQUEST_THRESHOLD_MILLISECONDS,
    outsideRecorded = Promise.resolve(),
    readFailure,
  }: StandOptions = {},
): Stand => {
  const stand: Omit<Stand, 'server' | 'stop'> = {
    confirmationDeadlines: [],
    confirmed: [],
    counted: [],
    judged: [],
    lines: [],
    outside: [],
    transactions: [],
    warnings: [],
  };
  const server = createServer({
    isLive: () => true,
    isReady: async () => true,
    trustedProxies: [],
  });
  const counter = {
    count: (reason: string, applicationId?: string): void => {
      stand.counted.push({ applicationId, reason });
    },
  };
  // The instance's recorder of refused assertions, writing to a trail of its own, apart from the
  // exchange's transactions.
  const refusals = createAssertionRefusals({
    clock: SETTINGS.clock,
    log: {
      warning: (message, fields) => {
        stand.warnings.push({ fields, message });
      },
    },
    refusedAssertions: createRefusedAssertions(SETTINGS.clock),
    rejections: counter,
  });
  const exchange = createExchange({
    assertionRefusals: refusals.forRoute({
      pendingLimit: 5,
      trail: {
        inTransaction: async (actor, work) =>
          work({
            connection: undefined,
            record: async (event) => {
              await outsideRecorded;
              stand.outside.push({ actor, event });
              return 'event-id';
            },
          }),
      },
    }),
    assertionRejections: counter,
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
    deadlineMilliseconds,
    eventLog: {
      error: (message, fields) => {
        stand.lines.push({ fields, message });
      },
      warning: (message, fields) => {
        stand.warnings.push({ fields, message });
      },
    },
    judgeCredential: async (credential, { audience, now }) => {
      stand.judged.push({ audience, credential, now });
      if (judge !== undefined) {
        return judge(credential, { audience, now });
      }
      const judgement = JUDGEMENTS[credential];
      if (judgement === undefined) {
        throw new TypeError('the stand holds no judgement for the credential');
      }
      return judgement;
    },
    keyConfirmations: {
      confirm: async ({ applicationId, keyId }, deadline) => {
        stand.confirmationDeadlines.push(deadline);
        await confirmationSettled;
        stand.confirmed.push({ applicationId, keyId });
      },
    },
    lateRequestThresholdMilliseconds,
    monotonicNow: () => performance.now(),
    settings: SETTINGS,
    trail: {
      inTransaction: async (actor, work, options) => {
        const transaction: Transaction = {
          actor,
          options,
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
    },
  });
  server.route(exchange.route);
  context.after(async () => {
    await refusals.stop();
    await server.close();
  });
  return { ...stand, server, stop: () => refusals.stop() };
};

interface Sent {
  assertion?: string | null;
  body?: string;
  contentType?: string;
}

const post = (
  { server }: Pick<Stand, 'server'>,
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

/** A stand whose exchange records through the audit trail itself, over a store a test holds back. */
interface StoreStand {
  /** Every line the exchange and its trail wrote, parsed. */
  lines(): readonly Readonly<Record<string, unknown>>[];

  /** Whether each release of the store's connection asked for it to be discarded. */
  releases: (boolean | undefined)[];

  server: FastifyInstance;

  /** Every statement sent to the store, by its text. */
  statements: string[];
}

interface StoreStandOptions {
  deadlineMilliseconds: number;

  /**
   * The late-request threshold: none by default, since these tests shorten the deadline to make the
   * store the step it cuts short, and no request of theirs is late.
   */
  lateRequestThresholdMilliseconds?: number;

  /**
   * How long the store holds back its answer to a statement, in milliseconds, for each statement a
   * test names: `Infinity` for one it never answers, until its connection is discarded.
   */
  holds: (text: string) => number | undefined;

  storeTimeoutMilliseconds: number;
}

// A store whose one connection answers each statement, the policy read included, once the time the
// test holds it for has passed. A discarded connection fails every statement held, and every later
// one without sending it, as the driver's does.
const heldStore = (
  holds: StoreStandOptions['holds'],
): {
  connect(): Promise<pg.PoolClient>;
  releases: (boolean | undefined)[];
  statements: string[];
} => {
  const state: { discarded: boolean; failHeld: (() => void)[] } = {
    discarded: false,
    failHeld: [],
  };
  const releases: (boolean | undefined)[] = [];
  const statements: string[] = [];
  const query = (text: string): Promise<unknown> => {
    if (state.discarded) {
      return Promise.reject(
        new Error('Client was closed and is not queryable'),
      );
    }
    statements.push(text);
    const answered = {
      command: text.split(' ')[0] ?? text,
      rows: [POLICY_ROW],
    };
    const heldFor = holds(text);
    return heldFor === undefined
      ? Promise.resolve(answered)
      : new Promise((resolve, reject) => {
          const timer = Number.isFinite(heldFor)
            ? setTimeout(() => resolve(answered), heldFor)
            : undefined;
          state.failHeld.push(() => {
            clearTimeout(timer);
            reject(new Error('Connection terminated'));
          });
        });
  };
  // A client that never connects, its query answered here.
  const connection: pg.PoolClient = Object.assign(new pg.Client(), {
    query,
    release: (destroy?: boolean | Error) => {
      releases.push(destroy === true ? true : undefined);
      if (destroy === true) {
        state.discarded = true;
        state.failHeld.forEach((fail) => fail());
      }
    },
  });
  return { connect: async () => connection, releases, statements };
};

const storeStandUp = (
  context: TestContext,
  {
    deadlineMilliseconds,
    holds,
    lateRequestThresholdMilliseconds = 0,
    storeTimeoutMilliseconds,
  }: StoreStandOptions,
): StoreStand => {
  const chunks: string[] = [];
  const logStream = new Writable({
    write: (chunk: unknown, _encoding, callback) => {
      chunks.push(String(chunk));
      callback();
    },
  });
  const eventLog = createEventLog({ clock: SETTINGS.clock, logStream });
  const store = heldStore(holds);
  const trail = createAuditTrail<pg.PoolClient>({
    eventLog,
    settings: {
      clock: SETTINGS.clock,
      databaseSchema: SETTINGS.databaseSchema,
      eventSource: 'https://usher.example.org/controller',
      instanceName: 'usher-test-1',
      storeTimeoutMilliseconds,
    },
    store,
  });
  const server = createServer({
    isLive: () => true,
    isReady: async () => true,
    trustedProxies: [],
  });
  const exchange = createExchange({
    assertionRefusals: { refused: () => undefined },
    assertionRejections: { count: () => undefined },
    assertions: {
      verify: async () => ASSERTIONS[VERIFIED] ?? assert.fail(),
    },
    deadlineMilliseconds,
    eventLog,
    judgeCredential: async (credential) =>
      JUDGEMENTS[credential] ?? assert.fail(),
    keyConfirmations: { confirm: async () => undefined },
    lateRequestThresholdMilliseconds,
    monotonicNow: () => performance.now(),
    settings: SETTINGS,
    trail,
  });
  server.route(exchange.route);
  context.after(async () => {
    await server.close();
  });
  return {
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>),
    releases: store.releases,
    server,
    statements: store.statements,
  };
};

interface Timed {
  answer: LightMyRequestResponse;
  elapsedMs: number;
}

const timedPost = async (
  stand: Pick<Stand, 'server'>,
  sent: Sent = {},
): Promise<Timed> => {
  const from = performance.now();
  const answer = await post(stand, sent);
  return { answer, elapsedMs: performance.now() - from };
};

// A verified request whose body arrives whole only the given milliseconds after the request does, as
// a client sending it slowly does.
const postArrivingAfter = (
  { server }: Pick<Stand, 'server'>,
  body: string,
  milliseconds: number,
): Promise<LightMyRequestResponse> => {
  const stream = new Readable({ read: () => undefined });
  stream.push(body);
  setTimeout(() => {
    stream.push(null);
  }, milliseconds);
  return server.inject({
    headers: { authorization: VERIFIED, 'content-type': 'application/json' },
    method: 'POST',
    payload: stream,
    url: EXCHANGE_PATH,
  });
};

const CREDENTIAL_BODY = JSON.stringify({
  credential: 'credential-forged',
  payloadVersions: [1],
});

const ANONYMOUS_BODY = JSON.stringify({ payloadVersions: [1] });

// The audit trail's lines that are events, by their type and data.
const eventLinesIn = (
  lines: readonly Readonly<Record<string, unknown>>[],
): readonly Readonly<Record<string, unknown>>[] =>
  lines.filter(({ specversion }) => specversion === '1.0');

const isInsert = (text: string): boolean => text.startsWith('INSERT');

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

    test('records the first refusal of each assertion that verified and counts its repeats by reason and application, answering every one alike', async (context) => {
      const stand = standUp(context);

      const answers = [
        await post(stand, { assertion: 'Bearer assertion-expired' }),
        await post(stand, { assertion: 'Bearer assertion-expired' }),
        await post(stand, {
          assertion: 'Bearer assertion-for-another-audience',
        }),
      ];
      await stand.stop();

      const [first] = answers;
      answers.forEach((answer) => {
        assert.deepEqual(onTheWire(answer), first && onTheWire(first));
      });
      assert.deepEqual(
        stand.outside.map(({ event }) => event.data['reason']),
        ['expiredAssertion', 'otherAudience'],
      );
      assert.deepEqual(stand.counted, [
        { applicationId: APPLICATION, reason: 'expiredAssertion' },
      ]);
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

  suite("its key's confirmation", () => {
    test('confirms the key the assertion verified under for every exchange it answers: issued, refused for its credential, for its body or for its size, or kept from its store', async (context) => {
      const stand = standUp(context);
      const failing = standUp(context, { readFailure: storeFailure('57P01') });

      const answers = await Promise.all([
        post(stand),
        post(stand, withCredential('credential-expired')),
        post(stand, { body: '[1]' }),
        post(stand, { body: '{"payloadVersions":[2]}' }),
        post(stand, {
          body: JSON.stringify({ padding: 'x'.repeat(65_536) }),
        }),
        post(failing),
      ]);

      assert.deepEqual(
        answers.map(({ statusCode }) => statusCode),
        [200, 403, 400, 406, 413, 503],
      );
      assert.deepEqual(
        [...stand.confirmed, ...failing.confirmed],
        answers.map(() => ({
          applicationId: APPLICATION,
          keyId: KEY.keyId,
        })),
      );
    });

    test('confirms nothing for an exchange refused for its channel assertion', async (context) => {
      const stand = standUp(context);

      await Promise.all([
        post(stand, { assertion: null }),
        post(stand, { assertion: 'Bearer assertion-expired' }),
        post(stand, {
          assertion: 'Bearer assertion-of-a-keyless-application',
        }),
      ]);

      assert.deepEqual(stand.confirmed, []);
    });

    test("waits for the key's confirmation within the deadline, so the key reads as confirmed when the first exchange is answered once the store takes the confirmation in time", async (context) => {
      const confirmation = deferred();
      const stand = standUp(context, {
        confirmationSettled: confirmation.promise,
      });

      const answering = post(stand);
      const answeredFirst = await Promise.race([
        answering.then(() => true),
        delay(ANSWER_WITHIN_MS).then(() => false),
      ]);
      confirmation.release();
      const answer = await answering;

      assert.equal(answeredFirst, false);
      assert.equal(answer.statusCode, 200);
      assert.equal(stand.confirmed.length, 1);
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

  suite('its deadline', () => {
    test("passes the deadline started as the request arrived to its own transaction and to the key's confirmation, one deadline for the whole request", async (context) => {
      const stand = standUp(context);

      await post(stand);
      const [given] = stand.confirmationDeadlines;
      const transactionDeadline = stand.transactions[0]?.options?.deadline;
      const remaining = given?.remainingMilliseconds() ?? -1;

      assert.equal(transactionDeadline, given);
      assert.ok(
        remaining < CONTROLLER_EXCHANGE_DEADLINE_MILLISECONDS &&
          remaining >
            CONTROLLER_EXCHANGE_DEADLINE_MILLISECONDS - ANSWER_WITHIN_MS,
        `${Math.round(remaining)} ms left`,
      );
    });

    test('answers 408 requestTimeout at once, with Connection: close, to a body arriving whole only once the deadline has passed, recording nothing, judging nothing and writing one line at warning naming the route', async (context) => {
      const deadlineMilliseconds = 100;
      const bodyEndsAfterMs = deadlineMilliseconds + 150;
      const stand = standUp(context, { deadlineMilliseconds });
      const body = new Readable({ read: () => undefined });
      body.push(
        JSON.stringify({
          credential: 'credential-forged',
          payloadVersions: [1],
        }),
      );
      setTimeout(() => {
        body.push(null);
      }, bodyEndsAfterMs);

      const from = performance.now();
      const answer = await stand.server.inject({
        headers: {
          authorization: VERIFIED,
          'content-type': 'application/json',
        },
        method: 'POST',
        payload: body,
        url: EXCHANGE_PATH,
      });
      const elapsedMs = performance.now() - from;

      assert.deepEqual(problemOf(answer), {
        code: 'requestTimeout',
        status: 408,
      });
      assert.equal(answer.headers['connection'], 'close');
      assert.equal(answer.headers['cache-control'], 'no-store');
      assert.ok(
        elapsedMs < bodyEndsAfterMs + SCHEDULING_SLACK_MS,
        `answered in ${Math.round(elapsedMs)} ms`,
      );
      assert.deepEqual(stand.transactions, []);
      assert.deepEqual(stand.judged, []);
      assert.deepEqual(stand.lines, []);
      assert.deepEqual(stand.warnings, [
        {
          fields: { route: EXCHANGE_PATH },
          message: EXCHANGE_REQUEST_TIMEOUT,
        },
      ]);
    });

    suite('a body arriving close to the late-request threshold', () => {
      // A deadline leaving the threshold and 300 ms more, so a body arriving 400 ms late finds less than
      // the threshold left, and one arriving 200 ms late finds more.
      const deadlineMilliseconds = LATE_REQUEST_THRESHOLD_MILLISECONDS + 300;

      test('answers a credential whose body arrives with less than the threshold left 408 requestTimeout, judging nothing, recording nothing and writing no line naming the identity provider or the store', async (context) => {
        const stand = standUp(context, { deadlineMilliseconds });

        const answer = await postArrivingAfter(stand, CREDENTIAL_BODY, 400);

        assert.deepEqual(problemOf(answer), {
          code: 'requestTimeout',
          status: 408,
        });
        assert.deepEqual(stand.judged, []);
        assert.deepEqual(stand.transactions, []);
        assert.deepEqual(stand.lines, []);
        assert.deepEqual(
          stand.warnings.map(({ message }) => message),
          [EXCHANGE_REQUEST_TIMEOUT],
        );
      });

      test('answers the anonymous exchange whose body arrives with less than the threshold left 408 requestTimeout, beginning no transaction and writing no line naming the store', async (context) => {
        const stand = standUp(context, { deadlineMilliseconds });

        const answer = await postArrivingAfter(stand, ANONYMOUS_BODY, 400);

        assert.deepEqual(problemOf(answer), {
          code: 'requestTimeout',
          status: 408,
        });
        assert.deepEqual(stand.transactions, []);
        assert.deepEqual(stand.lines, []);
      });

      test('judges and records a credential whose body arrives with more than the threshold left, as any other', async (context) => {
        const stand = standUp(context, { deadlineMilliseconds });

        const answer = await postArrivingAfter(stand, CREDENTIAL_BODY, 200);

        assert.deepEqual(problemOf(answer), {
          code: 'credentialRefused',
          status: 403,
        });
        assert.deepEqual(
          stand.judged.map(({ credential }) => credential),
          ['credential-forged'],
        );
        assert.deepEqual(
          recordedIn(stand).map(({ data }) => [data['result'], data['reason']]),
          [['denied', 'invalidSignature']],
        );
        assert.deepEqual(stand.warnings, []);
      });
    });

    test('answers as late a credential left less than the least judgement budget, whatever threshold the exchange was given, judging and recording nothing', async (context) => {
      const stand = standUp(context, {
        deadlineMilliseconds:
          RECORDING_RESERVE_MILLISECONDS +
          MINIMUM_JUDGEMENT_BUDGET_MILLISECONDS / 2,
        lateRequestThresholdMilliseconds: 0,
      });

      const answer = await post(stand, withCredential('credential-forged'));

      assert.deepEqual(problemOf(answer), {
        code: 'requestTimeout',
        status: 408,
      });
      assert.deepEqual(stand.judged, []);
      assert.deepEqual(stand.transactions, []);
      assert.deepEqual(stand.lines, []);
    });

    test("answers a credential whose judgement is not given by the deadline less the recording reserve 503 identityProviderUnavailable, recorded failed at error, as keys that cannot be had are, within the deadline, and drops the judgement's late failure", async (context) => {
      // The least deadline a credential is judged under, so the judge overruns the least budget.
      const deadlineMilliseconds = LATE_REQUEST_THRESHOLD_MILLISECONDS + 50;
      const budgetMs = deadlineMilliseconds - RECORDING_RESERVE_MILLISECONDS;
      const judging: { fail: (failure: Error) => void } = {
        fail: () => undefined,
      };
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      context.after(() => {
        process.off('unhandledRejection', onUnhandled);
      });
      const stand = standUp(context, {
        deadlineMilliseconds,
        judge: () =>
          new Promise<SignInJudgement>((_resolve, reject) => {
            judging.fail = reject;
          }),
      });

      const { answer, elapsedMs } = await timedPost(
        stand,
        withCredential('credential-forged'),
      );
      judging.fail(
        new Error('the shared fetch failed once the exchange was answered'),
      );
      await delay(10);

      assert.deepEqual(problemOf(answer), {
        code: 'identityProviderUnavailable',
        status: 503,
      });
      assert.ok(
        elapsedMs >= budgetMs - 1 && elapsedMs < budgetMs + SCHEDULING_SLACK_MS,
        `answered in ${Math.round(elapsedMs)} ms`,
      );
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
      assert.deepEqual(unhandled, []);
      assert.deepEqual(stand.lines, []);
    });

    test("leaves a fetch of the identity provider's keys shared by every request running past one request's deadline, so it still serves a later request", async (context) => {
      const keysArrive = deferred();
      const shared: {
        fetches: number;
        inFlight: Promise<SignInJudgement> | undefined;
      } = { fetches: 0, inFlight: undefined };
      // The least deadline a credential is judged under, so the judgement is given the least budget.
      const stand = standUp(context, {
        deadlineMilliseconds: LATE_REQUEST_THRESHOLD_MILLISECONDS + 50,
        judge: () => {
          shared.inFlight ??= (() => {
            shared.fetches += 1;
            return keysArrive.promise.then((): SignInJudgement => ({
              kind: 'recorded',
              reason: 'invalidSignature',
            }));
          })();
          return shared.inFlight;
        },
      });

      const first = await post(stand, withCredential('credential-forged'));
      keysArrive.release();
      await shared.inFlight;
      const later = await post(stand, withCredential('credential-forged'));

      assert.deepEqual(problemOf(first), {
        code: 'identityProviderUnavailable',
        status: 503,
      });
      assert.deepEqual(problemOf(later), {
        code: 'credentialRefused',
        status: 403,
      });
      assert.equal(shared.fetches, 1);
      assert.deepEqual(
        recordedIn(stand).map(({ data }) => data['reason']),
        ['identityProviderUnavailable', 'invalidSignature'],
      );
    });

    test("answers at the deadline while the key's confirmation is still pending, issuing the token, and leaves the confirmation to settle on its own", async (context) => {
      const deadlineMilliseconds = 300;
      const confirmation = deferred();
      const stand = standUp(context, {
        confirmationSettled: confirmation.promise,
        deadlineMilliseconds,
        lateRequestThresholdMilliseconds: 0,
      });

      const { answer, elapsedMs } = await timedPost(stand);
      const confirmedAtAnswer = stand.confirmed.length;
      confirmation.release();
      await delay(0);

      assert.equal(answer.statusCode, 200);
      assert.ok(
        elapsedMs >= deadlineMilliseconds - 1 &&
          elapsedMs < deadlineMilliseconds + SCHEDULING_SLACK_MS,
        `answered in ${Math.round(elapsedMs)} ms`,
      );
      assert.equal(confirmedAtAnswer, 0);
      assert.equal(stand.confirmed.length, 1);
    });

    test("answers 503 storeUnavailable within the deadline, recording nothing and discarding the connection, when the store does not answer the anonymous exchange's transaction by then, though the store timeout is longer", async (context) => {
      const deadlineMilliseconds = 300;
      const stand = storeStandUp(context, {
        deadlineMilliseconds,
        holds: (text) => (text === 'BEGIN' ? Infinity : undefined),
        storeTimeoutMilliseconds: 5000,
      });

      const { answer, elapsedMs } = await timedPost(stand);

      assert.deepEqual(problemOf(answer), {
        code: 'storeUnavailable',
        status: 503,
      });
      assert.ok(
        elapsedMs < deadlineMilliseconds + SCHEDULING_SLACK_MS,
        `answered in ${Math.round(elapsedMs)} ms`,
      );
      assert.deepEqual(stand.releases, [true]);
      assert.deepEqual(eventLinesIn(stand.lines()), []);
      assert.deepEqual(
        stand.lines().map(({ code, message }) => ({ code, message })),
        [{ code: 'storeTimeout', message: EXCHANGE_STORE_FAILED }],
      );
    });

    test('answers 503 storeUnavailable when less than the commit window is left to the deadline as the transaction ends, sending no COMMIT, destroying the connection and recording nothing', async (context) => {
      const deadlineMilliseconds = 400;
      const stand = storeStandUp(context, {
        deadlineMilliseconds,
        holds: (text) =>
          isInsert(text)
            ? deadlineMilliseconds - COMMIT_WINDOW_MILLISECONDS / 2 - 10
            : undefined,
        storeTimeoutMilliseconds: 5000,
      });

      const { answer, elapsedMs } = await timedPost(stand);

      assert.deepEqual(problemOf(answer), {
        code: 'storeUnavailable',
        status: 503,
      });
      assert.ok(
        elapsedMs < deadlineMilliseconds + SCHEDULING_SLACK_MS,
        `answered in ${Math.round(elapsedMs)} ms`,
      );
      assert.equal(stand.statements.includes('COMMIT'), false);
      assert.deepEqual(stand.releases, [true]);
      assert.deepEqual(eventLinesIn(stand.lines()), []);
    });

    test("answers 503 outcomeUnknown within the deadline when the store does not answer the COMMIT by then, the trail's line naming the token.exchange it recorded", async (context) => {
      const deadlineMilliseconds = 300;
      const stand = storeStandUp(context, {
        deadlineMilliseconds,
        holds: (text) => (text === 'COMMIT' ? Infinity : undefined),
        storeTimeoutMilliseconds: 5000,
      });

      const { answer, elapsedMs } = await timedPost(stand);
      const [line, ...more] = stand.lines();

      assert.deepEqual(problemOf(answer), {
        code: 'outcomeUnknown',
        status: 503,
      });
      assert.ok(
        elapsedMs < deadlineMilliseconds + SCHEDULING_SLACK_MS,
        `answered in ${Math.round(elapsedMs)} ms`,
      );
      assert.deepEqual(more, []);
      assert.equal(line?.['message'], 'audit.commitUnconfirmed');
      assert.match(
        JSON.stringify(line?.['events']),
        /^\[\{"id":"[0-9a-f-]{36}","type":"bio\.overture\.token\.exchange"\}\]$/u,
      );
      assert.deepEqual(stand.releases, [true]);
    });

    test('gives the COMMIT one more store timeout where the deadline is further, answering 503 outcomeUnknown within the store timeout rather than at the deadline', async (context) => {
      const storeTimeoutMilliseconds = 250;
      const stand = storeStandUp(context, {
        deadlineMilliseconds: CONTROLLER_EXCHANGE_DEADLINE_MILLISECONDS,
        holds: (text) => (text === 'COMMIT' ? Infinity : undefined),
        storeTimeoutMilliseconds,
      });

      const { answer, elapsedMs } = await timedPost(stand);

      assert.deepEqual(problemOf(answer), {
        code: 'outcomeUnknown',
        status: 503,
      });
      assert.ok(
        elapsedMs >= storeTimeoutMilliseconds - 1 &&
          elapsedMs < storeTimeoutMilliseconds + SCHEDULING_SLACK_MS,
        `answered in ${Math.round(elapsedMs)} ms`,
      );
    });

    test("answers a refused credential 503 storeUnavailable within the deadline, recording nothing, when the store does not take its refusal's recording by then", async (context) => {
      // The least deadline a credential is judged under: judged at once, its recording is left the
      // reserve and a little more, which the store never answers.
      const deadlineMilliseconds = LATE_REQUEST_THRESHOLD_MILLISECONDS + 50;
      const stand = storeStandUp(context, {
        deadlineMilliseconds,
        holds: (text) => (isInsert(text) ? Infinity : undefined),
        lateRequestThresholdMilliseconds: LATE_REQUEST_THRESHOLD_MILLISECONDS,
        storeTimeoutMilliseconds: 5000,
      });

      const { answer, elapsedMs } = await timedPost(
        stand,
        withCredential('credential-forged'),
      );

      assert.deepEqual(problemOf(answer), {
        code: 'storeUnavailable',
        status: 503,
      });
      assert.ok(
        elapsedMs < deadlineMilliseconds + SCHEDULING_SLACK_MS,
        `answered in ${Math.round(elapsedMs)} ms`,
      );
      assert.equal(stand.statements.includes('COMMIT'), false);
      assert.deepEqual(eventLinesIn(stand.lines()), []);
    });

    test('issues as before through the trail when the store answers in time, recording one succeeded token.exchange', async (context) => {
      const stand = storeStandUp(context, {
        deadlineMilliseconds: 300,
        holds: () => undefined,
        storeTimeoutMilliseconds: 5000,
      });

      const answer = await post(stand);

      assert.equal(answer.statusCode, 200);
      assert.deepEqual(
        eventLinesIn(stand.lines()).map(({ data, type }) => ({
          result: (data as Readonly<Record<string, unknown>>)['result'],
          type,
        })),
        [{ result: 'succeeded', type: 'bio.overture.token.exchange' }],
      );
      assert.deepEqual(stand.releases, [undefined]);
    });
  });
});
