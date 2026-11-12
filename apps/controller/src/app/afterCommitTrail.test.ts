import assert from 'node:assert/strict';
import { suite, test, type TestContext } from 'node:test';

import type {
  Actor,
  AuditEvent,
  AuditTrail,
  AuditTransaction,
  TransactionOptions,
} from '../eventLog/index.js';
import { createServer } from '../http/index.js';
import { managementRoute } from '../managementApi/index.js';
import { CommitUnconfirmed } from '../storeTimeout/index.js';
import {
  AFTER_COMMIT_FAILED,
  afterCommitTrail,
  runAfterCommit,
} from './afterCommitTrail.js';
import type { AfterCommitLog } from './types.js';

const ACTOR: Actor = { id: 'subject-ana', type: 'human' };

interface Line {
  fields: unknown;
  message: string;
}

// A trail committing every transaction as the test rules, keeping the options each was given and
// what happened in which order.
const fakeTrail = (
  outcome: 'commits' | Error = 'commits',
): {
  given: (TransactionOptions | undefined)[];
  happened: string[];
  trail: AuditTrail<string>;
} => {
  const given: (TransactionOptions | undefined)[] = [];
  const happened: string[] = [];
  return {
    given,
    happened,
    trail: {
      inTransaction: async <Result>(
        _actor: Actor,
        work: (transaction: AuditTransaction<string>) => Promise<Result>,
        options?: TransactionOptions,
      ): Promise<Result> => {
        given.push(options);
        const result = await work({
          connection: 'connection',
          record: async () => 'event-id',
        });
        if (outcome instanceof Error) {
          throw outcome;
        }
        happened.push('committed');
        return result;
      },
      recordEvent: async (_actor: Actor, event: AuditEvent) => {
        happened.push(`recorded ${event.type}`);
        return 'event-id';
      },
    },
  };
};

const collectingLog = (): {
  error: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  lines: Line[];
} => {
  const lines: Line[] = [];
  return {
    error: (message, fields) => {
      lines.push({ fields, message });
    },
    lines,
  };
};

suite('a trail running steps after each commit', () => {
  test("gives the trail each transaction's options as given, and none where none are given", async () => {
    const { given, trail } = fakeTrail();
    const wrapped = afterCommitTrail({
      log: collectingLog(),
      steps: [],
      trail,
    });

    await wrapped.inTransaction(ACTOR, async () => 'made', {
      timeoutMilliseconds: 30_000,
    });
    await wrapped.inTransaction(ACTOR, async () => 'made');

    assert.deepEqual(given, [{ timeoutMilliseconds: 30_000 }, undefined]);
  });

  test("runs every step in turn once the change has committed, and gives back the work's result after the last", async () => {
    const { happened, trail } = fakeTrail();
    const wrapped = afterCommitTrail({
      log: collectingLog(),
      steps: [
        {
          name: 'first',
          run: () => {
            happened.push('first');
          },
        },
        {
          name: 'second',
          run: async () => {
            await new Promise((resolve) => {
              setImmediate(resolve);
            });
            happened.push('second');
          },
        },
      ],
      trail,
    });

    const result = await wrapped.inTransaction(ACTOR, async () => 'made');
    happened.push('answered');

    assert.equal(result, 'made');
    assert.deepEqual(happened, ['committed', 'first', 'second', 'answered']);
  });

  test("gives back a committed change's result when a step throws or rejects, writing each failure by its code and step alone, and runs the steps after it", async () => {
    const { happened, trail } = fakeTrail();
    const log = collectingLog();
    const wrapped = afterCommitTrail({
      log,
      steps: [
        {
          name: 'wake',
          run: () => {
            throw new TypeError('a message quoting subject-ana');
          },
        },
        {
          name: 'keyRing',
          run: () =>
            Promise.reject(
              Object.assign(new Error('the store said: secret value'), {
                code: 'storeTimeout',
              }),
            ),
        },
        {
          name: 'last',
          run: () => {
            happened.push('last');
          },
        },
      ],
      trail,
    });

    const result = await wrapped.inTransaction(ACTOR, async () => 'made');

    assert.equal(result, 'made');
    assert.deepEqual(happened, ['committed', 'last']);
    assert.deepEqual(log.lines, [
      { fields: { step: 'wake' }, message: AFTER_COMMIT_FAILED },
      {
        fields: { code: 'storeTimeout', step: 'keyRing' },
        message: AFTER_COMMIT_FAILED,
      },
    ]);
  });

  test('runs no step for a transaction that fails, throwing its failure as the trail threw it', async () => {
    const timedOut = Object.assign(new Error('the store did not answer'), {
      code: 'storeTimeout',
    });
    const { trail } = fakeTrail(timedOut);
    const ran: string[] = [];
    const wrapped = afterCommitTrail({
      log: collectingLog(),
      steps: [
        {
          name: 'step',
          run: () => {
            ran.push('step');
          },
        },
      ],
      trail,
    });

    await assert.rejects(
      wrapped.inTransaction(ACTOR, async () => 'made'),
      (thrown) => thrown === timedOut,
    );
    assert.deepEqual(ran, []);
  });

  test("runs every step in turn for a transaction whose COMMIT went unconfirmed, then throws its failure as the trail threw it, a step's failure written as for a commit", async () => {
    const unconfirmed = new CommitUnconfirmed();
    const { trail } = fakeTrail(unconfirmed);
    const log = collectingLog();
    const ran: string[] = [];
    const wrapped = afterCommitTrail({
      log,
      steps: [
        {
          name: 'noticeWake',
          run: () => {
            throw new Error('the wake failed');
          },
        },
        {
          name: 'last',
          run: () => {
            ran.push('last');
          },
        },
      ],
      trail,
    });

    await assert.rejects(
      wrapped.inTransaction(ACTOR, async () => 'made'),
      (thrown) => thrown === unconfirmed,
    );
    assert.deepEqual(ran, ['last']);
    assert.deepEqual(log.lines, [
      { fields: { step: 'noticeWake' }, message: AFTER_COMMIT_FAILED },
    ]);
  });

  test('records an event accompanying no change as the trail records it, running no step', async () => {
    const { happened, trail } = fakeTrail();
    const ran: string[] = [];
    const wrapped = afterCommitTrail({
      log: collectingLog(),
      steps: [
        {
          name: 'step',
          run: () => {
            ran.push('step');
          },
        },
      ],
      trail,
    });

    await wrapped.recordEvent(ACTOR, {
      data: {},
      severity: 'warning',
      type: 'channelAssertion.rejection',
    });

    assert.deepEqual(happened, ['recorded channelAssertion.rejection']);
    assert.deepEqual(ran, []);
  });
});

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

