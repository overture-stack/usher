import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { suite, test } from 'node:test';

import type { Clock } from '../configuration/index.js';
import {
  COMMIT_WINDOW_MILLISECONDS,
  CommitUnconfirmed,
  type Deadline,
  StoreTimeout,
} from '../storeTimeout/index.js';
import { createAuditTrail } from './createAuditTrail.js';
import { createEventLog } from './createEventLog.js';
import type {
  Actor,
  AuditEvent,
  AuditTrail,
  AuditTransaction,
  EventLog,
  TrailConnection,
} from './types.js';

const NOW = Date.UTC(2026, 10, 4, 12, 30, 5, 120);

const FIXED_CLOCK: Clock = Object.freeze({ now: () => NOW });

const STORE_TIMEOUT_MILLISECONDS = 250;

const SETTINGS = Object.freeze({
  clock: FIXED_CLOCK,
  databaseSchema: 'usher',
  eventSource: 'https://usher.example.org/controller',
  instanceName: 'usher-test-1',
  storeTimeoutMilliseconds: STORE_TIMEOUT_MILLISECONDS,
});

const ANA: Actor = Object.freeze({ id: 'subject-ana', type: 'human' });

const SYSTEM: Actor = Object.freeze({ type: 'system' });

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const ROW_INSERT = /^INSERT INTO "usher"\.audit_log /u;

// Each statement as the trail sends it, in full: an event's row, the declaration of the actor alone,
// and the declaration setting both of the store's limits beside it.
const ROW_INSERT_TEXT =
  'INSERT INTO "usher".audit_log (id, spec_version, source, type, occurred_at, data_schema, data, severity) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)';

const ACTOR_DECLARATION =
  "SELECT set_config('usher.actor_type', $1, true), set_config('usher.actor_id', $2, true)";

const ACTOR_AND_LIMITS_DECLARATION = `${ACTOR_DECLARATION}, set_config('statement_timeout', $3, true), set_config('idle_in_transaction_session_timeout', $3, true)`;

const GRANT_CREATION: AuditEvent = Object.freeze({
  data: {
    category: 'global.controlled',
    grantId: '4f1b8e2a-6c3d-4e5f-8a9b-0c1d2e3f4a5b',
    result: 'succeeded',
  },
  severity: 'info',
  type: 'grant.creation',
});

interface Statement {
  text: string;
  values: readonly unknown[] | undefined;
}

interface FakeStore {
  connect(): Promise<TrailConnection>;
  connections: number;

  /** Whether each release asked for the connection to be discarded. */
  releases: (boolean | undefined)[];

  statements: Statement[];
}

// A store whose one connection records every statement, fails each one a test names, and answers
// each other with its command, or with the one a test gives.
const fakeStore = (
  failing: (text: string) => boolean = () => false,
  answering: (text: string) => string = (text) => text.split(' ')[0] ?? text,
): FakeStore => {
  const store: FakeStore = {
    connect: async () => {
      store.connections += 1;
      return connection;
    },
    connections: 0,
    releases: [],
    statements: [],
  };
  const connection: TrailConnection = {
    query: async (text, values) => {
      store.statements.push({ text, values });
      if (failing(text)) {
        throw new Error(`the store refused ${text.split(' ')[0] ?? text}`);
      }
      return { command: answering(text) };
    },
    release: (destroy) => {
      store.releases.push(destroy);
    },
  };
  return store;
};

interface StallingStore extends FakeStore {
  /** Answers every statement left unanswered so far, as the store would have. */
  answerStalled(): void;
}

// A store whose connection leaves each statement a test names unanswered, as a store that stopped
// answering does, until the test answers it or the connection is discarded, which fails it. A
// discarded connection fails every statement after without sending it, as the driver's does.
const stallingStore = (stalls: (text: string) => boolean): StallingStore => {
  const held: {
    discarded: boolean;
    stalled: { answer: () => void; fail: () => void }[];
  } = { discarded: false, stalled: [] };
  const store: StallingStore = {
    answerStalled: () => {
      const { stalled } = held;
      held.stalled = [];
      stalled.forEach(({ answer }) => answer());
    },
    connect: async () => {
      store.connections += 1;
      return connection;
    },
    connections: 0,
    releases: [],
    statements: [],
  };
  const connection: TrailConnection = {
    query: (text, values) => {
      if (held.discarded) {
        return Promise.reject(
          new Error('Client was closed and is not queryable'),
        );
      }
      store.statements.push({ text, values });
      const command = text.split(' ')[0] ?? text;
      return stalls(text)
        ? new Promise((resolve, reject) => {
            held.stalled.push({
              answer: () => resolve({ command }),
              fail: () => reject(new Error('Connection terminated')),
            });
          })
        : Promise.resolve({ command });
    },
    release: (destroy) => {
      store.releases.push(destroy);
      if (destroy === true) {
        held.discarded = true;
        held.stalled.forEach(({ fail }) => fail());
      }
    },
  };
  return store;
};

interface Capture {
  parsed(): readonly Readonly<Record<string, unknown>>[];
  stream: Writable;
}

const capture = (): Capture => {
  const chunks: string[] = [];
  const stream = new Writable({
    write: (chunk: unknown, _encoding, callback) => {
      chunks.push(String(chunk));
      callback();
    },
  });
  return {
    parsed: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>),
    stream,
  };
};

interface Trail {
  eventLog: EventLog;
  lines: Capture['parsed'];
  store: FakeStore;
  trail: AuditTrail<TrailConnection>;
}

const trailOver = (store: FakeStore = fakeStore()): Trail => {
  const { parsed, stream } = capture();
  const eventLog = createEventLog({ clock: FIXED_CLOCK, logStream: stream });
  return {
    eventLog,
    lines: parsed,
    store,
    trail: createAuditTrail({ eventLog, settings: SETTINGS, store }),
  };
};

const rowInserts = (statements: readonly Statement[]): readonly Statement[] =>
  statements.filter(({ text }) => ROW_INSERT.test(text));

const declarationsIn = (
  statements: readonly Statement[],
): readonly Statement[] =>
  statements.filter(({ text }) => text.includes('set_config'));

