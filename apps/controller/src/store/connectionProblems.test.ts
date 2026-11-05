import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { connectionProblemOf } from './connectionProblems.js';

const failing = (code: string): Error =>
  Object.assign(
    new Error(`connect failed at 10.0.0.5 for usher_controller: ${code}`),
    {
      code,
    },
  );

suite("a start's failure to reach or sign in to the store", () => {
  test('names the database URL for an address, a host, a database or a role the store refuses', () => {
    const named = [
      'ECONNREFUSED',
      'ENOENT',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EHOSTUNREACH',
      'ENETUNREACH',
      '3D000',
      '28000',
    ].map((code) => [code, connectionProblemOf(failing(code))]);

    assert.deepEqual(named, [
      [
        'ECONNREFUSED',
        {
          rule: 'names an address at which no store accepts connections',
          variable: 'USHER_DATABASE_URL',
        },
      ],
      [
        'ENOENT',
        {
          rule: 'names an address at which no store accepts connections',
          variable: 'USHER_DATABASE_URL',
        },
      ],
      [
        'ENOTFOUND',
        {
          rule: 'names a host that does not resolve',
          variable: 'USHER_DATABASE_URL',
        },
      ],
      [
        'EAI_AGAIN',
        {
          rule: 'names a host that does not resolve',
          variable: 'USHER_DATABASE_URL',
        },
      ],
      [
        'EHOSTUNREACH',
        {
          rule: 'names a host that cannot be reached',
          variable: 'USHER_DATABASE_URL',
        },
      ],
      [
        'ENETUNREACH',
        {
          rule: 'names a host that cannot be reached',
          variable: 'USHER_DATABASE_URL',
        },
      ],
      [
        '3D000',
        {
          rule: 'names a database the store does not hold',
          variable: 'USHER_DATABASE_URL',
        },
      ],
      [
        '28000',
        {
          rule: 'names a database role the store does not let connect to that database from this host',
          variable: 'USHER_DATABASE_URL',
        },
      ],
    ]);
  });

  test('names the password for a password the store refuses, its rule naming the role the URL names, since the store answers the same for a role it lacks', () => {
    assert.deepEqual(connectionProblemOf(failing('28P01')), {
      rule: 'is not the password of the database role USHER_DATABASE_URL names, or that role does not exist',
      variable: 'USHER_DATABASE_PASSWORD',
    });
  });

  test('names nothing for a failure that is no fault of a variable, or carries no code', () => {
    assert.deepEqual(
      [
        connectionProblemOf(failing('ECONNRESET')),
        connectionProblemOf(failing('57P01')),
        connectionProblemOf(new Error('Connection terminated unexpectedly')),
        connectionProblemOf('ECONNREFUSED'),
      ],
      [undefined, undefined, undefined, undefined],
    );
  });
});
