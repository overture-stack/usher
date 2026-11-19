import assert from 'node:assert/strict';
import { once } from 'node:events';
import { type AddressInfo, createServer, type Socket } from 'node:net';
import { suite, test, type TestContext } from 'node:test';

import {
  migrate,
  OLDEST_SUPPORTED_SERVER_VERSION,
  refuseUnsupportedServer,
} from './migrate.js';
import { MigrationRefusal } from './migrationRefusal.js';
import type { MigrationOptions } from './types.js';

// Short, so a test of the timeout takes a fraction of a second; the command's own is 30 s.
const TEST_TIMEOUT_MILLISECONDS = 200;

const optionsFor = (port: number): MigrationOptions => ({
  connectionTimeoutMilliseconds: TEST_TIMEOUT_MILLISECONDS,
  databasePassword: 'unused',
  databaseUrl: `postgres://usher_migration@127.0.0.1:${port}/usher`,
	seed: () => Promise.reject(new Error('the seed file is not read by these tests')),
	clock: { now: () => 0 },
	eventLog: { error: () => undefined, writeEvent: () => undefined },
  runtimeRole: 'usher_controller',
  schema: 'usher',
});

interface SilentListener {
  /** The connections it has accepted so far. */
  accepted: ReadonlySet<Socket>;

  /** Settles once it has accepted its first connection. */
  firstAccepted: Promise<unknown>;

  port: number;
}

// A loopback listener that accepts every connection and never says a word, as a host that never
// answers looks to a client; closed with every connection it accepted once the test has ended.
const silentListener = async (
  context: TestContext,
): Promise<SilentListener> => {
  const accepted = new Set<Socket>();
  const server = createServer((socket) => {
    accepted.add(socket);
  });
  const firstAccepted = once(server, 'connection');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => {
    accepted.forEach((socket) => socket.destroy());
    server.close();
    await once(server, 'close');
  });
  return {
    accepted,
    firstAccepted,
    port: (server.address() as AddressInfo).port,
  };
};

const STOPPED =
  'the run was stopped, and every migration it committed before the stop stays applied';

// A loopback port nothing listens on at the moment of asking.
const closedPort = async (): Promise<number> => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, 'close');
  return port;
};

suite("a migration run's connection", () => {
  test('gives up once its connection timeout passes at an address that never answers, laying the refusal on the URL and never quoting it', async (context) => {
    const { port } = await silentListener(context);

    const failure: unknown = await migrate(optionsFor(port)).then(
      () => assert.fail('the run connected to a listener that never answers'),
      (rejection: unknown) => rejection,
    );

    assert.ok(failure instanceof MigrationRefusal);
    assert.deepEqual(
      { option: failure.option, rule: failure.rule },
      {
        option: 'databaseUrl',
        rule: 'names an address at which no store answered within 0.2 seconds',
      },
    );
    assert.equal(failure.message.includes(String(port)), false);
  });

  test("keeps the driver's own failure when the store refuses the connection before the timeout passes", async () => {
    const port = await closedPort();

    const failure: unknown = await migrate(optionsFor(port)).then(
      () => assert.fail('the run connected to a port nothing listens on'),
      (rejection: unknown) => rejection,
    );

    assert.ok(failure instanceof Error);
    assert.equal(failure instanceof MigrationRefusal, false);
    assert.equal('code' in failure ? failure.code : undefined, 'ECONNREFUSED');
  });
});

suite("a migration run's stop", () => {
  test('rejects saying it was stopped, connecting to nothing, when its signal aborted before it started', async (context) => {
    const { accepted, port } = await silentListener(context);
    const stopping = new AbortController();
    stopping.abort();

    const failure: unknown = await migrate({
      ...optionsFor(port),
      signal: stopping.signal,
    }).then(
      () => assert.fail('the run went on after its stop'),
      (rejection: unknown) => rejection,
    );

    assert.ok(failure instanceof Error);
    assert.equal(failure.message, STOPPED);
    assert.equal(accepted.size, 0);
  });

  test('takes a stop while connecting once the attempt ends, rejecting saying it was stopped rather than with what the attempt met', async (context) => {
    const { firstAccepted, port } = await silentListener(context);
    const stopping = new AbortController();

    const running = migrate({ ...optionsFor(port), signal: stopping.signal });
    await firstAccepted;
    stopping.abort();
    const failure: unknown = await running.then(
      () => assert.fail('the run went on after its stop'),
      (rejection: unknown) => rejection,
    );

    assert.ok(failure instanceof Error);
    assert.equal(failure instanceof MigrationRefusal, false);
    assert.equal(failure.message, STOPPED);
    assert.ok(failure.cause instanceof MigrationRefusal);
  });
});

suite("a migration run's server", () => {
  // A client answering the version query with the release given, as `server_version_num` numbers it.
  const answeringVersion = (version: number) => ({
    query: async () => ({ rows: [{ version }] }),
  });

  test('refuses a server older than PostgreSQL 15, laying the refusal on the URL', async () => {
    const refusals = await Promise.all(
      [140_009, 149_999].map((version) =>
        refuseUnsupportedServer(answeringVersion(version)).then(
          () => undefined,
          (rejection: unknown) => rejection,
        ),
      ),
    );

    refusals.forEach((refusal) => {
      assert.ok(refusal instanceof MigrationRefusal);
      assert.equal(refusal.option, 'databaseUrl');
      assert.match(refusal.rule, /older than 15/u);
    });
  });

  test('runs on PostgreSQL 15 and later', async () => {
    await Promise.all(
      [OLDEST_SUPPORTED_SERVER_VERSION, 180_006].map((version) =>
        refuseUnsupportedServer(answeringVersion(version)),
      ),
    );
  });
});
