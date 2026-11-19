import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { type AddressInfo, connect, createServer } from 'node:net';
import { suite, test } from 'node:test';

import pg from 'pg';

import { migrate, MigrationRefusal } from '../migrations/index.js';
import { NoticeStreamMissing } from '../noticeStream/index.js';
import { CommitUnconfirmed, StoreTimeout } from '../storeTimeout/index.js';
import { ControllerError } from './controllerError.js';
import { failureRecord } from './reportFailure.js';
import { StartRefusal } from './startRefusal.js';

const FATAL_LEVEL = 60;

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

// The record a failure is written as, the time aside, once it is shown to be an instant.
const recordOf = (failed: string, failure: unknown): unknown => {
  const { time, ...rest } = failureRecord(failed, failure);
  assert.match(String(time), INSTANT);
  return rest;
};

const rejectionOf = async (attempt: Promise<unknown>): Promise<unknown> =>
  attempt.then(
    () => assert.fail('the attempt succeeded, where a failure was expected'),
    (failure: unknown) => failure,
  );

// What a client meets connecting to a loopback port nothing listens on: a system error whose message
// names the address.
const refusedConnection = async (): Promise<{
  failure: unknown;
  port: number;
}> => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, 'close');
  const socket = connect(port, '127.0.0.1');
  const [failure] = await once(socket, 'error');
  return { failure, port };
};

