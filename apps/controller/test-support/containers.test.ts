import assert from 'node:assert/strict';
import { connect, createServer, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { suite, type TestContext, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { decodeJwt } from 'jose';
import pg from 'pg';

import { runningContainers } from './containerEnvironment.js';
import {
  addressKeycloakRealm,
  DEFAULT_KEYCLOAK_REALM,
  flushValkey,
  openCacheConnection,
  RELAYED_PATHS,
  type Relay,
  reportsHostPortTaken,
  startDedicatedPostgresql,
  startDedicatedValkey,
  startKeycloak,
  startOnFreeHostPort,
  startRelay,
  suiteFlushedCache,
  watchCache,
} from './containers.js';
import { startRecordingServer } from './recordingServer.js';
import { cleanupFor, eventually, suiteCleanup } from './waiting.js';

const respCommand = (command: readonly string[]): string =>
  `*${command.length}\r\n${command
    .map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`)
    .join('')}`;

// Each command here answers with one line, so the replies are complete once there is a line per
// command; the reply settles once the socket has closed.
const valkeyReplies = (
  url: URL,
  commands: readonly (readonly string[])[],
): Promise<readonly string[]> =>
  new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    const received: Buffer[] = [];
    const replies = (): string[] =>
      Buffer.concat(received).toString('utf8').split('\r\n').slice(0, -1);
    socket.on('connect', () =>
      socket.write(commands.map(respCommand).join('')),
    );
    socket.on('data', (chunk: Buffer) => {
      received.push(chunk);
      if (replies().length >= commands.length) {
        socket.end();
      }
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(replies()));
  });

suite("the run's containers", () => {
  test('reach every test file through the environment the global setup published', () => {
    const { postgresql, valkey } = runningContainers();

    assert.match(postgresql.url, /^postgres:\/\//u);
    assert.match(valkey.url, /^redis:\/\//u);
  });

  test('answer on PostgreSQL, at exactly the version of the image the run selected', async () => {
    const { postgresql } = runningContainers();
    const [, major, minor] =
      /^postgres:(\d+)\.(\d+)$/u.exec(postgresql.image) ?? [];
    const postgres = new pg.Client({ connectionString: postgresql.url });
    await postgres.connect();
    try {
      const { rows } = await postgres.query<{ server_version_num: string }>(
        'SHOW server_version_num',
      );

      assert.equal(
        rows[0]?.server_version_num,
        String(Number(major) * 10_000 + Number(minor)),
      );
    } finally {
      await postgres.end();
    }
  });

  test('answer on Valkey behind its password', async () => {
    const url = new URL(runningContainers().valkey.url);
    const password = decodeURIComponent(url.password);

    const [refused] = await valkeyReplies(url, [['PING']]);
    const answered = await valkeyReplies(url, [['AUTH', password], ['PING']]);

    assert.match(refused ?? '', /^-NOAUTH/u);
    assert.deepEqual(answered, ['+OK', '+PONG']);
  });
});

const ANSWER_WITHIN_MS = 1_000;

// What one connection gets within a second: the rows, or no answer from a frozen server, or a
// refusal from a stopped one.
const postgresqlOutcome = async (
  url: string,
  query = 'SELECT note FROM outage_marker ORDER BY note',
): Promise<readonly string[] | 'no answer' | 'refused'> => {
  const postgres = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: ANSWER_WITHIN_MS,
  });
  const connected: 'no answer' | 'refused' | true = await postgres
    .connect()
    .then(
      () => true as const,
      (error: unknown) =>
        error instanceof Error && /timeout/iu.test(error.message)
          ? ('no answer' as const)
          : ('refused' as const),
    );
  if (connected === true) {
    try {
      const { rows } = await postgres.query<{ note: string }>(query);
      return rows.map(({ note }) => note);
    } finally {
      await postgres.end();
    }
  }
  return connected;
};

const valkeyOutcome = (url: URL): Promise<string> =>
  new Promise((resolve) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    const received: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      resolve('no answer');
    }, ANSWER_WITHIN_MS);
    const settle = (outcome: string): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    socket.on('connect', () =>
      socket.write(
        [['AUTH', decodeURIComponent(url.password)], ['PING']]
          .map(respCommand)
          .join(''),
      ),
    );
    socket.on('data', (chunk: Buffer) => {
      received.push(chunk);
      const lines = Buffer.concat(received).toString('utf8').split('\r\n');
      if (lines.length > 2) {
        settle(lines[1] ?? '');
      }
    });
    socket.on('error', () => settle('refused'));
    socket.on('close', () => settle('refused'));
  });

suite("a container of a test file's own, for its outage tests", () => {
  test('pauses, unpauses, stops and restarts a PostgreSQL at one URL, keeping its data, while the shared one answers throughout', async (context) => {
    const dedicated = await startDedicatedPostgresql();
    context.after(() => dedicated.remove());
    const { url } = dedicated.container;
    const setup = new pg.Client({ connectionString: url });
    await setup.connect();
    await setup.query(
      "CREATE TABLE outage_marker (note text); INSERT INTO outage_marker VALUES ('kept')",
    );
    await setup.end();
    const shared = runningContainers().postgresql.url;

    await dedicated.pause();
    const paused = await postgresqlOutcome(url);
    const sharedWhilePaused = await postgresqlOutcome(
      shared,
      "SELECT 'answered' AS note",
    );
    await dedicated.unpause();
    const unpaused = await postgresqlOutcome(url);
    await dedicated.stop();
    const stopped = await postgresqlOutcome(url);
    await dedicated.restart();
    const restarted = await postgresqlOutcome(url);

    assert.equal(paused, 'no answer');
    assert.deepEqual(sharedWhilePaused, ['answered']);
    assert.deepEqual(unpaused, ['kept']);
    assert.equal(stopped, 'refused');
    assert.deepEqual(restarted, ['kept']);
    assert.equal(dedicated.container.url, url);
    assert.match(dedicated.container.image, /^postgres:\d+\.\d+$/u);
  });

  test('pauses, unpauses, stops and restarts a Valkey at one URL, while the shared one answers throughout', async (context) => {
    const dedicated = await startDedicatedValkey();
    context.after(() => dedicated.remove());
    const url = new URL(dedicated.container.url);
    const shared = new URL(runningContainers().valkey.url);

    const running = await valkeyOutcome(url);
    await dedicated.pause();
    const paused = await valkeyOutcome(url);
    const sharedWhilePaused = await valkeyOutcome(shared);
    await dedicated.unpause();
    const unpaused = await valkeyOutcome(url);
    await dedicated.stop();
    const stopped = await valkeyOutcome(url);
    await dedicated.restart();
    const restarted = await valkeyOutcome(url);

    assert.deepEqual(
      { paused, restarted, running, sharedWhilePaused, stopped, unpaused },
      {
        paused: 'no answer',
        restarted: '+PONG',
        running: '+PONG',
        sharedWhilePaused: '+PONG',
        stopped: 'refused',
        unpaused: '+PONG',
      },
    );
    assert.equal(new URL(dedicated.container.url).port, url.port);
  });
});

// A start the daemon refused, as the Docker client throws it: docker-modem's
// `(HTTP code 500) server error - <the daemon's message> `.
const refusedStart = (daemonMessage: string): Error =>
  new Error(`(HTTP code 500) server error - ${daemonMessage} `);

