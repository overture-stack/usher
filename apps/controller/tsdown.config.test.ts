import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { type AddressInfo, createServer, type Socket } from 'node:net';
import { suite, test, type TestContext } from 'node:test';

import { type BuiltEntry, builtEntry } from './test-support/build.js';
import {
  type ControllerEnvironment,
  ENVIRONMENT_VARIABLES,
  environmentFor,
  readRefusal,
  SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES,
  spawnController,
  spawnSchemaMigrationCommand,
  spawnWithUncaughtFailure,
  type UncaughtFailure,
  unusedPort,
} from './test-support/controller.js';
import { configurationToRead, passwordsApart } from './test-support/harness.js';

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

// A loopback listener that accepts every connection and never says a word, so a process connecting
// to it waits there; closed with every connection it accepted once the test has ended.
const silentPort = async (context: TestContext): Promise<number> => {
  const accepted = new Set<Socket>();
  const server = createServer((socket) => {
    accepted.add(socket);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => {
    accepted.forEach((socket) => socket.destroy());
    server.close();
    await once(server, 'close');
  });
  return (server.address() as AddressInfo).port;
};

// An environment each entry reads and then waits in, connecting to a store that never answers.
const waitingEnvironment = async (
  entry: BuiltEntry,
  port: number,
): Promise<ControllerEnvironment> =>
  entry === 'main'
    ? environmentFor(
        passwordsApart(
          configurationToRead({
            databaseUrl: `postgres://usher_controller@127.0.0.1:${port}/usher`,
            port: await unusedPort(),
          }),
        ),
      )
    : {
        [ENVIRONMENT_VARIABLES.databaseSchema]: 'usher',
        [ENVIRONMENT_VARIABLES.databaseUrl]: `postgres://usher_controller@127.0.0.1:${port}/usher`,
        [SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.databasePassword]:
          randomBytes(12).toString('base64url'),
        [SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.databaseUrl]: `postgres://usher_migration@127.0.0.1:${port}/usher`,
      };

// What each entry's line says failed when a failure nothing caught ends it.
const UNCAUGHT_FAILED: Readonly<Record<BuiltEntry, string>> = {
  main: 'the controller failed',
  migrate: 'the schema migration command failed',
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

  test('gives entries that end at once on a failure nothing caught, thrown or rejected, writing one line naming it by its name alone and exiting 1', async (context) => {
    const port = await silentPort(context);
    const cases: readonly { entry: BuiltEntry; failure: UncaughtFailure }[] = [
      { entry: 'main', failure: 'exception' },
      { entry: 'main', failure: 'rejection' },
      { entry: 'migrate', failure: 'exception' },
      { entry: 'migrate', failure: 'rejection' },
    ];
    const marker = `uncaught-${randomUUID()}`;

    const exits = await Promise.all(
      cases.map(async ({ entry, failure }) =>
        spawnWithUncaughtFailure(entry, await waitingEnvironment(entry, port), {
          failure,
          message: marker,
        }),
      ),
    );

    assert.deepEqual(
      exits.map((exit) => ({
        exitCode: exit.exitCode,
        line: refusalLine(exit.stderr),
        stdout: exit.stdout,
        timedOut: exit.timedOut,
      })),
      cases.map(({ entry }) => ({
        exitCode: 1,
        line: {
          level: FATAL_LEVEL,
          error: 'Error',
          message: UNCAUGHT_FAILED[entry],
        },
        stdout: '',
        timedOut: false,
      })),
    );
    assert.equal(
      exits.some((exit) => exit.stderr.includes(marker)),
      false,
    );
  });
});
