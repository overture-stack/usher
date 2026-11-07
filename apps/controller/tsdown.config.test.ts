import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { suite, test } from 'node:test';

import { builtEntry } from './test-support/build.js';
import {
  ENVIRONMENT_VARIABLES,
  SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES,
  readRefusal,
  spawnController,
  spawnSchemaMigrationCommand,
  unusedPort,
} from './test-support/controller.js';

// The log stream's numbering of fatal, which a refusal to start is written at.
const FATAL_LEVEL = 60;

const linesOf = (text: string): readonly unknown[] =>
  text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line): unknown => JSON.parse(line));

// The one line a refused process writes, the time aside, which is the line's own.
const refusalLine = (stderr: string): unknown => {
  const [line, ...laterLines] = linesOf(stderr);
  assert.deepEqual(laterLines, []);
  assert.ok(typeof line === 'object' && line !== null && 'time' in line);
  const { time: _time, ...rest } = line;
  return rest;
};

// The run's global setup builds the controller once, with its committed configuration, into a folder
// of the run's own, which every test of a built entry reads.
suite("the controller's build", () => {
  test('gives a main entry that runs under Node alone and refuses an empty environment as the source does', async () => {
    const refusal = await readRefusal({});
    assert.ok(refusal instanceof Error && 'variables' in refusal);

    // An empty environment names no port, so one nothing listens on is probed.
    const exit = await spawnController(
      {},
      { builtEntry: builtEntry('main'), port: await unusedPort() },
    );

    assert.equal(exit.timedOut, false);
    assert.equal(exit.exitCode, 1);
    assert.equal(exit.stdout, '');
    assert.deepEqual(refusalLine(exit.stderr), {
      level: FATAL_LEVEL,
      variables: refusal.variables,
      message: refusal.message,
    });
  });

  test('gives a migrate entry that runs under Node alone and refuses an empty environment, naming each variable it requires', async () => {
    const required = [
      SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.databasePassword,
      SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.databaseUrl,
      ENVIRONMENT_VARIABLES.databaseUrl,
      ENVIRONMENT_VARIABLES.databaseSchema,
    ];

    const exit = await spawnSchemaMigrationCommand({});

    assert.equal(exit.timedOut, false);
    assert.equal(exit.exitCode, 1);
    assert.equal(exit.stdout, '');
    assert.deepEqual(refusalLine(exit.stderr), {
      level: FATAL_LEVEL,
      variables: required,
      message: `the schema migrations refuse to run: ${required.map((variable) => `${variable} is missing`).join('; ')}`,
    });
  });

  test("gives a migrate entry that refuses a store it cannot reach, naming its URL's variable and never the URL or the password", async () => {
    const password = randomBytes(12).toString('base64url');
    const url = `postgres://usher_migration@127.0.0.1:${await unusedPort()}/usher`;

    const exit = await spawnSchemaMigrationCommand({
      [ENVIRONMENT_VARIABLES.databaseSchema]: 'usher',
      [ENVIRONMENT_VARIABLES.databaseUrl]:
        'postgres://usher_controller@127.0.0.1:5432/usher',
      [SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.databasePassword]: password,
      [SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.databaseUrl]: url,
    });

    assert.equal(exit.exitCode, 1);
    assert.deepEqual(refusalLine(exit.stderr), {
      level: FATAL_LEVEL,
      variables: [SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.databaseUrl],
      message: `the schema migrations refuse to run: ${SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.databaseUrl} names an address at which no store accepts connections`,
    });
    assert.equal(exit.stderr.includes(url), false);
    assert.equal(exit.stderr.includes(password), false);
  });
});