// A Linux daemon's report of a failed port binding, as Moby words it: daemon/container_operations.go,
// then daemon/libnetwork/endpoint.go, around the cause.
const linuxDaemonReport = (cause: string): string =>
  `failed to set up container networking: driver failed programming external connectivity on endpoint exciting_elgamal (cbb19848e54f46acd3b40ab4f59a67469faf3b70082054f4b4f4d656e2df643a): ${cause}`;

// A Linux daemon's report of a port another of its containers holds: the port allocator's own,
// daemon/libnetwork/portallocator/portallocator.go.
const portAllocatedReport = (port: number): Error =>
  refusedStart(
    linuxDaemonReport(
      `Bind for 0.0.0.0:${port} failed: port is already allocated`,
    ),
  );

suite('telling a host port reported taken from any other failed start', () => {
  test("recognizes a Linux daemon's report of a port another of its containers holds", () => {
    assert.equal(reportsHostPortTaken(portAllocatedReport(31_458)), true);
  });

  test("recognizes a Linux daemon's report of a port another process on its host holds", () => {
    // daemon/libnetwork/portallocator/osallocator_linux.go, around the system's EADDRINUSE.
    const report = refusedStart(
      linuxDaemonReport(
        'failed to bind host port 0.0.0.0:31457/tcp: address already in use',
      ),
    );

    assert.equal(reportsHostPortTaken(report), true);
  });

  test("recognizes Docker Desktop's report of a port held on its machine", () => {
    const report = refusedStart(
      'ports are not available: exposing port TCP 0.0.0.0:31457 -> 127.0.0.1:0: listen tcp 0.0.0.0:31457: bind: address already in use\n',
    );

    assert.equal(reportsHostPortTaken(report), true);
  });

  test('recognizes no other failure, a binding refused for another reason and a port never bound included', () => {
    const others: readonly unknown[] = [
      refusedStart(
        linuxDaemonReport(
          'failed to bind host port 0.0.0.0:31457/tcp: permission denied',
        ),
      ),
      new Error('Port 5432 not bound after 60000ms'),
      undefined,
    ];

    assert.deepEqual(others.map(reportsHostPortTaken), [false, false, false]);
  });
});