suite("a process entry's failure line", () => {
  test('writes a store error by its SQLSTATE under the fixed message, and no value its message or detail quotes', () => {
    const marker = `value-${randomUUID()}`;
    const failure = Object.assign(
      new pg.DatabaseError(
        `invalid input syntax for type uuid: "${marker}"`,
        0,
        'error',
      ),
      { code: '22P02', detail: `Key (id)=(${marker}) is not a uuid.` },
    );

    const record = recordOf('the schema migration command failed', failure);

    assert.deepEqual(record, {
      level: FATAL_LEVEL,
      code: '22P02',
      message: 'the schema migration command failed',
    });
    assert.equal(JSON.stringify(record).includes(marker), false);
  });

  test('writes a system error by its code under the fixed message, and never the address its message names', async () => {
    const { failure, port } = await refusedConnection();

    const record = recordOf('the controller failed to start', failure);

    assert.deepEqual(record, {
      level: FATAL_LEVEL,
      code: 'ECONNREFUSED',
      message: 'the controller failed to start',
    });
    assert.equal(JSON.stringify(record).includes(String(port)), false);
  });

  test('writes a library error carrying no code by its name alone under the fixed message, never its message', () => {
    const marker = 'hunter2';
    const failure: unknown = (() => {
      try {
        return JSON.parse(`{"p": ${marker}}`);
      } catch (error) {
        return error;
      }
    })();

    const record = recordOf('the controller failed to stop', failure);

    assert.ok(failure instanceof SyntaxError);
    assert.equal(failure.message.includes(marker), true);
    assert.deepEqual(record, {
      level: FATAL_LEVEL,
      error: 'SyntaxError',
      message: 'the controller failed to stop',
    });
    assert.equal(JSON.stringify(record).includes(marker), false);
  });

  test('writes a failure whose code is not an identifier by its name alone, as one carrying none', () => {
    const marker = `value-${randomUUID()}`;
    const failures = [
      Object.assign(new Error(marker), { code: `not a code: ${marker}` }),
      Object.assign(new Error(marker), { code: 42 }),
    ];

    const records = failures.map((failure) =>
      recordOf('the schema migration command failed', failure),
    );

    assert.deepEqual(
      records,
      failures.map(() => ({
        level: FATAL_LEVEL,
        error: 'Error',
        message: 'the schema migration command failed',
      })),
    );
    assert.equal(JSON.stringify(records).includes(marker), false);
  });

  test('writes a thrown value that is no error by its type alone', () => {
    assert.deepEqual(recordOf('the controller failed to start', 'a value'), {
      level: FATAL_LEVEL,
      error: 'string',
      message: 'the controller failed to start',
    });
  });

  test('writes a refusal with the variables it names and its own message', () => {
    const refusal = new StartRefusal([
      { rule: 'is missing', variable: 'USHER_ISSUER' },
    ]);

    assert.deepEqual(recordOf('the controller failed to start', refusal), {
      level: FATAL_LEVEL,
      variables: ['USHER_ISSUER'],
      message: 'the controller refuses to start: USHER_ISSUER is missing',
    });
  });

  test('writes a refusal naming a stored setting with the settings it names, and no variables it does not name', () => {
    const refusal = new StartRefusal([
      { rule: 'is missing from the store', setting: 'noticePageLimit' },
    ]);

    assert.deepEqual(recordOf('the controller failed to start', refusal), {
      level: FATAL_LEVEL,
      variables: [],
      settings: ['noticePageLimit'],
      message:
        'the controller refuses to start: the setting noticePageLimit is missing from the store',
    });
  });

  test("writes each other error of the controller's own with its name and its message, after what failed", async () => {
    const thrownByARun = await rejectionOf(
      migrate({
        databaseUrl: 'postgres://usher_migration@127.0.0.1:5432/usher',
        seed: () =>
          Promise.reject(
            new Error('the seed file is not read by this test'),
          ),
        clock: { now: () => 0 },
        eventLog: { error: () => undefined, writeEvent: () => undefined },
        runtimeRole: '',
        schema: 'usher',
      }),
    );
    const failures = [
      new MigrationRefusal('schema', 'names a schema another role owns'),
      new StoreTimeout(),
      new CommitUnconfirmed(),
      new NoticeStreamMissing(),
      new ControllerError('the controller listens on no TCP address'),
    ];

    const records = failures.map((failure) =>
      recordOf('the controller failed to stop', failure),
    );

    assert.deepEqual(
      records,
      failures.map(({ message, name }) => ({
        level: FATAL_LEVEL,
        error: name,
        message: `the controller failed to stop: ${message}`,
      })),
    );
    assert.deepEqual(
      records.map((record) =>
        typeof record === 'object' && record !== null && 'error' in record
          ? record.error
          : undefined,
      ),
      [
        'MigrationRefusal',
        'StoreTimeout',
        'CommitUnconfirmed',
        'NoticeStreamMissing',
        'ControllerError',
      ],
    );
    assert.deepEqual(
      recordOf('the schema migration command failed', thrownByARun),
      {
        level: FATAL_LEVEL,
        error: 'ControllerError',
        message:
          'the schema migration command failed: the schema migrations refuse to run: runtimeRole must name an identifier',
      },
    );
  });

  test("writes the code of the failure an error of its own wraps beside its message, and never that failure's message", () => {
    const marker = `value-${randomUUID()}`;
    const cause = Object.assign(
      new pg.DatabaseError(`relation "${marker}" already exists`, 0, 'error'),
      { code: '42P07' },
    );
    const failure = new ControllerError(
      'the migration 0003_policy_rules failed, and none of it was applied',
      { cause },
    );

    const record = recordOf('the schema migration command failed', failure);

    assert.deepEqual(record, {
      level: FATAL_LEVEL,
      error: 'ControllerError',
      code: '42P07',
      message:
        'the schema migration command failed: the migration 0003_policy_rules failed, and none of it was applied',
    });
    assert.equal(JSON.stringify(record).includes(marker), false);
  });

  test('writes no code for a wrapped failure carrying none, or one that is not an identifier, as when a run is stopped before it starts', async () => {
    const marker = `value-${randomUUID()}`;
    const stopping = new AbortController();
    stopping.abort();
    const stopped = await rejectionOf(
      migrate({
        databaseUrl: 'postgres://usher_migration@127.0.0.1:5432/usher',
        seed: () =>
          Promise.reject(
            new Error('the seed file is not read by this test'),
          ),
        clock: { now: () => 0 },
        eventLog: { error: () => undefined, writeEvent: () => undefined },
        runtimeRole: 'usher_controller',
        schema: 'usher',
        signal: stopping.signal,
      }),
    );
    const failures = [
      stopped,
      new ControllerError('the run was stopped', {
        cause: Object.assign(new Error(marker), {
          code: `not a code ${marker}`,
        }),
      }),
    ];

    const records = failures.map((failure) =>
      recordOf('the schema migration command failed', failure),
    );

    assert.ok(stopped instanceof ControllerError);
    assert.deepEqual(records, [
      {
        level: FATAL_LEVEL,
        error: 'ControllerError',
        message:
          'the schema migration command failed: the run was stopped, and every migration it committed before the stop stays applied',
      },
      {
        level: FATAL_LEVEL,
        error: 'ControllerError',
        message: 'the schema migration command failed: the run was stopped',
      },
    ]);
    assert.equal(JSON.stringify(records).includes(marker), false);
  });

  test("writes a failure's name only when it is an identifier, else Error", () => {
    const marker = `value-${randomUUID()}`;
    const failures = [
      Object.assign(new Error(marker), { name: `Named after ${marker}` }),
      Object.assign(new Error(marker), { name: '' }),
      Object.assign(new Error(marker), { name: 'DatabaseConfigurationError' }),
    ];

    const records = failures.map((failure) =>
      recordOf('the controller failed', failure),
    );

    assert.deepEqual(
      records.map((record) =>
        typeof record === 'object' && record !== null && 'error' in record
          ? record.error
          : undefined,
      ),
      ['Error', 'Error', 'DatabaseConfigurationError'],
    );
    assert.equal(JSON.stringify(records).includes(marker), false);
  });

  test("writes its members in the log stream's order: the level, the fields, then the message and the time", () => {
    const keys = [
      new StartRefusal([{ rule: 'is missing', variable: 'USHER_ISSUER' }]),
      new StoreTimeout(),
      new ControllerError('wrapping', {
        cause: Object.assign(new Error('wrapped'), { code: '57P01' }),
      }),
      Object.assign(new Error('refused'), { code: 'ECONNRESET' }),
      new Error('anything'),
    ].map((failure) => Object.keys(failureRecord('failed', failure)));

    assert.deepEqual(keys, [
      ['level', 'variables', 'message', 'time'],
      ['level', 'error', 'message', 'time'],
      ['level', 'error', 'code', 'message', 'time'],
      ['level', 'code', 'message', 'time'],
      ['level', 'error', 'message', 'time'],
    ]);
  });
});