const dataOf = (
  line: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> =>
  (line?.['data'] ?? {}) as Readonly<Record<string, unknown>>;

const settled = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

suite('the audit trail', () => {
  test("declares the transaction's actor before anything else in it, then runs the work's statements, and commits", async () => {
    const { store, trail } = trailOver();

    const result = await trail.inTransaction(ANA, async ({ connection }) => {
      await connection.query('UPDATE grants SET revoked_at = now()');
      return 'changed';
    });

    assert.equal(result, 'changed');
    assert.deepEqual(
      store.statements.map(({ text, values }) => [text.split(' ')[0], values]),
      [
        ['BEGIN', undefined],
        ['SELECT', ['human', 'subject-ana']],
        ['UPDATE', undefined],
        ['COMMIT', undefined],
      ],
    );
    assert.match(
      store.statements[1]?.text ?? '',
      /set_config\('usher\.actor_type', \$1, true\), set_config\('usher\.actor_id', \$2, true\)/u,
    );
    assert.deepEqual(store.releases, [undefined]);
  });

  test("sends a transaction naming no failure event as a plain BEGIN, the statement declaring its actor, the work's statements and COMMIT, each a query of its own", async () => {
    const { store, trail } = trailOver();

    await trail.inTransaction(ANA, async ({ connection, record }) => {
      await connection.query('UPDATE grants SET revoked_at = now()');
      await record(GRANT_CREATION);
    });

    assert.deepEqual(
      store.statements.map(({ text }) => text),
      [
        'BEGIN',
        ACTOR_DECLARATION,
        'UPDATE grants SET revoked_at = now()',
        ROW_INSERT_TEXT,
        'COMMIT',
      ],
    );
    assert.deepEqual(
      store.statements
        .filter(({ text }) => !ROW_INSERT.test(text))
        .map(({ values }) => values),
      [undefined, ['human', 'subject-ana'], undefined, undefined],
    );
  });

  test('declares an actor who is nobody with an empty subject', async () => {
    const { store, trail } = trailOver();

    await trail.inTransaction({ type: 'anonymous' }, async () => undefined);
    await trail.inTransaction(SYSTEM, async () => undefined);

    assert.deepEqual(
      store.statements
        .filter(({ text }) => text.includes('set_config'))
        .map(({ values }) => values),
      [
        ['anonymous', ''],
        ['system', ''],
      ],
    );
  });

  test("writes an event's row in the transaction and its line once committed, the two carrying the same envelope", async () => {
    const { lines, store, trail } = trailOver();

    await trail.inTransaction(ANA, async ({ record }) => {
      await record(GRANT_CREATION);
    });
    const [insert, ...otherInserts] = rowInserts(store.statements);
    const [line, ...otherLines] = lines();

    assert.equal(otherInserts.length, 0);
    assert.equal(otherLines.length, 0);
    assert.ok(insert);
    assert.ok(line);
    assert.match(
      insert.text,
      /\(id, spec_version, source, type, occurred_at, data_schema, data, severity\)/u,
    );
    const [
      id,
      specversion,
      source,
      type,
      occurredAt,
      dataschema,
      data,
      severity,
    ] = insert.values ?? [];
    assert.match(String(id), UUID);
    assert.deepEqual(
      {
        data: JSON.parse(String(data)) as unknown,
        dataschema,
        id,
        severity,
        source,
        specversion,
        time: occurredAt,
        type,
      },
      {
        data: line['data'],
        dataschema: null,
        id: line['id'],
        severity: line['severity'],
        source: line['source'],
        specversion: line['specversion'],
        time: line['time'],
        type: line['type'],
      },
    );
    assert.deepEqual(
      {
        severity: line['severity'],
        source: line['source'],
        specversion: line['specversion'],
        time: line['time'],
        type: line['type'],
      },
      {
        severity: 'info',
        source: 'https://usher.example.org/controller',
        specversion: '1.0',
        time: '2026-11-04T12:30:05.120Z',
        type: 'bio.overture.grant.creation',
      },
    );
    assert.equal(Object.hasOwn(line, 'dataschema'), false);
    assert.equal(line['level'], 30);
  });

  test('names the actor and the instance in every event, over any member of the same name its data gives', async () => {
    const { lines, trail } = trailOver();

    await trail.inTransaction(ANA, async ({ record }) => {
      await record({
        ...GRANT_CREATION,
        data: {
          ...GRANT_CREATION.data,
          actorId: 'subject-claimed',
          actorType: 'system',
          instance: 'usher-elsewhere',
        },
      });
    });

    assert.deepEqual(dataOf(lines()[0]), {
      ...GRANT_CREATION.data,
      actorId: 'subject-ana',
      actorType: 'human',
      instance: 'usher-test-1',
    });
  });

  test('names an anonymous or system actor by a present and null actorId', async () => {
    const { lines, trail } = trailOver();

    await trail.inTransaction({ type: 'anonymous' }, async ({ record }) => {
      await record({
        data: { result: 'denied' },
        severity: 'warning',
        type: 'token.exchange',
      });
    });
    await trail.inTransaction(SYSTEM, async ({ record }) => {
      await record({
        data: { count: 3, reason: 'invalidSignature' },
        severity: 'warning',
        type: 'managementToken.refusalTally',
      });
    });

    assert.deepEqual(
      lines().map((line) => {
        const data = dataOf(line);
        return [
          Object.hasOwn(data, 'actorId'),
          data['actorId'],
          data['actorType'],
        ];
      }),
      [
        [true, null, 'anonymous'],
        [true, null, 'system'],
      ],
    );
  });

  test("names an event's own actor where it gives one, the transaction still declared under its own", async () => {
    const { lines, store, trail } = trailOver();

    await trail.inTransaction(ANA, async ({ record }) => {
      await record({
        actor: SYSTEM,
        data: { applicationId: 'a3c1', keyId: 'k7' },
        severity: 'info',
        type: 'applicationKey.confirmation',
      });
      await record({
        data: { result: 'succeeded' },
        severity: 'info',
        type: 'token.exchange',
      });
    });

    assert.deepEqual(
      lines().map((line) => [
        dataOf(line)['actorType'],
        dataOf(line)['actorId'],
      ]),
      [
        ['system', null],
        ['human', 'subject-ana'],
      ],
    );
    assert.deepEqual(
      store.statements.find(({ text }) => text.includes('set_config'))?.values,
      ['human', 'subject-ana'],
    );
  });

  test('gives each event an id of its own, which a later event in the transaction can name', async () => {
    const { lines, trail } = trailOver();

    const ids = await trail.inTransaction(ANA, async ({ record }) => {
      const retirement = await record({
        data: { grantCount: 1, resourceId: 'STUDY-A1', result: 'succeeded' },
        severity: 'info',
        type: 'resource.retirement',
      });
      const revocation = await record({
        data: { causedBy: retirement, reason: 'resourceRetired' },
        severity: 'info',
        type: 'grant.revocation',
      });
      return [retirement, revocation];
    });

    assert.equal(new Set(ids).size, 2);
    ids.forEach((id) => {
      assert.match(id, UUID);
    });
    assert.deepEqual(
      lines().map((line) => line['id']),
      ids,
    );
    assert.equal(dataOf(lines()[1])['causedBy'], ids[0]);
  });

  test('writes no line before the transaction commits, and then each in the order recorded', async () => {
    const linesAtCommit: number[] = [];
    const recording = trailOver(
      fakeStore((text) => {
        if (text === 'COMMIT') {
          linesAtCommit.push(recording.lines().length);
        }
        return false;
      }),
    );

    await recording.trail.inTransaction(ANA, async ({ record }) => {
      await record(GRANT_CREATION);
      await record({ ...GRANT_CREATION, type: 'grant.decision' });
    });

    assert.deepEqual(linesAtCommit, [0]);
    assert.deepEqual(
      recording.lines().map((line) => line['type']),
      ['bio.overture.grant.creation', 'bio.overture.grant.decision'],
    );
  });

  test('rolls back and writes no line when the work fails after recording, throwing its failure', async () => {
    const { lines, store, trail } = trailOver();
    const failure = new Error('the change was refused');

    await assert.rejects(
      trail.inTransaction(ANA, async ({ record }) => {
        await record(GRANT_CREATION);
        throw failure;
      }),
      (thrown) => thrown === failure,
    );

    assert.equal(store.statements.at(-1)?.text, 'ROLLBACK');
    assert.equal(
      store.statements.some(({ text }) => text === 'COMMIT'),
      false,
    );
    assert.deepEqual(lines(), []);
    assert.deepEqual(store.releases, [false]);
  });

  test('rolls back the change and writes no line when the row cannot be written', async () => {
    const { lines, store, trail } = trailOver(
      fakeStore((text) => ROW_INSERT.test(text)),
    );

    await assert.rejects(
      trail.inTransaction(ANA, async ({ connection, record }) => {
        await connection.query('INSERT INTO grants DEFAULT VALUES');
        await record(GRANT_CREATION);
      }),
      { message: 'the store refused INSERT' },
    );

    assert.deepEqual(
      store.statements.map(({ text }) => text.split(' ')[0]),
      ['BEGIN', 'SELECT', 'INSERT', 'INSERT', 'ROLLBACK'],
    );
    assert.deepEqual(lines(), []);
  });

  test('writes no line when the commit fails, throwing its failure', async () => {
    const { lines, store, trail } = trailOver(
      fakeStore((text) => text === 'COMMIT'),
    );

    await assert.rejects(
      trail.inTransaction(ANA, async ({ record }) => {
        await record(GRANT_CREATION);
      }),
      { message: 'the store refused COMMIT' },
    );

    assert.equal(store.statements.at(-1)?.text, 'ROLLBACK');
    assert.deepEqual(lines(), []);
  });

  test('writes no line and throws when the store answers the commit with a rollback, as it does once a statement failed', async () => {
    const { lines, store, trail } = trailOver(
      fakeStore(
        () => false,
        (text) =>
          text === 'COMMIT' ? 'ROLLBACK' : (text.split(' ')[0] ?? text),
      ),
    );

    await assert.rejects(
      trail.inTransaction(ANA, async ({ record }) => {
        await record(GRANT_CREATION);
        return 'answered as committed';
      }),
      {
        message:
          'the transaction rolled back at its commit, a statement in it having failed',
      },
    );

    assert.equal(store.statements.at(-1)?.text, 'ROLLBACK');
    assert.deepEqual(lines(), []);
  });

  test('discards a connection that cannot roll back rather than returning it to its pool', async () => {
    const { store, trail } = trailOver(
      fakeStore((text) => text === 'BEGIN' || text === 'ROLLBACK'),
    );

    await assert.rejects(
      trail.inTransaction(ANA, async () => undefined),
      { message: 'the store refused BEGIN' },
    );

    assert.deepEqual(store.releases, [true]);
  });

  test('refuses an event recorded once its transaction has ended, writing nothing', async () => {
    const { lines, store, trail } = trailOver();

    const record = await trail.inTransaction(
      ANA,
      async (transaction) => transaction.record,
    );
    await assert.rejects(record(GRANT_CREATION), {
      message: 'an event is recorded only while its transaction is open',
    });

    assert.deepEqual(rowInserts(store.statements), []);
    assert.deepEqual(lines(), []);
  });

  test('refuses a person or a service account naming an empty subject, before taking a connection', async () => {
    const { store, trail } = trailOver();

    await assert.rejects(
      trail.inTransaction({ id: '', type: 'human' }, async () => undefined),
      TypeError,
    );
    await assert.rejects(
      trail.inTransaction(
        { id: '', type: 'serviceAccount' },
        async () => undefined,
      ),
      TypeError,
    );

    assert.equal(store.connections, 0);
    assert.deepEqual(store.statements, []);
  });

  test('keeps what committed when the log stream cannot take its line, the log reporting itself unwritable', async () => {
    const store = fakeStore();
    const stream = new Writable({
      write: (_chunk: unknown, _encoding, callback) => {
        callback(new Error('the sink refused a write'));
      },
    });
    const eventLog = createEventLog({ clock: FIXED_CLOCK, logStream: stream });
    const trail = createAuditTrail({ eventLog, settings: SETTINGS, store });

    const result = await trail.inTransaction(ANA, async ({ record }) => {
      await record(GRANT_CREATION);
      return 'committed';
    });
    await settled();

    assert.equal(result, 'committed');
    assert.equal(store.statements.at(-1)?.text, 'COMMIT');
    assert.equal(rowInserts(store.statements).length, 1);
    assert.equal(eventLog.isWritable(), false);
  });

  test('writes the dataschema an event names to its row and its line', async () => {
    const { lines, store, trail } = trailOver();
    const dataschema = 'https://overture.bio/schemas/grant.creation';

    await trail.inTransaction(ANA, async ({ record }) => {
      await record({ ...GRANT_CREATION, dataschema });
    });

    assert.equal(rowInserts(store.statements)[0]?.values?.[5], dataschema);
    assert.equal(lines()[0]?.['dataschema'], dataschema);
  });

  test('abandons a transaction the store does not answer within the store timeout, discarding its connection, committing nothing and writing no line', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const { lines, store, trail } = trailOver(
      stallingStore((text) => text.startsWith('UPDATE')),
    );
    const outcome = trail
      .inTransaction(ANA, async ({ connection, record }) => {
        await record(GRANT_CREATION);
        await connection.query('UPDATE grants SET revoked_at = now()');
      })
      .then(
        () => 'committed',
        (failure: unknown) => failure,
      );
    await settled();

    context.mock.timers.tick(STORE_TIMEOUT_MILLISECONDS);
    const failure = await outcome;
    await settled();

    assert.ok(failure instanceof StoreTimeout);
    assert.deepEqual(store.releases, [true]);
    assert.deepEqual(
      store.statements.map(({ text }) => text.split(' ')[0]),
      ['BEGIN', 'SELECT', 'INSERT', 'UPDATE'],
    );
    assert.deepEqual(lines(), []);
  });

  test('sends the store nothing more once a transaction is abandoned, each statement the work makes after failing at its discarded connection', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const { lines, store, trail } = trailOver(stallingStore(() => false));
    const waiting: { resume: () => void } = { resume: () => undefined };
    const after: unknown[] = [];
    const outcome = trail
      .inTransaction(ANA, async ({ connection, record }) => {
        await new Promise<void>((resolve) => {
          waiting.resume = resolve;
        });
        await connection
          .query('UPDATE grants SET revoked_at = now()')
          .catch((failure: unknown) => {
            after.push(failure);
          });
        await record(GRANT_CREATION).catch((failure: unknown) => {
          after.push(failure);
        });
        return 'finished';
      })
      .then(
        () => 'committed',
        (failure: unknown) => failure,
      );
    await settled();

    context.mock.timers.tick(STORE_TIMEOUT_MILLISECONDS);
    waiting.resume();
    const failure = await outcome;
    await settled();

    assert.ok(failure instanceof StoreTimeout);
    assert.equal(after.length, 2);
    assert.deepEqual(
      store.statements.map(({ text }) => text.split(' ')[0]),
      ['BEGIN', 'SELECT'],
    );
    assert.deepEqual(store.releases, [true]);
    assert.deepEqual(lines(), []);
  });

  test('gives the COMMIT one more store timeout, committing and writing its lines when the answer comes within it', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const store = stallingStore(
      (text) => text === 'COMMIT' || text.startsWith('UPDATE'),
    );
    const { lines, trail } = trailOver(store);
    const outcome = trail
      .inTransaction(ANA, async ({ connection, record }) => {
        await record(GRANT_CREATION);
        await connection.query('UPDATE grants SET revoked_at = now()');
        return 'committed';
      })
      .then(
        (result) => result,
        (failure: unknown) => failure,
      );
    await settled();

    context.mock.timers.tick(STORE_TIMEOUT_MILLISECONDS - 1);
    store.answerStalled();
    await settled();
    context.mock.timers.tick(STORE_TIMEOUT_MILLISECONDS - 1);
    store.answerStalled();

    assert.equal(await outcome, 'committed');
    assert.deepEqual(store.releases, [undefined]);
    assert.deepEqual(
      lines().map(({ type }) => type),
      ['bio.overture.grant.creation'],
    );
  });

  test("fails with CommitUnconfirmed when the COMMIT goes unanswered within one more store timeout, writing one line at error naming each event's id and type and never its data, and no event's line", async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const store = stallingStore(
      (text) => text === 'COMMIT' || text.startsWith('UPDATE'),
    );
    const { lines, trail } = trailOver(store);
    const ids: string[] = [];
    const outcome = trail
      .inTransaction(ANA, async ({ connection, record }) => {
        ids.push(await record(GRANT_CREATION));
        ids.push(await record({ ...GRANT_CREATION, type: 'grant.decision' }));
        await connection.query('UPDATE grants SET revoked_at = now()');
      })
      .then(
        () => 'committed',
        (failure: unknown) => failure,
      );
    await settled();

    context.mock.timers.tick(STORE_TIMEOUT_MILLISECONDS - 1);
    store.answerStalled();
    await settled();
    context.mock.timers.tick(STORE_TIMEOUT_MILLISECONDS - 1);
    await settled();
    const pending = { lines: lines().length, releases: [...store.releases] };
    context.mock.timers.tick(1);
    const failure = await outcome;
    await settled();

    assert.deepEqual(pending, { lines: 0, releases: [] });
    assert.ok(failure instanceof CommitUnconfirmed);
    assert.deepEqual(store.releases, [true]);
    assert.deepEqual(lines(), [
      {
        events: [
          { id: ids[0], type: 'bio.overture.grant.creation' },
          { id: ids[1], type: 'bio.overture.grant.decision' },
        ],
        level: 50,
        message: 'audit.commitUnconfirmed',
        time: '2026-11-04T12:30:05.120Z',
      },
    ]);
    assert.equal(JSON.stringify(lines()).includes('global.controlled'), false);
  });

  test("runs a transaction naming its own timeout within it, raising both of the store's limits to it in the statement declaring its actor", async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const ownTimeout = 4 * STORE_TIMEOUT_MILLISECONDS;
    const store = stallingStore((text) => text.startsWith('UPDATE'));
    const { trail } = trailOver(store);
    const outcome = trail
      .inTransaction(
        ANA,
        async ({ connection }) => {
          await connection.query('UPDATE grants SET revoked_at = now()');
        },
        { timeoutMilliseconds: ownTimeout },
      )
      .then(
        () => 'committed',
        (failure: unknown) => failure,
      );
    await settled();

    context.mock.timers.tick(ownTimeout - 1);
    await settled();
    const releasedWithinItsOwn = [...store.releases];
    context.mock.timers.tick(1);
    const failure = await outcome;

    assert.deepEqual(releasedWithinItsOwn, []);
    assert.ok(failure instanceof StoreTimeout);
    assert.deepEqual(store.statements[1]?.values, [
      'human',
      'subject-ana',
      String(ownTimeout),
    ]);
    assert.match(
      store.statements[1]?.text ?? '',
      /set_config\('usher\.actor_id', \$2, true\), set_config\('statement_timeout', \$3, true\), set_config\('idle_in_transaction_session_timeout', \$3, true\)$/u,
    );
  });

  test("writes each row to the configured schema's audit log, its name quoted", async () => {
    const store = fakeStore();
    const { stream } = capture();
    const trail = createAuditTrail({
      eventLog: createEventLog({ clock: FIXED_CLOCK, logStream: stream }),
      settings: { ...SETTINGS, databaseSchema: 'usher "test"' },
      store,
    });

    await trail.inTransaction(ANA, async ({ record }) => {
      await record(GRANT_CREATION);
    });

    assert.match(
      store.statements.find(({ text }) => text.startsWith('INSERT'))?.text ??
        '',
      /^INSERT INTO "usher ""test"""\.audit_log /u,
    );
  });
});