suite('starting a dedicated container on a free host port', () => {
  test('draws another port from 30000 to 32767 each time the daemon reports the one drawn taken, and starts on the first it admits', async (context) => {
    const taken = (hostPort: number): Promise<number> =>
      Promise.reject(portAllocatedReport(hostPort));
    const start = context.mock.fn((hostPort: number): Promise<number> =>
      Promise.resolve(hostPort),
    );
    start.mock.mockImplementationOnce(taken, 0);
    start.mock.mockImplementationOnce(taken, 1);

    const startedOn = await startOnFreeHostPort(start);
    const drawn = start.mock.calls.map(({ arguments: [port] }) => port);

    assert.equal(drawn.length, 3);
    assert.equal(startedOn, drawn[2]);
    assert.ok(
      drawn.every((port) => port >= 30_000 && port <= 32_767),
      `every port drawn lies in 30000 to 32767: ${drawn.join(', ')}`,
    );
  });

  test('throws any other failure at once, drawing no other port', async (context) => {
    const notBound = new Error('Port 5432 not bound after 60000ms');
    const start = context.mock.fn((): Promise<never> =>
      Promise.reject(notBound),
    );

    await assert.rejects(
      startOnFreeHostPort(start),
      (error) => error === notBound,
    );
    assert.equal(start.mock.callCount(), 1);
  });

  test("gives up after the 20th port reported taken, with the daemon's last report as its cause", async (context) => {
    const start = context.mock.fn((hostPort: number): Promise<never> =>
      Promise.reject(portAllocatedReport(hostPort)),
    );

    const failure: unknown = await startOnFreeHostPort(start).then(
      () => undefined,
      (error: unknown) => error,
    );
    const lastDrawn = start.mock.calls.at(-1)?.arguments[0];

    assert.equal(start.mock.callCount(), 20);
    assert.ok(failure instanceof Error);
    assert.equal(
      failure.message,
      'no free host port in 30000 to 32767 after 20 attempts',
    );
    assert.ok(failure.cause instanceof Error);
    assert.match(
      failure.cause.message,
      new RegExp(`:${lastDrawn} failed`, 'u'),
    );
  });
});

const relayTo = async (
  context: TestContext,
  target: string,
  protocol: 'http' | 'tcp' = 'tcp',
): Promise<Relay> => {
  const relay = await startRelay(target, { protocol });
  context.after(() => relay.stop());
  return relay;
};

// How one connection's attempt ends: connected, or the error's code.
const connection = (url: URL): Promise<string> =>
  new Promise((resolve) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code ?? 'error');
    });
  });

const timed = async <Result>(
  work: () => Promise<Result>,
): Promise<{ elapsedMs: number; result: Result }> => {
  const startedAt = performance.now();
  const result = await work();
  return { elapsedMs: performance.now() - startedAt, result };
};

