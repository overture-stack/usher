import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { suite, test } from 'node:test';

import type { Clock } from '../configuration/index.js';
import { createAuditTrail } from './createAuditTrail.js';
import { createEventLog } from './createEventLog.js';
import type {
  Actor,
  AuditEvent,
  AuditTrail,
  EventLog,
  TrailConnection,
} from './types.js';

const NOW = Date.UTC(2026, 10, 4, 12, 30, 5, 120);

const FIXED_CLOCK: Clock = Object.freeze({ now: () => NOW });

const SETTINGS = Object.freeze({
  clock: FIXED_CLOCK,
  databaseSchema: 'usher',
  eventSource: 'https://usher.example.org/controller',
  instanceName: 'usher-test-1',
});

const ANA: Actor = Object.freeze({ id: 'subject-ana', type: 'human' });

const SYSTEM: Actor = Object.freeze({ type: 'system' });

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const ROW_INSERT = /^INSERT INTO "usher"\.audit_log /u;

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
      /\(id, specversion, source, type, occurred_at, dataschema, data, severity\)/u,
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