suite('a transaction given a deadline', () => {
  // A deadline falling the milliseconds given after the mocked clock's start, read on that clock, which
  // the mocked timers move.
  const deadlineAt = (milliseconds: number): Deadline => ({
    remainingMilliseconds: () => milliseconds - Date.now(),
  });

  const DECLARING_LIMITS =
    /set_config\('usher\.actor_id', \$2, true\), set_config\('statement_timeout', \$3, true\), set_config\('idle_in_transaction_session_timeout', \$3, true\)$/u;

  test("sets both of the store's limits to its bound, the time left to its deadline where that is shorter than the store timeout, in the statement declaring its actor, and abandons it at that bound", async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const store = stallingStore((text) => text.startsWith('UPDATE'));
    const { lines, trail } = trailOver(store);
    const outcome = trail
      .inTransaction(
        ANA,
        async ({ connection }) => {
          await connection.query('UPDATE grants SET revoked_at = now()');
        },
        { deadline: deadlineAt(100) },
      )
      .then(
        () => 'committed',
        (failure: unknown) => failure,
      );
    await settled();

    context.mock.timers.tick(99);
    await settled();
    const releasedWithinItsBound = [...store.releases];
    context.mock.timers.tick(1);
    const failure = await outcome;

    assert.deepEqual(store.statements[1]?.values, [
      'human',
      'subject-ana',
      '100',
    ]);
    assert.match(store.statements[1]?.text ?? '', DECLARING_LIMITS);
    assert.deepEqual(releasedWithinItsBound, []);
    assert.ok(failure instanceof StoreTimeout);
    assert.deepEqual(store.releases, [true]);
    assert.deepEqual(lines(), []);
  });

  test("sets both of the store's limits to the store timeout where its deadline is further", async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { store, trail } = trailOver();

    await trail.inTransaction(
      ANA,
      async ({ record }) => {
        await record(GRANT_CREATION);
      },
      { deadline: deadlineAt(4000) },
    );

    assert.deepEqual(store.statements[1]?.values, [
      'human',
      'subject-ana',
      String(STORE_TIMEOUT_MILLISECONDS),
    ]);
    assert.match(store.statements[1]?.text ?? '', DECLARING_LIMITS);
  });

  test("sends one naming no failure event as a plain BEGIN, the statement declaring its actor and both limits, the work's statements and COMMIT, each a query of its own", async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { store, trail } = trailOver();

    await trail.inTransaction(
      ANA,
      async ({ connection, record }) => {
        await connection.query('UPDATE grants SET revoked_at = now()');
        await record(GRANT_CREATION);
      },
      { deadline: deadlineAt(200) },
    );

    assert.deepEqual(
      store.statements.map(({ text }) => text),
      [
        'BEGIN',
        ACTOR_AND_LIMITS_DECLARATION,
        'UPDATE grants SET revoked_at = now()',
        ROW_INSERT_TEXT,
        'COMMIT',
      ],
    );
    assert.deepEqual(
      store.statements
        .filter(({ text }) => !ROW_INSERT.test(text))
        .map(({ values }) => values),
      [undefined, ['human', 'subject-ana', '200'], undefined, undefined],
    );
  });

  test('declares its actor and both limits again after rolling back to the savepoint of a failure event, with the statement and the values it began with, though time has passed', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { store, trail } = trailOver();
    const failure = new Error('the change was refused');
    const failureEvent: AuditEvent = {
      data: { reason: 'storeUnavailable', result: 'failed' },
      severity: 'error',
      type: 'token.exchange',
    };

    await assert.rejects(
      trail.inTransaction(
        ANA,
        async ({ connection }) => {
          await connection.query('UPDATE grants SET revoked_at = now()');
          context.mock.timers.tick(40);
          throw failure;
        },
        { deadline: deadlineAt(220), failureEvent },
      ),
      (thrown) => thrown === failure,
    );
    const [first, again, ...more] = declarationsIn(store.statements);

    assert.deepEqual(first, {
      text: ACTOR_AND_LIMITS_DECLARATION,
      values: ['human', 'subject-ana', '220'],
    });
    assert.deepEqual(again, first);
    assert.deepEqual(more, []);
    assert.equal(store.statements.at(-1)?.text, 'COMMIT');
  });

  test('sends no COMMIT when less than the commit window is left to its deadline as its work ends, failing with StoreTimeout, discarding its connection and writing no line', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const deadlineMilliseconds = 200;
    const store = stallingStore((text) => text.startsWith('UPDATE'));
    const { lines, trail } = trailOver(store);
    const outcome = trail
      .inTransaction(
        ANA,
        async ({ connection, record }) => {
          await record(GRANT_CREATION);
          await connection.query('UPDATE grants SET revoked_at = now()');
        },
        { deadline: deadlineAt(deadlineMilliseconds) },
      )
      .then(
        () => 'committed',
        (failure: unknown) => failure,
      );
    await settled();

    context.mock.timers.tick(
      deadlineMilliseconds - COMMIT_WINDOW_MILLISECONDS + 1,
    );
    store.answerStalled();
    const failure = await outcome;
    await settled();

    assert.ok(failure instanceof StoreTimeout);
    assert.deepEqual(
      store.statements.map(({ text }) => text.split(' ')[0]),
      ['BEGIN', 'SELECT', 'INSERT', 'UPDATE'],
    );
    assert.deepEqual(store.releases, [true]);
    assert.deepEqual(lines(), []);
  });

  test('gives its COMMIT what is left of the deadline where that is shorter than the store timeout, then fails with CommitUnconfirmed, writing the line naming its events', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const deadlineMilliseconds = 300;
    const store = stallingStore(
      (text) => text === 'COMMIT' || text.startsWith('UPDATE'),
    );
    const { lines, trail } = trailOver(store);
    const ids: string[] = [];
    const outcome = trail
      .inTransaction(
        ANA,
        async ({ connection, record }) => {
          ids.push(await record(GRANT_CREATION));
          await connection.query('UPDATE grants SET revoked_at = now()');
        },
        { deadline: deadlineAt(deadlineMilliseconds) },
      )
      .then(
        () => 'committed',
        (failure: unknown) => failure,
      );
    await settled();

    context.mock.timers.tick(150);
    store.answerStalled();
    await settled();
    context.mock.timers.tick(deadlineMilliseconds - 150 - 1);
    await settled();
    const pending = { lines: lines().length, releases: [...store.releases] };
    context.mock.timers.tick(1);
    const failure = await outcome;

    assert.deepEqual(pending, { lines: 0, releases: [] });
    assert.ok(failure instanceof CommitUnconfirmed);
    assert.equal(store.statements.at(-1)?.text, 'COMMIT');
    assert.deepEqual(store.releases, [true]);
    assert.deepEqual(
      lines().map(({ events, message }) => ({ events, message })),
      [
        {
          events: [{ id: ids[0], type: 'bio.overture.grant.creation' }],
          message: 'audit.commitUnconfirmed',
        },
      ],
    );
  });

  test('gives its COMMIT one more store timeout where its deadline is further, so a COMMIT left unanswered fails within the store timeout rather than at the deadline', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const store = stallingStore((text) => text === 'COMMIT');
    const { lines, trail } = trailOver(store);
    const outcome = trail
      .inTransaction(
        ANA,
        async ({ record }) => {
          await record(GRANT_CREATION);
        },
        { deadline: deadlineAt(4000) },
      )
      .then(
        () => 'committed',
        (failure: unknown) => failure,
      );
    await settled();

    context.mock.timers.tick(STORE_TIMEOUT_MILLISECONDS - 1);
    await settled();
    const pending = [...store.releases];
    context.mock.timers.tick(1);
    const failure = await outcome;

    assert.deepEqual(pending, []);
    assert.ok(failure instanceof CommitUnconfirmed);
    assert.equal(Date.now(), STORE_TIMEOUT_MILLISECONDS);
    assert.equal(lines()[0]?.['message'], 'audit.commitUnconfirmed');
  });

  test('declares its actor alone, keeping the limits its session was opened with, where it names neither a deadline nor a timeout of its own', async () => {
    const { store, trail } = trailOver();

    await trail.inTransaction(ANA, async ({ record }) => {
      await record(GRANT_CREATION);
    });

    assert.deepEqual(store.statements[1]?.values, ['human', 'subject-ana']);
    assert.doesNotMatch(store.statements[1]?.text ?? '', /statement_timeout/u);
  });
});