suite('a loopback relay', () => {
  test('passes, freezes, delays, resets and refuses the TCP connections through it, open ones included', async (context) => {
    const relay = await relayTo(context, runningContainers().valkey.url);
    const url = new URL(relay.url);

    const passing = await valkeyOutcome(url);
    await relay.setMode({ kind: 'freeze' });
    const frozen = await valkeyOutcome(url);
    await relay.setMode({ kind: 'delay', ms: 300 });
    const delayed = await timed(() => valkeyOutcome(url));
    await relay.setMode({ kind: 'reset' });
    const reset = await valkeyOutcome(url);
    await relay.setMode({ kind: 'refuse' });
    const refused = await connection(url);
    await relay.setMode({ kind: 'pass' });
    const passingAgain = await valkeyOutcome(url);

    assert.deepEqual(
      {
        delayed: delayed.result,
        frozen,
        passing,
        passingAgain,
        refused,
        reset,
      },
      {
        delayed: '+PONG',
        frozen: 'no answer',
        passing: '+PONG',
        passingAgain: '+PONG',
        refused: 'ECONNREFUSED',
        reset: 'refused',
      },
    );
    assert.ok(delayed.elapsedMs >= 300);
  });

  test('freezes a connection already open, and lets it go on once passing again', async (context) => {
    const relay = await relayTo(context, runningContainers().valkey.url);
    const url = new URL(relay.url);
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    context.after(() => {
      socket.destroy();
    });
    const replies: string[] = [];
    socket.on('data', (chunk: Buffer) => replies.push(chunk.toString('utf8')));
    await new Promise<void>((resolve) =>
      socket.once('connect', () => resolve()),
    );
    socket.write(respCommand(['AUTH', decodeURIComponent(url.password)]));
    await delay(200);

    await relay.setMode({ kind: 'freeze' });
    socket.write(respCommand(['PING']));
    await delay(300);
    const whileFrozen = replies.join('');
    await relay.setMode({ kind: 'pass' });
    await delay(300);

    assert.equal(whileFrozen, '+OK\r\n');
    assert.equal(replies.join(''), '+OK\r\n+PONG\r\n');
  });

  test('cuts a client off, resetting what is open and refusing what comes', async (context) => {
    const relay = await relayTo(context, runningContainers().valkey.url);
    const url = new URL(relay.url);
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    const ended = new Promise<void>((resolve) =>
      socket.once('close', () => resolve()),
    );
    socket.on('error', () => undefined);
    await new Promise<void>((resolve) =>
      socket.once('connect', () => resolve()),
    );

    await relay.cut();
    await ended;

    assert.equal(await connection(url), 'ECONNREFUSED');
    assert.equal(
      new URL(relay.url).password,
      new URL(runningContainers().valkey.url).password,
    );
  });

  test('treats each HTTP path as told, and points requests at another server when told', async (context) => {
    const first = await startRecordingServer(() => ({
      body: 'first',
      status: 200,
    }));
    const second = await startRecordingServer(() => ({
      body: 'second',
      status: 200,
    }));
    context.after(() => Promise.all([first.stop(), second.stop()]));
    const relay = await relayTo(context, first.url.href, 'http');
    const at = (path: string): URL => new URL(path, relay.url);
    const outcome = (path: string, timeoutMs = 2000): Promise<string> =>
      fetch(at(path), { signal: AbortSignal.timeout(timeoutMs) }).then(
        async (response) => `${response.status} ${await response.text()}`,
        (error: unknown) => (error instanceof Error ? error.name : 'failed'),
      );

    await relay.setMode({ kind: 'reset' }, '/notices');
    await relay.setMode({ kind: 'refuse' }, '/notices/stream');
    await relay.setMode({ kind: 'delay', ms: 300 }, '/exchange');
    const reset = await outcome('/notices');
    const refused = await outcome('/notices/stream');
    const delayed = await timed(() => outcome('/exchange'));
    const untouched = await outcome('/admin/resources');
    await relay.setMode({ kind: 'freeze' }, '/exchange');
    const frozen = await outcome('/exchange', 300);
    await relay.setMode({ kind: 'pass' }, '/exchange');
    relay.setTarget(second.url.href);
    const retargeted = await outcome('/exchange');
    await relay.setMode({ kind: 'refuse' });
    const refusedEverywhere = await connection(new URL(relay.url));

    assert.deepEqual(
      {
        delayed: delayed.result,
        frozen,
        refused,
        refusedEverywhere,
        reset,
        retargeted,
        untouched,
      },
      {
        delayed: '200 first',
        frozen: 'TimeoutError',
        refused: 'TypeError',
        refusedEverywhere: 'ECONNREFUSED',
        reset: 'TypeError',
        retargeted: '200 second',
        untouched: '200 first',
      },
    );
    assert.ok(delayed.elapsedMs >= 300);
    assert.deepEqual(
      second.requests.map(({ target }) => target),
      ['/exchange'],
    );
  });
});

const chunkArrivals = async (
  body: ReadableStream<Uint8Array> | null,
): Promise<readonly number[]> => {
  const reader = body?.getReader();
  const readAll = async (
    arrivals: readonly number[],
  ): Promise<readonly number[]> => {
    const read = await reader?.read();
    return read === undefined || read.done
      ? arrivals
      : readAll([...arrivals, performance.now()]);
  };
  return readAll([]);
};

const gapsBetween = (instants: readonly number[]): readonly number[] =>
  instants.slice(1).map((instant, index) => instant - (instants[index] ?? 0));

// A pace or a delay is a timer's own, which never fires early; the slack covers how late loopback
// delivers the chunk before it.
const TIMER_SLACK_MS = 50;

