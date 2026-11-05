import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { storeConnection } from './connection.js';

suite('connecting to the store', () => {
  test("connects as the URL's role to its host, port and database, with the password from its own variable", () => {
    const connection = storeConnection({
      databasePassword: ' a password/@:% ',
      databaseUrl:
        'postgres://usher_controller@db.example.org:6432/usher?sslmode=disable',
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
    });

    assert.equal(connection.connectionString, undefined);
    assert.equal(connection.password, 'given');
  });
});