suite('a transaction naming a failure event', () => {
  const STORE_FAILURE: AuditEvent = Object.freeze({
    actor: { type: 'anonymous' } as const,
    data: { reason: 'storeUnavailable', result: 'failed', userId: null },
    severity: 'error',
    type: 'token.exchange',
  });

  // Each statement by its first word, a text naming a savepoint in full without the savepoint's name,
  // and an event's row as `INSERT row`.
  const shapeOf = ({ text }: Statement): string => {
    if (ROW_INSERT.test(text)) {
      return 'INSERT row';
    }
    const savepoint =
      /^(?<command>(?:BEGIN; |ROLLBACK TO )?SAVEPOINT) \w+$/u.exec(text)
        ?.groups?.['command'];
    return savepoint ?? text.split(' ')[0] ?? text;
  };

  // The savepoint each statement naming one names.
  const savepointsNamed = (
    statements: readonly Statement[],
  ): readonly string[] =>
    statements.flatMap(
      ({ text }) =>
        /SAVEPOINT (?<name>\w+)$/u.exec(text)?.groups?.['name'] ?? [],
    );

  // Each event's row inserted, by its id and its type.
  const rowsInserted = (
    statements: readonly Statement[],
  ): readonly { id: unknown; type: unknown }[] =>
    rowInserts(statements).map(({ values }) => ({
      id: values?.[0],
      type: values?.[3],
    }));

  const failingWork =
    (failure: Error) =>
    async ({
      connection,
      record,
    }: AuditTransaction<TrailConnection>): Promise<never> => {
      await connection.query('INSERT INTO grants DEFAULT VALUES');
      await record(GRANT_CREATION);
      throw failure;
    };

  test('runs its work under a savepoint taken in one query with its BEGIN, given no values, before its actor is declared, committing and writing its lines as any transaction does when the work succeeds', async () => {
    const { lines, store, trail } = trailOver();

    const result = await trail.inTransaction(
      ANA,
      async ({ record }) => {
        await record(GRANT_CREATION);
        return 'changed';
      },
      { failureEvent: STORE_FAILURE },
    );

    assert.equal(result, 'changed');
    assert.deepEqual(store.statements.map(shapeOf), [
      'BEGIN; SAVEPOINT',
      'SELECT',
      'INSERT row',
      'COMMIT',
    ]);
    assert.equal(store.statements[0]?.values, undefined);
    assert.deepEqual(store.statements[1], {
      text: ACTOR_DECLARATION,
      values: ['human', 'subject-ana'],
    });
    assert.deepEqual(
      lines().map(({ type }) => type),
      ['bio.overture.grant.creation'],
    );
    assert.deepEqual(store.releases, [undefined]);
  });

  test("rolls back to its savepoint when the work fails, declares its actor again, records the failure event in place of every event the work recorded, commits, and writes the failure event's line alone, throwing the work's failure", async () => {
    const { lines, store, trail } = trailOver();
    const failure = new Error('the change was refused');

    await assert.rejects(
      trail.inTransaction(ANA, failingWork(failure), {
        failureEvent: STORE_FAILURE,
      }),
      (thrown) => thrown === failure,
    );
    const [, failureRow] = rowsInserted(store.statements);

    assert.deepEqual(store.statements.map(shapeOf), [
      'BEGIN; SAVEPOINT',
      'SELECT',
      'INSERT',
      'INSERT row',
      'ROLLBACK TO SAVEPOINT',
      'SELECT',
      'INSERT row',
      'COMMIT',
    ]);
    assert.equal(new Set(savepointsNamed(store.statements)).size, 1);
    assert.deepEqual(
      rowsInserted(store.statements).map(({ type }) => type),
      ['bio.overture.grant.creation', 'bio.overture.token.exchange'],
    );
    assert.deepEqual(
      lines().map((line) => ({
        actorId: dataOf(line)['actorId'],
        actorType: dataOf(line)['actorType'],
        id: line['id'],
        reason: dataOf(line)['reason'],
        result: dataOf(line)['result'],
        type: line['type'],
      })),
      [
        {
          actorId: null,
          actorType: 'anonymous',
          id: failureRow?.id,
          reason: 'storeUnavailable',
          result: 'failed',
          type: 'bio.overture.token.exchange',
        },
      ],
    );
    assert.deepEqual(store.releases, [undefined]);
  });

  test('declares its actor again after rolling back to its savepoint with the statement and the values it began with', async () => {
    const { store, trail } = trailOver();
    const failure = new Error('the change was refused');

    await assert.rejects(
      trail.inTransaction(ANA, failingWork(failure), {
        failureEvent: STORE_FAILURE,
      }),
      (thrown) => thrown === failure,
    );
    const [first, again, ...more] = declarationsIn(store.statements);

    assert.deepEqual(first, {
      text: ACTOR_DECLARATION,
      values: ['human', 'subject-ana'],
    });
    assert.deepEqual(again, first);
    assert.deepEqual(more, []);
  });

  test('records the failure event when a statement of the work fails at the store', async () => {
    const { lines, store, trail } = trailOver(
      fakeStore((text) => text.startsWith('UPDATE')),
    );

    await assert.rejects(
      trail.inTransaction(
        ANA,
        async ({ connection }) => {
          await connection.query('UPDATE grants SET revoked_at = now()');
        },
        { failureEvent: STORE_FAILURE },
      ),
      { message: 'the store refused UPDATE' },
    );

    assert.equal(store.statements.at(-1)?.text, 'COMMIT');
    assert.deepEqual(
      lines().map(({ type }) => type),
      ['bio.overture.token.exchange'],
    );
  });

  test("records nothing when its connection cannot be rolled back to the savepoint, discarding the connection and throwing the work's failure", async () => {
    const { lines, store, trail } = trailOver(
      fakeStore((text) => text.startsWith('ROLLBACK')),
    );
    const failure = new Error('the change was refused');

    await assert.rejects(
      trail.inTransaction(ANA, failingWork(failure), {
        failureEvent: STORE_FAILURE,
      }),
      (thrown) => thrown === failure,
    );

    assert.deepEqual(store.statements.map(shapeOf).slice(-2), [
      'ROLLBACK TO SAVEPOINT',
      'ROLLBACK',
    ]);
    assert.deepEqual(
      rowsInserted(store.statements).map(({ type }) => type),
      ['bio.overture.grant.creation'],
    );
    assert.deepEqual(lines(), []);
    assert.deepEqual(store.releases, [true]);
  });

  test("records nothing when its connection fails as it declares its actor again after the rollback to the savepoint, discarding the connection and throwing the work's failure", async () => {
    // A connection lost once it has rolled back to the savepoint: every statement after fails.
    const store: FakeStore = fakeStore(
      (text) =>
        !text.startsWith('ROLLBACK TO SAVEPOINT') &&
        store.statements.some(({ text: sent }) =>
          sent.startsWith('ROLLBACK TO SAVEPOINT'),
        ),
    );
    const { lines, trail } = trailOver(store);
    const failure = new Error('the change was refused');

    await assert.rejects(
      trail.inTransaction(ANA, failingWork(failure), {
        failureEvent: STORE_FAILURE,
      }),
      (thrown) => thrown === failure,
    );

    assert.deepEqual(store.statements.map(shapeOf).slice(-3), [
      'ROLLBACK TO SAVEPOINT',
      'SELECT',
      'ROLLBACK',
    ]);
    assert.deepEqual(
      rowsInserted(store.statements).map(({ type }) => type),
      ['bio.overture.grant.creation'],
    );
    assert.deepEqual(lines(), []);
    assert.deepEqual(store.releases, [true]);
  });

  test("commits nothing and throws the work's failure when the failure event's row cannot be written", async () => {
    const { lines, store, trail } = trailOver(
      fakeStore((text) => ROW_INSERT.test(text)),
    );
    const failure = new Error('the change was refused');

    await assert.rejects(
      trail.inTransaction(
        ANA,
        async ({ connection }) => {
          await connection.query('UPDATE grants SET revoked_at = now()');
          throw failure;
        },
        { failureEvent: STORE_FAILURE },
      ),
      (thrown) => thrown === failure,
    );

    assert.deepEqual(store.statements.map(shapeOf), [
      'BEGIN; SAVEPOINT',
      'SELECT',
      'UPDATE',
      'ROLLBACK TO SAVEPOINT',
      'SELECT',
      'INSERT row',
      'ROLLBACK',
    ]);
    assert.deepEqual(lines(), []);
  });

  test("throws the work's failure rather than CommitUnconfirmed when the COMMIT recording the failure event goes unanswered, the line naming that event alone", async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const store = stallingStore((text) => text === 'COMMIT');
    const { lines, trail } = trailOver(store);
    const failure = new Error('the change was refused');
    const outcome = trail
      .inTransaction(ANA, failingWork(failure), {
        failureEvent: STORE_FAILURE,
      })
      .then(
        () => 'committed',
        (thrown: unknown) => thrown,
      );
    await settled();

    context.mock.timers.tick(STORE_TIMEOUT_MILLISECONDS);
    const thrown = await outcome;
    const [, failureRow] = rowsInserted(store.statements);

    assert.equal(thrown, failure);
    assert.deepEqual(store.releases, [true]);
    assert.deepEqual(
      lines().map(({ events, message }) => ({ events, message })),
      [
        {
          events: [{ id: failureRow?.id, type: 'bio.overture.token.exchange' }],
          message: 'audit.commitUnconfirmed',
        },
      ],
    );
  });

  test('fails with StoreTimeout and records nothing when the store stops answering the work within the store timeout, sending nothing to the discarded connection', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const store = stallingStore((text) => text.startsWith('UPDATE'));
    const { lines, trail } = trailOver(store);
    const outcome = trail
      .inTransaction(
        ANA,
        async ({ connection }) => {
          await connection.query('UPDATE grants SET revoked_at = now()');
        },
        { failureEvent: STORE_FAILURE },
      )
      .then(
        () => 'committed',
        (thrown: unknown) => thrown,
      );
    await settled();

    context.mock.timers.tick(STORE_TIMEOUT_MILLISECONDS);
    const thrown = await outcome;
    await settled();

    assert.ok(thrown instanceof StoreTimeout);
    assert.deepEqual(store.statements.map(shapeOf), [
      'BEGIN; SAVEPOINT',
      'SELECT',
      'UPDATE',
    ]);
    assert.deepEqual(store.releases, [true]);
    assert.deepEqual(lines(), []);
  });
});