suite('a loopback relay, its modes proven one by one', () => {
  test("holds an HTTP answer's start for a delay, the request reaching the server at once", async (context) => {
    const server = await startRecordingServer(() => ({
      body: 'answered',
      status: 200,
    }));
    context.after(() => server.stop());
    const relay = await relayTo(context, server.url.href, 'http');
    await relay.setMode({ kind: 'delay', ms: 400 }, RELAYED_PATHS.exchange);

    const sentAt = performance.now();
    const answering = fetch(new URL(RELAYED_PATHS.exchange, relay.url), {
      body: '{}',
      method: 'POST',
    });
    await eventually(
      () => Promise.resolve(server.requests.length === 1),
      2000,
      5,
    );
    const reachedAt = performance.now();
    const response = await answering;
    const answeredAt = performance.now();

    assert.equal(`${response.status} ${await response.text()}`, '200 answered');
    assert.ok(reachedAt - sentAt < 400 - TIMER_SLACK_MS);
    assert.ok(answeredAt - sentAt >= 400);
  });

  test("paces an HTTP answer's body, each chunk no sooner than the pace after the one before", async (context) => {
    const server = await startRecordingServer(() => ({
      respond: (response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.flushHeaders();
        ['one', 'two', 'three', 'four'].forEach((event, index) => {
          setTimeout(() => {
            response.write(`: ${event}\n\n`);
            if (index === 3) {
              response.end();
            }
          }, index * 20);
        });
      },
    }));
    context.after(() => server.stop());
    const relay = await relayTo(context, server.url.href, 'http');
    await relay.setMode({ kind: 'pace', ms: 250 }, RELAYED_PATHS.stream);

    const response = await fetch(new URL(RELAYED_PATHS.stream, relay.url));
    const arrivals = await chunkArrivals(response.body);

    assert.equal(arrivals.length, 4);
    assert.ok(
      gapsBetween(arrivals).every((gap) => gap >= 250 - TIMER_SLACK_MS),
    );
  });

  test('paces a TCP connection, each chunk no sooner than the pace after the one before', async (context) => {
    const upstream = createServer((socket) => {
      socket.setNoDelay(true);
      ['one', 'two', 'three'].forEach((word, index) => {
        setTimeout(() => {
          socket.write(word);
          if (index === 2) {
            socket.end();
          }
        }, index * 30);
      });
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', resolve);
    });
    context.after(
      () =>
        new Promise<void>((resolve) => {
          upstream.close(() => resolve());
        }),
    );
    const address = upstream.address();
    const port =
      typeof address === 'object' && address !== null ? address.port : 0;
    const relay = await relayTo(context, `tcp://127.0.0.1:${port}`);
    await relay.setMode({ kind: 'pace', ms: 250 });

    const url = new URL(relay.url);
    const arrivals = await new Promise<readonly number[]>((resolve, reject) => {
      const socket = connect({ host: url.hostname, port: Number(url.port) });
      const seen: number[] = [];
      socket.on('data', () => seen.push(performance.now()));
      socket.on('error', reject);
      socket.on('close', () => resolve(seen));
    });

    assert.equal(arrivals.length, 3);
    assert.ok(
      gapsBetween(arrivals).every((gap) => gap >= 250 - TIMER_SLACK_MS),
    );
  });

  test('freezes an open HTTP answer and a request arriving while frozen, and lets both go on once passing again', async (context) => {
    const held: { release: () => void } = { release: () => undefined };
    const released = new Promise<void>((resolve) => {
      held.release = resolve;
    });
    const server = await startRecordingServer(({ target }) =>
      target.startsWith('/notices/stream')
        ? {
            respond: (response) => {
              response.writeHead(200, { 'content-type': 'text/event-stream' });
              response.write(': first\n\n');
              void released.then(() => response.end(': second\n\n'));
            },
          }
        : { body: 'polled', status: 200 },
    );
    context.after(() => server.stop());
    const relay = await relayTo(context, server.url.href, 'http');
    const stream = await fetch(new URL(RELAYED_PATHS.stream, relay.url));
    const reader = stream.body?.getReader();
    const first = new TextDecoder().decode((await reader?.read())?.value);

    await relay.setMode({ kind: 'freeze' });
    held.release();
    const polling = fetch(new URL(RELAYED_PATHS.notices, relay.url)).then(
      async (response) => response.text(),
    );
    const reading = reader?.read();
    const whileFrozen = await Promise.race([
      reading?.then(() => 'read'),
      new Promise((resolve) => setTimeout(() => resolve('nothing'), 400)),
    ]);
    const pollsWhileFrozen = server.requests.filter(
      ({ target }) => target === '/notices',
    ).length;
    await relay.setMode({ kind: 'pass' });
    const second = new TextDecoder().decode((await reading)?.value);

    assert.equal(first, ': first\n\n');
    assert.equal(whileFrozen, 'nothing');
    assert.equal(pollsWhileFrozen, 0);
    assert.equal(second, ': second\n\n');
    assert.equal(await polling, 'polled');
  });

  test("applies a mode to one of the bridge's paths, named as the bridge names it under the relay's own path", async (context) => {
    const server = await startRecordingServer(() => ({
      body: 'reached',
      status: 200,
    }));
    context.after(() => server.stop());
    const relay = await relayTo(
      context,
      new URL('controller/', server.url).href,
      'http',
    );
    const outcome = (path: string): Promise<string> =>
      fetch(new URL(path, relay.url), {
        signal: AbortSignal.timeout(2000),
      }).then(
        async (response) => `${response.status} ${await response.text()}`,
        (error: unknown) => (error instanceof Error ? error.name : 'failed'),
      );

    await relay.setMode({ kind: 'refuse' }, RELAYED_PATHS.notices);
    const outcomes = {
      exchange: await outcome(RELAYED_PATHS.exchange),
      notices: await outcome(RELAYED_PATHS.notices),
      stream: await outcome(RELAYED_PATHS.stream),
    };

    assert.deepEqual(outcomes, {
      exchange: '200 reached',
      notices: 'TypeError',
      stream: '200 reached',
    });
    assert.deepEqual(
      server.requests.map(({ target }) => target),
      ['/controller/exchange', '/controller/notices/stream'],
    );
  });
});

