import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import pg from 'pg';

import {
  IDLE_CONNECTION_LOST,
  openStore,
  storeConnection,
} from './connection.js';
import type { StoreLineFields } from './types.js';

suite('connecting to the store', () => {
  test("connects as the URL's role to its host, port and database, with the password from its own variable", () => {
    const connection = storeConnection({
      databasePassword: ' a password/@:% ',
      databaseUrl:
        'postgres://usher_controller@db.example.org:6432/usher?sslmode=disable',
      storeTimeoutMilliseconds: 5000,
    });

    assert.deepEqual(
      {
        database: connection.database,
        host: connection.host,
        password: connection.password,
        port: connection.port,
        ssl: connection.ssl,
        user: connection.user,
      },
      {
        database: 'usher',
        host: 'db.example.org',
        password: ' a password/@:% ',
        port: 6432,
        ssl: false,
        user: 'usher_controller',
      },
    );
  });

  test('hands the driver no URL, whose own empty password would override the one given', () => {
    const connection = storeConnection({
      databasePassword: 'given',
      databaseUrl: 'postgres://usher_controller@127.0.0.1/usher',
      storeTimeoutMilliseconds: 5000,
    });

    assert.equal(connection.connectionString, undefined);
    assert.equal(connection.password, 'given');
  });

  test("limits the pool's wait for a connection, and on the server each statement and each wait inside a transaction, to the store timeout, over any the URL sets", () => {
    const connection = storeConnection({
      databasePassword: 'given',
      databaseUrl:
        'postgres://usher_controller@127.0.0.1/usher?connectionTimeoutMillis=0&statement_timeout=0&idle_in_transaction_session_timeout=0',
      storeTimeoutMilliseconds: 250,
    });

    assert.deepEqual(
      {
        connectionTimeoutMillis: connection.connectionTimeoutMillis,
        idleInTransaction: connection.idle_in_transaction_session_timeout,
        statement: connection.statement_timeout,
      },
      {
        connectionTimeoutMillis: 250,
        idleInTransaction: 250,
        statement: 250,
      },
    );
  });
});

suite("each of the store's pools", () => {
  test('holds at most the connections given, each limited alike', async () => {
    const pools = [1, 5, 10].map((connections) =>
      openStore(
        {
          databasePassword: 'given',
          databaseUrl: 'postgres://usher_controller@127.0.0.1/usher',
          storeTimeoutMilliseconds: 250,
        },
        { error: () => undefined },
        connections,
      ),
    );
    const held = pools.map(({ options }) => ({
      connectionTimeoutMillis: options.connectionTimeoutMillis,
      idleInTransaction: options.idle_in_transaction_session_timeout,
      max: options.max,
      statement: options.statement_timeout,
    }));
    await Promise.all(pools.map((pool) => pool.end()));

    assert.deepEqual(
      held,
      [1, 5, 10].map((max) => ({
        connectionTimeoutMillis: 250,
        idleInTransaction: 250,
        max,
        statement: 250,
      })),
    );
  });
});

suite("the store's idle connections", () => {
  const PASSWORD = 'a password/@:% only the store knows';
  const URL = 'postgres://usher_controller@db.example.org:6432/usher';

  const losses = async (
    errors: readonly Error[],
  ): Promise<readonly [string, StoreLineFields][]> => {
    const written: [string, StoreLineFields][] = [];
    const pool = openStore(
      {
        databasePassword: PASSWORD,
        databaseUrl: URL,
        storeTimeoutMilliseconds: 5000,
      },
      {
        error: (message, fields) => {
          written.push([message, fields]);
        },
      },
      10,
    );
    errors.forEach((error) => pool.emit('error', error));
    await pool.end();
    return written;
  };

  test('writes each one lost at error, naming the failure by its code alone, never its message', async () => {
    const terminated = Object.assign(
      new pg.DatabaseError(
        'terminating connection due to administrator command',
        0,
        'error',
      ),
      { code: '57P01', detail: 'a detail naming a value' },
    );
    const reset = Object.assign(new Error('read ECONNRESET'), {
      code: 'ECONNRESET',
    });
    const ended = new Error('Connection terminated unexpectedly');

    const written = await losses([terminated, reset, ended]);

    assert.deepEqual(written, [
      [IDLE_CONNECTION_LOST, { code: '57P01' }],
      [IDLE_CONNECTION_LOST, { code: 'ECONNRESET' }],
      [IDLE_CONNECTION_LOST, {}],
    ]);
  });

  test("adds neither the store's password nor its URL to the line", async () => {
    const written = await losses([
      Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:6432'), {
        code: 'ECONNREFUSED',
      }),
    ]);
    const text = JSON.stringify(written);

    assert.equal(written.length, 1);
    assert.equal(text.includes(PASSWORD), false);
    assert.equal(text.includes(URL), false);
  });
});