suite('an event recorded alone', () => {
  const REFUSAL: AuditEvent = Object.freeze({
    data: { reason: 'administratorOnly', result: 'denied' },
    severity: 'warning',
    type: 'application.registration',
  });

  test('commits its row in a transaction of its own under the actor given, then writes its line', async () => {
    const { lines, store, trail } = trailOver();

    const id = await trail.recordEvent(ANA, REFUSAL);

    assert.deepEqual(
      store.statements.map(({ text }) => text.split(' ')[0]),
      ['BEGIN', 'SELECT', 'INSERT', 'COMMIT'],
    );
    assert.deepEqual(store.statements[1]?.values, ['human', 'subject-ana']);
    assert.equal(lines()[0]?.['id'], id);
    assert.equal(dataOf(lines()[0])['reason'], 'administratorOnly');
  });

  test("writes a line at error naming the event's type and the store's code, never its data, when its row cannot be written", async () => {
    const failing = fakeStore((text) => ROW_INSERT.test(text));
    const refused = Object.assign(new Error('the store refused it'), {
      code: '42501',
    });
    const store = {
      ...failing,
      connect: async (): Promise<TrailConnection> => {
        const connection = await failing.connect();
        return {
          query: (text, values) =>
            ROW_INSERT.test(text)
              ? Promise.reject(refused)
              : connection.query(text, values),
          release: (destroy) => connection.release(destroy),
        };
      },
    };
    const { lines, trail } = trailOver(store);

    const id = await trail.recordEvent(ANA, REFUSAL);

    assert.equal(id, undefined);
    assert.deepEqual(lines(), [
      {
        code: '42501',
        eventType: 'bio.overture.application.registration',
        level: 50,
        message: 'audit.eventUnrecorded',
        time: '2026-11-04T12:30:05.120Z',
      },
    ]);
  });

  test("writes the line naming the store timeout's code when the store does not answer the event's transaction in time, and throws nothing", async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const { lines, store, trail } = trailOver(
      stallingStore((text) => ROW_INSERT.test(text)),
    );
    const recording = trail.recordEvent(ANA, REFUSAL);
    await settled();

    context.mock.timers.tick(STORE_TIMEOUT_MILLISECONDS);
    const id = await recording;

    assert.equal(id, undefined);
    assert.deepEqual(store.releases, [true]);
    assert.deepEqual(
      lines().map(({ code, eventType, message }) => ({
        code,
        eventType,
        message,
      })),
      [
        {
          code: 'storeTimeout',
          eventType: 'bio.overture.application.registration',
          message: 'audit.eventUnrecorded',
        },
      ],
    );
  });

  test("writes no line saying the event went unrecorded when its COMMIT goes unconfirmed, the one line naming it being the transaction's, and throws nothing", async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const { lines, trail } = trailOver(
      stallingStore((text) => text === 'COMMIT'),
    );
    const recording = trail.recordEvent(ANA, REFUSAL);
    await settled();

    context.mock.timers.tick(2 * STORE_TIMEOUT_MILLISECONDS);
    const id = await recording;

    const [line, ...more] = lines();

    assert.equal(id, undefined);
    assert.deepEqual(more, []);
    assert.equal(line?.['message'], 'audit.commitUnconfirmed');
    assert.match(
      JSON.stringify(line?.['events']),
      /^\[\{"id":"[0-9a-f-]{36}","type":"bio\.overture\.application\.registration"\}\]$/u,
    );
  });

  test('writes the line with no code for a failure carrying none, and throws nothing', async () => {
    const { lines, trail } = trailOver(fakeStore((text) => text === 'BEGIN'));

    const id = await trail.recordEvent(SYSTEM, REFUSAL);

    assert.equal(id, undefined);
    assert.deepEqual(
      lines().map(({ code, eventType, message }) => ({
        code,
        eventType,
        message,
      })),
      [
        {
          code: undefined,
          eventType: 'bio.overture.application.registration',
          message: 'audit.eventUnrecorded',
        },
      ],
    );
  });
});