suite('a loopback relay, answering, closing and taking the latest mode', () => {
  const answered = (url: URL): Promise<string> =>
    fetch(url, { signal: AbortSignal.timeout(2000) }).then(
      async (response) => `${response.status} ${await response.text()}`,
      (error: unknown) => (error instanceof Error ? error.name : 'failed'),
    );

  test('answers a path with a status and an empty body, never forwarding it, while the other paths pass', async (context) => {
    const server = await startRecordingServer(() => ({
      body: 'reached',
      status: 200,
    }));
    context.after(() => server.stop());
    const relay = await relayTo(context, server.url.href, 'http');

    await relay.setMode({ kind: 'status', status: 503 }, RELAYED_PATHS.notices);
    const outcomes = {
      exchange: await answered(new URL(RELAYED_PATHS.exchange, relay.url)),
      notices: await answered(new URL(RELAYED_PATHS.notices, relay.url)),
    };
    await relay.setMode({ kind: 'status', status: 410 });
    const everywhere = await answered(
      new URL(RELAYED_PATHS.exchange, relay.url),
    );

    assert.deepEqual(outcomes, { exchange: '200 reached', notices: '503 ' });
    assert.equal(everywhere, '410 ');
    assert.deepEqual(
      server.requests.map(({ target }) => target),
      ['/exchange'],
    );
  });

  test('leaves an open stream as it was when its path refuses, and ends it when its path closes', async (context) => {
    const server = await startRecordingServer(() => ({
      respond: (response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(': open\n\n');
      },
    }));
    context.after(() => server.stop());
    const relay = await relayTo(context, server.url.href, 'http');
    const streamUrl = new URL(RELAYED_PATHS.stream, relay.url);
    const stream = await fetch(streamUrl);
    const reader = stream.body?.getReader();
    await reader?.read();

    await relay.setMode({ kind: 'refuse' }, RELAYED_PATHS.stream);
    const reading = reader?.read().then(
      (read) => (read.done ? 'ended' : 'read'),
      () => 'ended',
    );
    const whileRefused = await Promise.race([
      reading,
      delay(300).then(() => 'open'),
    ]);
    const another = await answered(streamUrl);
    await relay.setMode({ kind: 'close' }, RELAYED_PATHS.stream);
    const whenClosed = await Promise.race([
      reading,
      delay(2000).then(() => 'open'),
    ]);

    assert.equal(whileRefused, 'open');
    assert.equal(another, 'TypeError');
    assert.equal(whenClosed, 'ended');
  });

  test("applies a later mode for every path over each path's own, and a path's own set after it over that", async (context) => {
    const server = await startRecordingServer(() => ({
      body: 'reached',
      status: 200,
    }));
    context.after(() => server.stop());
    const relay = await relayTo(context, server.url.href, 'http');
    const exchange = new URL(RELAYED_PATHS.exchange, relay.url);
    const notices = new URL(RELAYED_PATHS.notices, relay.url);

    await relay.setMode({ kind: 'status', status: 503 }, RELAYED_PATHS.notices);
    await relay.setMode({ kind: 'pass' });
    const afterEveryPath = await answered(notices);
    await relay.setMode({ kind: 'status', status: 502 });
    await relay.setMode({ kind: 'pass' }, RELAYED_PATHS.exchange);
    const pathAfter = {
      exchange: await answered(exchange),
      notices: await answered(notices),
    };

    assert.equal(afterEveryPath, '200 reached');
    assert.deepEqual(pathAfter, { exchange: '200 reached', notices: '502 ' });
  });

  test('keeps refusing connections when a path is told to refuse after every path was, and listens again for a path let through', async (context) => {
    const server = await startRecordingServer(() => ({
      body: 'reached',
      status: 200,
    }));
    context.after(() => server.stop());
    const relay = await relayTo(context, server.url.href, 'http');
    const url = new URL(relay.url);

    await relay.setMode({ kind: 'refuse' });
    await relay.setMode({ kind: 'refuse' }, RELAYED_PATHS.notices);
    const refusedStill = await connection(url);
    await relay.setMode({ kind: 'pass' }, RELAYED_PATHS.exchange);
    const outcomes = {
      exchange: await answered(new URL(RELAYED_PATHS.exchange, relay.url)),
      notices: await answered(new URL(RELAYED_PATHS.notices, relay.url)),
    };

    assert.equal(refusedStill, 'ECONNREFUSED');
    assert.deepEqual(outcomes, {
      exchange: '200 reached',
      notices: 'TypeError',
    });
  });

  test('refuses to answer a status over TCP', async (context) => {
    const relay = await relayTo(context, runningContainers().valkey.url);

    await assert.rejects(relay.setMode({ kind: 'status', status: 503 }), {
      message: 'a TCP relay answers no status: start an HTTP relay',
      name: 'TypeError',
    });
  });
});