const ISSUER = 'https://auth.example.org/realms/usher';

// A Management API route whose one operation makes its change through the trail given, names the
// key reload to run after its commit, and answers 201 once the trail gives back the change's result;
// the token verifier is a stand-in accepting the one token it is shown, and the key reload rejects.
const routeThrough = (
  context: TestContext,
  trail: AuditTrail<string>,
  log: AfterCommitLog,
): ReturnType<typeof createServer> => {
  const server = createServer({
    isLive: () => true,
    isReady: async () => true,
    trustedProxies: [],
  });
  server.route(
    managementRoute(
      {
        administratorOnly: false,
        afterCommit: ['keyReload'],
        body: 'none',
        method: 'POST',
        readInput: () => ({ input: {}, kind: 'read' }),
        route: '/admin/shelves',
        run: async ({ principal }) => {
          const made = await trail.inTransaction(
            { id: principal.subject, type: principal.type },
            async () => 'shelved',
          );
          return {
            body: { made },
            forbidsStoring: false,
            kind: 'answered',
            status: 201,
          };
        },
      },
      {
        eventLog: { error: () => undefined },
        refusalTally: { count: () => undefined },
        runAfterCommit: (names) =>
          runAfterCommit({
            log,
            steps: names.map((name) => ({
              name,
              run: () => Promise.reject(new Error('the reload failed')),
            })),
          }),
        settings: {
          administratorRole: 'usher-platform-admin',
          clock: { now: () => NOW },
          identityProviderIssuer: ISSUER,
          managementAudience: 'usher-management',
          managementClients: ['usher-ui'],
        },
        storedRefusal: async () => undefined,
        tokenVerifier: {
          verify: async () => ({
            claims: {
              aud: ['usher-management'],
              azp: 'usher-ui',
              exp: NOW / 1000 + 300,
              iat: NOW / 1000 - 10,
              iss: ISSUER,
              sub: 'subject-ana',
              typ: 'Bearer',
            },
            header: { alg: 'RS256', typ: 'JWT' },
            kind: 'verified',
          }),
        },
        trail,
      },
    ),
  );
  context.after(() => server.close());
  return server;
};

suite('a change committed through the trail, answered by its route', () => {
  test("answers its success when every step after its commit fails, the trail's and those the operation names alike", async (context) => {
    const { happened, trail } = fakeTrail();
    const log = collectingLog();
    const server = routeThrough(
      context,
      afterCommitTrail({
        log,
        steps: [
          {
            name: 'noticeWake',
            run: () => {
              throw new Error('the wake failed');
            },
          },
        ],
        trail,
      }),
      log,
    );

    const answer = await server.inject({
      headers: { authorization: 'Bearer accepted-by-the-stand-in' },
      method: 'POST',
      url: '/admin/shelves',
    });

    assert.equal(answer.statusCode, 201);
    assert.deepEqual(JSON.parse(answer.body), { made: 'shelved' });
    assert.deepEqual(happened, ['committed']);
    assert.deepEqual(
      log.lines.map(({ fields }) => fields),
      [{ step: 'noticeWake' }, { step: 'keyReload' }],
    );
  });
});