// A TCP server that closes each connection at once, or holds it and never answers.
const silentServer = async (
  context: TestContext,
  behaviour: 'close' | 'hold',
): Promise<string> => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    if (behaviour === 'close') {
      socket.end();
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(
    () =>
      new Promise<void>((resolve) => {
        sockets.forEach((socket) => socket.destroy());
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : 0;
  return `redis://127.0.0.1:${port}`;
};

suite("a cache of a test's own, reached over its protocol", () => {
  const flushedCache = suiteFlushedCache(suiteCleanup());

  test('gives a suite one Valkey of its own, flushed each time a test asks for it, signing in with its URL', async () => {
    const url = await flushedCache();
    const connection = await openCacheConnection(url);
    try {
      await connection.send(['SET', 'usher-test-key', 'held']);
      const heldBefore = await connection.send(['DBSIZE']);
      const again = await flushedCache();
      const heldAfter = await connection.send(['DBSIZE']);

      assert.equal(again, url);
      assert.equal(heldBefore, 1);
      assert.equal(heldAfter, 0);
      assert.notEqual(url, runningContainers().valkey.url);
    } finally {
      await connection.close();
    }
  });

  test('watches every channel, each message published before a mark sitting before it', async (context) => {
    const url = await flushedCache();
    const watch = await watchCache(cleanupFor(context), url);
    const publisher = await openCacheConnection(url);
    context.after(() => publisher.close());

    await publisher.send(['PUBLISH', 'usher-wake', 'first']);
    await publisher.send(['PUBLISH', 'usher-wake', 'second']);
    const position = await watch.mark();
    await flushValkey(url);

    assert.deepEqual(watch.messages().slice(0, 2), [
      { channel: 'usher-wake', payload: 'first' },
      { channel: 'usher-wake', payload: 'second' },
    ]);
    assert.equal(position, 2);
  });

  test('fails rather than hangs when the connection closes before an answer, or no answer comes in time', async (context) => {
    const closing = await silentServer(context, 'close');
    const holding = await silentServer(context, 'hold');
    const startedAt = performance.now();

    await assert.rejects(flushValkey(closing), {
      message:
        /the cache connection (?:was ended by the cache|closed) before the cache's answer to FLUSHALL/u,
    });
    const held = await openCacheConnection(holding, 200);
    context.after(() => held.close());
    await assert.rejects(held.send(['PING']), {
      message: "the cache's answer to PING did not come within 200 ms",
    });
    assert.ok(performance.now() - startedAt < 4_000);
  });
});

suite('a real Keycloak', () => {
  test('signs people in through its clients with an ID token, gives a service account token, adds and disables keys, and relays a sign-out over back-channel logout', async (context) => {
    const keycloak = await startKeycloak();
    context.after(() => keycloak.remove());
    const logouts = await startRecordingServer(() => ({ status: 200 }));
    context.after(() => logouts.stop());
    const [ana] = DEFAULT_KEYCLOAK_REALM.people;
    assert.ok(ana);
    const keys = async (): Promise<readonly string[]> => {
      const set: unknown = await (
        await fetch(`${keycloak.issuer}/protocol/openid-connect/certs`)
      ).json();
      const listed: unknown =
        typeof set === 'object' && set !== null ? Reflect.get(set, 'keys') : [];
      return Array.isArray(listed)
        ? listed.map((key: unknown) =>
            String(
              typeof key === 'object' && key !== null
                ? Reflect.get(key, 'kid')
                : '',
            ),
          )
        : [];
    };

    const portal = await keycloak.signIn('portal-test', ana);
    const bare = await keycloak.signIn('bare-test', ana);
    const service = decodeJwt(await keycloak.serviceAccountToken('lyric-svc'));
    const added = await keycloak.addKey();
    const withAdded = await keys();
    await keycloak.disableKey(added);
    const withoutAdded = await keys();
    await keycloak.configureBackChannelLogout(
      'portal-test',
      new URL('backchannel-logout', logouts.url),
    );
    const signedIn = await keycloak.signIn('portal-test', ana);
    await keycloak.signOut('portal-test', signedIn.refreshToken);
    const [logout] = logouts.requests;
    const logoutToken = decodeJwt(
      new URLSearchParams(logout?.body ?? '').get('logout_token') ?? '',
    );
    const portalClaims = decodeJwt(portal.accessToken);
    const identity = decodeJwt(portal.idToken);

    assert.match(
      keycloak.issuer,
      /^http:\/\/127\.0\.0\.1:\d+\/realms\/usher-test$/u,
    );
    assert.equal(portalClaims.iss, keycloak.issuer);
    assert.equal(identity.iss, keycloak.issuer);
    assert.equal(identity.sub, portalClaims.sub);
    assert.ok([identity.aud].flat().includes('portal-test'));
    assert.ok([portalClaims.aud].flat().includes('arranger-test'));
    assert.ok(
      ![decodeJwt(bare.accessToken).aud].flat().includes('arranger-test'),
    );
    assert.ok((portalClaims.exp ?? 0) - (portalClaims.iat ?? 0) > 12 * 60);
    assert.equal(service['azp'], 'lyric-svc');
    assert.ok(withAdded.includes(added));
    assert.ok(!withoutAdded.includes(added));
    assert.equal(logout?.method, 'POST');
    assert.equal(logout?.target, '/backchannel-logout');
    assert.equal(logoutToken.iss, keycloak.issuer);
    assert.equal(logoutToken.sub, portalClaims.sub);
    assert.equal(typeof logoutToken['sid'], 'string');
    assert.deepEqual(logoutToken['events'], {
      'http://schemas.openid.net/event/backchannel-logout': {},
    });
  });

  test('takes connections at its issuer on 127.0.0.1 until removed, and refuses them there once removed', async () => {
    const keycloak = await startKeycloak();
    const issuer = new URL(keycloak.issuer);

    const whileRunning = await connection(issuer);
    await keycloak.remove();
    const onceRemoved = await connection(issuer);

    assert.deepEqual(
      { host: issuer.hostname, onceRemoved, whileRunning },
      {
        host: '127.0.0.1',
        onceRemoved: 'ECONNREFUSED',
        whileRunning: 'connected',
      },
    );
  });
});

suite('a real Keycloak holding the people the address suites look up', () => {
  test('lets the directory client look people up by exact address, issues management tokens, and disables and deletes accounts', async (context) => {
    const options = addressKeycloakRealm();
    const keycloak = await startKeycloak(options);
    context.after(() => keycloak.remove());
    const directory = keycloak.directoryFor('usher-directory');
    const token = await keycloak.serviceAccountToken(
      directory.directoryClientId,
    );
    const lookUp = async (
      email: string,
    ): Promise<readonly Readonly<Record<string, unknown>>[]> => {
      const response = await fetch(
        `${directory.directoryUrl}/admin/realms/${directory.directoryRealm}/users?exact=true&email=${encodeURIComponent(email)}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      assert.equal(response.status, 200);
      const found: unknown = await response.json();
      return Array.isArray(found) ? found : [];
    };
    const administrator = options.people.find(
      ({ username }) => username === 'admin.one@example.org',
    );
    assert.ok(administrator);

    const bo = await lookUp('sub.bo@example.org');
    const nearMiss = await lookUp('bo@example.org');
    const zoe = await lookUp('zoë@example.org');
    const plus = await lookUp('bo+ims@example.org');
    const una = await lookUp('una@example.org');
    const shared = await lookUp('dup@example.org');
    const disabled = await lookUp('disabled@example.org');
    const management = decodeJwt(
      (await keycloak.signIn('usher-ui-test', administrator)).accessToken,
    );
    await keycloak.disableUser('abo@example.org');
    const disabledNow = await lookUp('abo@example.org');
    await keycloak.deleteUser('bo.smith@example.org');
    const deleted = await lookUp('bo.smith@example.org');
    const administratorSubject = await keycloak.subject(
      'admin.one@example.org',
    );
    const added = await Promise.all(
      [
        'leaving@example.org',
        'outsider.cy@example.org',
        'owner.ana@example.org',
        'paused@example.org',
      ].map(async (email) => (await lookUp(email)).length),
    );

    assert.equal(directory.directoryRealm, 'overture');
    assert.equal(directory.directoryUrl, new URL(keycloak.issuer).origin);
    assert.deepEqual(
      bo.map(({ email, emailVerified }) => ({ email, emailVerified })),
      [{ email: 'sub.bo@example.org', emailVerified: true }],
    );
    assert.deepEqual(nearMiss, []);
    assert.equal(zoe.length, 1);
    assert.equal(plus.length, 1);
    assert.deepEqual(
      una.map(({ emailVerified }) => emailVerified),
      [false],
    );
    assert.equal(shared.length, 2);
    assert.deepEqual(
      disabled.map(({ enabled }) => enabled),
      [false],
    );
    assert.ok([management.aud].flat().includes('usher-management-test'));
    assert.equal(management['azp'], 'usher-ui-test');
    assert.ok(
      (
        Reflect.get(Object(management['realm_access']), 'roles') as unknown[]
      ).includes('usher-platform-admin'),
    );
    assert.deepEqual(
      disabledNow.map(({ enabled }) => enabled),
      [false],
    );
    assert.deepEqual(deleted, []);
    assert.equal(administratorSubject, management.sub);
    assert.deepEqual(added, [1, 1, 1, 1]);
  });
});
