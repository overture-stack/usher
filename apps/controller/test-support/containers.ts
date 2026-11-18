import { randomBytes, randomInt } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  request as httpRequest,
  type ServerResponse,
} from 'node:http';
import { connect, createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { finished } from 'node:stream/promises';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { ValkeyContainer } from '@testcontainers/valkey';
import {
  type ContainerRuntimeClient,
  GenericContainer,
  getContainerRuntimeClient,
  type StartedTestContainer,
  TestContainers,
  Wait,
} from 'testcontainers';

import type {
  RunningContainer,
  RunningContainers,
} from './containerEnvironment.js';
import type { ControllerConfiguration } from './controller.js';
import type { Cleanup } from './waiting.js';

// The global setup loads this module under Node's own type stripping, without tsx: it keeps to
// erasable syntax and imports no sibling's values.

/**
 * The PostgreSQL images a run can use, each an exact tag: the floor, the oldest major the Controller
 * supports, and the newest major released, for `pnpm test:newest`.
 */
export const POSTGRESQL_IMAGES = {
  floor: 'postgres:15.19',
  newest: 'postgres:18.6',
} as const;

/** The Valkey image every run uses, an exact tag. */
export const VALKEY_IMAGE = 'valkey/valkey:9.1.2';

/** The Keycloak image the tests needing a real one use, an exact tag of a current release. */
export const KEYCLOAK_IMAGE = 'quay.io/keycloak/keycloak:26.8.0';

/** Which PostgreSQL image a run uses, by its name in {@link POSTGRESQL_IMAGES}. */
export type PostgresqlSelection = keyof typeof POSTGRESQL_IMAGES;

/** The containers one run started, and how to stop them. */
export interface StartedContainers {
  containers: RunningContainers;

  /** Stops every container, settling once each has stopped. */
  stop(): Promise<void>;
}

/**
 * A container one test file started for itself, so that an outage it causes reaches no other file.
 * Its URL stays the same across a pause, a stop and a restart, since it holds one port on the Docker
 * host, from 30000 to 32767, for its whole life. Only the outage tests start one; every other test
 * uses the run's shared containers.
 */
export interface DedicatedContainer {
  container: RunningContainer;

  /** Freezes the container: connections stay open and nothing answers, until it is unpaused. */
  pause(): Promise<void>;

  /** Ends the container for good, unpausing it first if paused: the test file's cleanup. */
  remove(): Promise<void>;

  /**
   * Starts the container again after a stop, or restarts it while it runs, unpausing it first if
   * paused, and settles once it answers again at the same URL. A PostgreSQL keeps its data.
   */
  restart(): Promise<void>;

  /**
   * Stops the container at once, as a crash would, unpausing it first if paused, and keeps it for a
   * restart. Settles once its port refuses connections.
   */
  stop(): Promise<void>;

  /** Lets a paused container run again. */
  unpause(): Promise<void>;
}

const SUPERUSER = 'usher_superuser';

const POSTGRESQL_PORT = 5432;

const VALKEY_PORT = 6379;

const isSelection = (value: string): value is PostgresqlSelection =>
  Object.hasOwn(POSTGRESQL_IMAGES, value);

const postgresqlImage = (selection: string | undefined): string => {
  const chosen = selection ?? 'floor';
  if (isSelection(chosen)) {
    return POSTGRESQL_IMAGES[chosen];
  }
  throw new Error(
    `USHER_TEST_POSTGRESQL names one of ${Object.keys(POSTGRESQL_IMAGES).join(', ')}`,
  );
};

const randomPassword = (): string => randomBytes(24).toString('base64url');

// The hosts naming this machine's loopback, as a daemon reports where it publishes a container's ports.
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  '::1',
  '[::1]',
  'localhost',
]);

/** A PostgreSQL's superuser URL on this machine's loopback, and how to let go of what reaches it there. */
export interface LoopbackPostgresql {
  /** The relay standing between the URL and the PostgreSQL, for a daemon on another machine; none on this one. */
  relay: Relay | undefined;

  /** Stops the relay, if any; the PostgreSQL itself is left as it is. */
  stop(): Promise<void>;

  /** The superuser URL on loopback, its credentials and path kept. */
  url: string;
}

/**
 * Reaches a PostgreSQL on this machine's loopback, so every database URL the harness gives names a
 * loopback host, which the Controller connects to with no TLS verification required: at the URL given
 * where its host is loopback already, as for a daemon on this machine, and otherwise through a TCP
 * relay on `127.0.0.1` ({@link startRelay}), as Keycloak is reached against a daemon on another
 * machine.
 *
 * @param url the PostgreSQL's superuser URL, at the host the daemon publishes its port on.
 */
export const reachOnLoopback = async (
  url: string,
): Promise<LoopbackPostgresql> => {
  if (LOOPBACK_HOSTS.has(new URL(url).hostname)) {
    return { relay: undefined, stop: async () => undefined, url };
  }
  const relay = await startRelay(url);
  return { relay, stop: () => relay.stop(), url: relay.url };
};

/**
 * Starts one PostgreSQL and one Valkey, each with a password made for this run, the PostgreSQL's URL
 * on this machine's loopback ({@link reachOnLoopback}). A container that started is stopped again
 * when the other fails, so a failed start leaves nothing running.
 *
 * @param selection the PostgreSQL image's name in {@link POSTGRESQL_IMAGES}: `USHER_TEST_POSTGRESQL`,
 *   `floor` when unset.
 */
export const startContainers = async (
  selection: string | undefined = process.env['USHER_TEST_POSTGRESQL'],
): Promise<StartedContainers> => {
  const image = postgresqlImage(selection);
  const [postgresql, valkey] = await Promise.allSettled([
    new PostgreSqlContainer(image)
      .withDatabase('postgres')
      .withUsername(SUPERUSER)
      .withPassword(randomPassword())
      .start(),
    new ValkeyContainer(VALKEY_IMAGE).withPassword(randomPassword()).start(),
  ]);
  if (postgresql.status === 'fulfilled' && valkey.status === 'fulfilled') {
    const reached = await reachOnLoopback(
      postgresql.value.getConnectionUri(),
    ).catch(async (failure: unknown) => {
      await Promise.all([postgresql.value.stop(), valkey.value.stop()]);
      throw failure;
    });
    return {
      containers: {
        postgresql: { image, url: reached.url },
        valkey: { image: VALKEY_IMAGE, url: valkey.value.getConnectionUrl() },
      },
      stop: async () => {
        await reached.stop();
        await Promise.all([postgresql.value.stop(), valkey.value.stop()]);
      },
    };
  }
  const outcomes = [postgresql, valkey];
  await Promise.all(
    outcomes.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? [outcome.value.stop()] : [],
    ),
  );
  throw new AggregateError(
    outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason] : [],
    ),
    'the test containers did not start',
  );
};

// A dedicated container is published on one host port for its whole life, so its URL survives a
// restart, where Docker would otherwise assign a new port at each start. Docker releases that port
// while the container is stopped, so it is drawn from below 32768, where a Linux daemon's assigned
// ports and Linux's default ephemeral range begin (macOS's begins at 49152): a port in them can be
// taken meanwhile, by another container or as the source port of an outbound connection, and the
// restart then fails to bind it. The range is the part below 32768 that the CI Docker host admits.
const HOST_PORTS = { first: 30_000, last: 32_767 };

// How many ports are drawn before giving up, each reported taken by the daemon.
const HOST_PORT_ATTEMPTS = 20;

// "port is already allocated": a Linux daemon, the port held by another of its containers
// (daemon/libnetwork/portallocator/portallocator.go). "address already in use": a Linux daemon, the
// port held by another process on its host (daemon/libnetwork/portallocator/osallocator_linux.go), and
// Docker Desktop, the port held on this machine.
const HOST_PORT_TAKEN = /port is already allocated|address already in use/u;

/**
 * Whether a container's start failed because the daemon reports the host port asked for taken, which
 * a start on another port can get past. Every other failure says nothing a new port would change.
 *
 * @param error what the start threw.
 */
export const reportsHostPortTaken = (error: unknown): boolean =>
  error instanceof Error && HOST_PORT_TAKEN.test(error.message);

const startedWithin = async <Started>(
  start: (hostPort: number) => Promise<Started>,
  attempts: number,
): Promise<Started> => {
  try {
    return await start(randomInt(HOST_PORTS.first, HOST_PORTS.last + 1));
  } catch (error) {
    if (reportsHostPortTaken(error)) {
      if (attempts > 1) {
        return startedWithin(start, attempts - 1);
      }
      throw new Error(
        `no free host port in ${HOST_PORTS.first} to ${HOST_PORTS.last} after ${HOST_PORT_ATTEMPTS} attempts`,
        { cause: error },
      );
    }
    throw error;
  }
};

/**
 * Starts a container published on a fixed host port drawn at random from 30000 to 32767, drawing
 * another and starting again each time the daemon reports the port taken, up to 20 ports. The ports
 * are on the daemon's host, which may be another machine, so the daemon alone can say whether one is
 * free.
 *
 * @param start starts a container built afresh, published on the host port given: a builder's start
 *   changes the builder, so none is started twice.
 * @throws any failure but a port reported taken, at once; after the 20th port reported taken, an
 *   error saying so, whose cause is the daemon's last report.
 */
export const startOnFreeHostPort = <Started>(
  start: (hostPort: number) => Promise<Started>,
): Promise<Started> => startedWithin(start, HOST_PORT_ATTEMPTS);

type RuntimeContainer = ReturnType<
  ContainerRuntimeClient['container']['getById']
>;

// How long one probe of a stopped container's port waits, and how long the port may take to refuse.
const PROBE_WITHIN_MS = 500;

const REFUSED_WITHIN_MS = 60_000;

// Whether a connection to a URL is refused, or closed unanswered, rather than held open.
const refusesConnections = (url: URL): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    const timer = setTimeout(() => settle(false), PROBE_WITHIN_MS);
    const settle = (refused: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(refused);
    };
    socket.once('error', () => settle(true));
    socket.once('close', () => settle(true));
  });

// Docker's port forwarding can go on accepting connections for a moment after a container stops,
// holding each without an answer. An outage test needs a stopped server to refuse, as a stopped
// server does, so a stop settles only once its port refuses.
const untilRefused = async (url: URL, deadline: number): Promise<void> => {
  if (await refusesConnections(url)) {
    return;
  }
  if (performance.now() < deadline) {
    return untilRefused(url, deadline);
  }
  throw new Error(
    `${url.host} still accepts connections ${REFUSED_WITHIN_MS} ms after its container stopped`,
  );
};

const PASS_THROUGH: RelayMode = Object.freeze({ kind: 'pass' });

const REFUSE_ALL: RelayMode = Object.freeze({ kind: 'refuse' });

// A container of a test file's own, reached at its URL directly or through the relay given, which
// refuses connections while the container is stopped, as the container's own port then does.
const dedicated = (
  started: StartedTestContainer,
  container: RunningContainer,
  relay?: Relay,
): DedicatedContainer => {
  const state = { paused: false };
  const runtimeContainer = async (): Promise<RuntimeContainer> =>
    (await getContainerRuntimeClient()).container.getById(started.getId());
  const unpause = async (): Promise<void> => {
    if (state.paused) {
      await (await runtimeContainer()).unpause();
      state.paused = false;
    }
  };
  return {
    container,

    pause: async () => {
      await (await runtimeContainer()).pause();
      state.paused = true;
    },

    remove: async () => {
      await unpause();
      await relay?.stop();
      await started.stop();
    },

    restart: async () => {
      await unpause();
      await started.restart();
      await relay?.setMode(PASS_THROUGH);
    },

    stop: async () => {
      await unpause();
      await (
        await getContainerRuntimeClient()
      ).container.stop(await runtimeContainer(), { timeout: 0 });
      await relay?.setMode(REFUSE_ALL);
      await untilRefused(
        new URL(container.url),
        performance.now() + REFUSED_WITHIN_MS,
      );
    },

    unpause,
  };
};

/**
 * Starts a PostgreSQL for one test file's outage tests, or for a test needing many connections or a
 * server setting, apart from the run's shared one, with a superuser and a password of its own. Its
 * URL is its superuser's, on this machine's loopback as the shared one's is ({@link reachOnLoopback}),
 * and refuses connections while it is stopped. Its settings hold across a restart.
 *
 * @param selection the PostgreSQL image's name in {@link POSTGRESQL_IMAGES}: the run's own, from
 *   `USHER_TEST_POSTGRESQL`, by default.
 * @param options the server settings it starts with, such as `{ track_commit_timestamp: 'on' }`.
 */
export const startDedicatedPostgresql = async (
  selection: string | undefined = process.env['USHER_TEST_POSTGRESQL'],
  { settings = {} }: { settings?: Readonly<Record<string, string>> } = {},
): Promise<DedicatedContainer> => {
  const command = Object.entries(settings).flatMap(([name, value]) => [
    '-c',
    `${name}=${value}`,
  ]);
  const { postgresql } = await startedPostgresql(
    selection,
    command.length > 0 ? ['postgres', ...command] : undefined,
  );
  return postgresql;
};

// A dedicated PostgreSQL, started with the command given or the image's own, and the container it
// runs in, for support that runs a command inside it.
const startedPostgresql = async (
  selection: string | undefined,
  command: readonly string[] | undefined,
): Promise<{
  postgresql: DedicatedContainer;
  started: StartedTestContainer;
}> => {
  const image = postgresqlImage(selection);
  const started = await startOnFreeHostPort((hostPort) => {
    const container = new PostgreSqlContainer(image);
    return (
      command === undefined ? container : container.withCommand([...command])
    )
      .withExposedPorts({ container: POSTGRESQL_PORT, host: hostPort })
      .withDatabase('postgres')
      .withUsername(SUPERUSER)
      .withPassword(randomPassword())
      .start();
  });
  const reached = await reachOnLoopback(started.getConnectionUri()).catch(
    async (failure: unknown) => {
      await started.stop();
      throw failure;
    },
  );
  return {
    postgresql: dedicated(started, { image, url: reached.url }, reached.relay),
    started,
  };
};

/** The CA certificates a TLS-enabled PostgreSQL's server certificate is judged against, each as PEM text. */
export interface TestCaCertificates {
  /** The CA certificate the server's certificate was issued under. */
  issued: string;

  /**
   * The same CA's certificate reissued, as a CA's renewal makes it: its name and key kept, its serial
   * number and validity new, so the server's certificate chains to it as to the one it replaces.
   */
  reissued: string;

  /** Another CA's certificate, of the same name and a key of its own, to which the server's certificate does not chain. */
  unrelated: string;
}

/** A PostgreSQL of a test file's own serving TLS, and the CA certificates its server certificate is judged against. */
export interface TlsPostgresql {
  certificates: TestCaCertificates;
  postgresql: DedicatedContainer;
}

// Where the container keeps what it generates. Its private keys never leave it.
const TLS_FOLDER = '/var/lib/postgresql/tls';

const CA_FILES = {
  issued: `${TLS_FOLDER}/issued.crt`,
  reissued: `${TLS_FOLDER}/reissued.crt`,
  unrelated: `${TLS_FOLDER}/unrelated.crt`,
} as const;

// Generates the certificates with the image's own openssl, once, as the container first starts, so a
// restart keeps them, then starts the server through the image's entrypoint with TLS on. Each is valid
// from a day before the container's clock, so a clock a little behind the container's accepts them.
// The server's certificate names every loopback host the harness connects through.
const TLS_STARTUP = `set -e
mkdir -p ${TLS_FOLDER}
cd ${TLS_FOLDER}
if [ ! -f server.crt ]; then
  from=$(date -u -d '1 day ago' +%Y%m%d%H%M%SZ)
  until=$(date -u -d '2 days' +%Y%m%d%H%M%SZ)
  later=$(date -u -d '3 days' +%Y%m%d%H%M%SZ)
  curve='-newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes'
  openssl req -x509 -new $curve -keyout ca-private.pem -out issued.crt -subj '/CN=Usher test CA' -set_serial 1 -not_before "$from" -not_after "$until"
  openssl req -x509 -new -key ca-private.pem -out reissued.crt -subj '/CN=Usher test CA' -set_serial 2 -not_before "$from" -not_after "$later"
  openssl req -x509 -new $curve -keyout unrelated-private.pem -out unrelated.crt -subj '/CN=Usher test CA' -set_serial 3 -not_before "$from" -not_after "$until"
  openssl req -new $curve -keyout server-private.pem -out server.csr -subj '/CN=localhost'
  printf 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\\nbasicConstraints=CA:FALSE\\nextendedKeyUsage=serverAuth\\n' > server.ext
  openssl x509 -req -in server.csr -CA issued.crt -CAkey ca-private.pem -set_serial 10 -not_before "$from" -not_after "$until" -extfile server.ext -out server.crt
  chown postgres:postgres server.crt server-private.pem
  chmod 600 server-private.pem
fi
exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=${TLS_FOLDER}/server.crt -c ssl_key_file=${TLS_FOLDER}/server-private.pem`;

const fileIn = async (
  started: StartedTestContainer,
  path: string,
): Promise<string> => {
  const { exitCode, stdout } = await started.exec(['cat', path]);
  if (exitCode === 0) {
    return stdout;
  }
  throw new Error(`the TLS-enabled PostgreSQL holds no ${path}`);
};

/**
 * Starts a PostgreSQL for one test file's own, as {@link startDedicatedPostgresql} does, serving TLS
 * beside plain connections, its server certificate issued under a CA generated in the container by
 * the image's own openssl, and gives that CA's certificate, the same CA's reissued, and an unrelated
 * CA's. The server's certificate names `localhost`, `127.0.0.1` and `::1`, so a connection verifying
 * it in full through the PostgreSQL's loopback URL succeeds.
 *
 * @param selection the PostgreSQL image's name in {@link POSTGRESQL_IMAGES}: the run's own, from
 *   `USHER_TEST_POSTGRESQL`, by default.
 */
export const startTlsPostgresql = async (
  selection: string | undefined = process.env['USHER_TEST_POSTGRESQL'],
): Promise<TlsPostgresql> => {
  const { postgresql, started } = await startedPostgresql(selection, [
    'sh',
    '-c',
    TLS_STARTUP,
  ]);
  try {
    const [issued, reissued, unrelated] = await Promise.all([
      fileIn(started, CA_FILES.issued),
      fileIn(started, CA_FILES.reissued),
      fileIn(started, CA_FILES.unrelated),
    ]);
    return { certificates: { issued, reissued, unrelated }, postgresql };
  } catch (failure) {
    await postgresql.remove();
    throw failure;
  }
};

/** Starts a Valkey for one test file's outage tests, apart from the run's shared one, with a password of its own. */
export const startDedicatedValkey = async (): Promise<DedicatedContainer> => {
  const started = await startOnFreeHostPort((hostPort) =>
    new ValkeyContainer(VALKEY_IMAGE)
      .withExposedPorts({ container: VALKEY_PORT, host: hostPort })
      .withPassword(randomPassword())
      .start(),
  );
  return dedicated(started, {
    image: VALKEY_IMAGE,
    url: started.getConnectionUrl(),
  });
};

/** A reply in the cache's protocol (RESP2): a status or bulk string, an integer, nil, an error, or a list. */
export type CacheReply =
  number | string | null | { error: string } | readonly CacheReply[];

/** How long a cache connection waits to connect, and for each reply, before it fails. */
export const CACHE_REPLY_TIMEOUT_MS = 5000;

const LINE_END = '\r\n';

interface ParsedReply {
  next: number;
  reply: CacheReply;
}

const encodedCommand = (command: readonly string[]): string =>
  `*${command.length}${LINE_END}${command
    .map((part) => `$${Buffer.byteLength(part)}${LINE_END}${part}${LINE_END}`)
    .join('')}`;

const bulkAt = (
  buffer: Buffer,
  start: number,
  length: number,
): ParsedReply | undefined => {
  if (length < 0) {
    return { next: start, reply: null };
  }
  return buffer.length < start + length + LINE_END.length
    ? undefined
    : {
        next: start + length + LINE_END.length,
        reply: buffer.toString('utf8', start, start + length),
      };
};

const elementsAt = (
  buffer: Buffer,
  start: number,
  remaining: number,
  held: readonly CacheReply[],
): ParsedReply | undefined => {
  if (remaining < 0) {
    return { next: start, reply: null };
  }
  if (remaining === 0) {
    return { next: start, reply: held };
  }
  const element = replyAt(buffer, start);
  return element === undefined
    ? undefined
    : elementsAt(buffer, element.next, remaining - 1, [...held, element.reply]);
};

const replyAt = (buffer: Buffer, start: number): ParsedReply | undefined => {
  const end = buffer.indexOf(LINE_END, start);
  if (end < 0) {
    return undefined;
  }
  const kind = buffer.toString('latin1', start, start + 1);
  const line = buffer.toString('utf8', start + 1, end);
  const after = end + LINE_END.length;
  switch (kind) {
    case '+':
      return { next: after, reply: line };
    case '-':
      return { next: after, reply: { error: line } };
    case ':':
      return { next: after, reply: Number(line) };
    case '$':
      return bulkAt(buffer, after, Number(line));
    case '*':
      return elementsAt(buffer, after, Number(line), []);
    default:
      throw new Error(`a reply of an unknown kind, ${kind}`);
  }
};

const repliesIn = (
  buffer: Buffer,
  read: readonly CacheReply[],
): { rest: Buffer; replies: readonly CacheReply[] } => {
  const parsed = replyAt(buffer, 0);
  return parsed === undefined
    ? { replies: read, rest: buffer }
    : repliesIn(buffer.subarray(parsed.next), [...read, parsed.reply]);
};

/** A connection of a test's own to a cache, speaking its protocol (RESP2). */
export interface CacheConnection {
  /** Ends the connection, settling once it has closed. */
  close(): Promise<void>;

  /** Every reply received so far, in order, those no command asked for included, such as a subscription's messages. */
  replies(): readonly CacheReply[];

  /**
   * Sends a command and gives the first reply received after it.
   *
   * @throws when the connection ends, closes or fails before that reply, or it takes longer than the
   *   connection's timeout.
   */
  send(command: readonly string[]): Promise<CacheReply>;

  /**
   * Settles once the replies meet a condition.
   *
   * @throws naming what was awaited, when the connection ends, closes or fails first, or it takes
   *   longer than the connection's timeout.
   */
  until(
    condition: (replies: readonly CacheReply[]) => boolean,
    what: string,
  ): Promise<void>;
}

const connectedSocket = (url: URL, timeoutMs: number): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    const failed = (error: Error): void => {
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      socket.off('error', failed);
      socket.destroy();
      reject(
        new Error(`the cache accepted no connection within ${timeoutMs} ms`),
      );
    }, timeoutMs);
    socket.once('error', failed);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.off('error', failed);
      resolve(socket);
    });
  });

/**
 * Opens a connection to a cache, signing in with the credentials its URL carries. Every wait on it, a
 * reply or a condition, fails as soon as the connection ends, closes or fails, and after the timeout
 * otherwise, so a cache that goes away fails the test rather than hanging it.
 *
 * @param cacheUrl the cache's URL, credentials included, as `containers.ts` gives it.
 * @param timeoutMs how long to wait to connect, and for each reply: {@link CACHE_REPLY_TIMEOUT_MS} by
 *   default.
 * @throws when the cache refuses the connection or the credentials.
 */
export const openCacheConnection = async (
  cacheUrl: string,
  timeoutMs: number = CACHE_REPLY_TIMEOUT_MS,
): Promise<CacheConnection> => {
  const url = new URL(cacheUrl);
  const socket = await connectedSocket(url, timeoutMs);
  const state: {
    buffer: Buffer;
    ended: string | undefined;
    replies: readonly CacheReply[];
  } = { buffer: Buffer.alloc(0), ended: undefined, replies: [] };
  const listeners = new Set<() => void>();
  const changed = (): void => {
    [...listeners].forEach((listener) => listener());
  };
  const endedWith = (why: string): void => {
    state.ended ??= why;
    changed();
  };
  socket.on('data', (chunk: Buffer) => {
    try {
      const { replies, rest } = repliesIn(
        Buffer.concat([state.buffer, chunk]),
        state.replies,
      );
      state.buffer = rest;
      state.replies = replies;
      changed();
    } catch (error) {
      socket.destroy();
      endedWith(
        `was closed on ${error instanceof Error ? error.message : 'an unreadable reply'}`,
      );
    }
  });
  socket.on('error', (error) => endedWith(`failed: ${error.message}`));
  socket.on('end', () => endedWith('was ended by the cache'));
  socket.on('close', () => endedWith('closed'));
  const until = (
    condition: (replies: readonly CacheReply[]) => boolean,
    what: string,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      const settle = (done: () => void): void => {
        clearTimeout(timer);
        listeners.delete(check);
        done();
      };
      const check = (): void => {
        if (condition(state.replies)) {
          settle(resolve);
        } else if (state.ended !== undefined) {
          const why = state.ended;
          settle(() =>
            reject(new Error(`the cache connection ${why} before ${what}`)),
          );
        }
      };
      const timer = setTimeout(() => {
        settle(() =>
          reject(new Error(`${what} did not come within ${timeoutMs} ms`)),
        );
      }, timeoutMs);
      listeners.add(check);
      check();
    });
  const send = async (command: readonly string[]): Promise<CacheReply> => {
    const position = state.replies.length;
    socket.write(encodedCommand(command));
    await until(
      (replies) => replies.length > position,
      `the cache's answer to ${command[0] ?? 'a command'}`,
    );
    return state.replies[position] ?? null;
  };
  const close = (): Promise<void> =>
    socket.destroyed
      ? Promise.resolve()
      : new Promise((resolve) => {
          socket.once('close', () => resolve());
          socket.destroy();
        });
  const password = decodeURIComponent(url.password);
  const username = decodeURIComponent(url.username);
  const signedIn =
    password.length === 0
      ? 'OK'
      : await send(
          username.length > 0
            ? ['AUTH', username, password]
            : ['AUTH', password],
        ).catch(async (error: unknown) => {
          await close();
          throw error;
        });
  if (signedIn !== 'OK') {
    await close();
    throw new Error('the cache refused the credentials its URL carries');
  }
  return { close, replies: () => state.replies, send, until };
};

/**
 * Removes every key a cache holds (`FLUSHALL`), over a connection of its own signed in with the
 * credentials its URL carries: so a test starts on an empty cache (#215 Q1). Flush only a cache of the
 * test file's own, never the run's shared one, which every other file is using.
 *
 * @param cacheUrl the cache's URL, as `containers.ts` gives it.
 * @throws when the cache refuses the connection, the credentials or the flush, or the connection ends,
 *   closes or fails before the cache answers, or the answer takes longer than
 *   {@link CACHE_REPLY_TIMEOUT_MS}.
 */
export const flushValkey = async (cacheUrl: string): Promise<void> => {
  const connection = await openCacheConnection(cacheUrl);
  try {
    if ((await connection.send(['FLUSHALL'])) !== 'OK') {
      throw new Error('the cache refused the flush');
    }
  } finally {
    await connection.close();
  }
};

/**
 * A Valkey a suite's tests share, started by the first test asking for it and removed once the
 * suite's tests have ended, and flushed for each test asking: so each test runs on an empty cache
 * without flushing the run's shared Valkey (#215 Q1). Call it in the suite's body.
 *
 * @param scope the suite's cleanup, from `waiting.ts`'s `suiteCleanup`, which removes the Valkey.
 * @returns a function giving the Valkey's URL once it has been flushed.
 */
export const suiteFlushedCache = (scope: Cleanup): (() => Promise<string>) => {
  const state: { starting: Promise<DedicatedContainer> | undefined } = {
    starting: undefined,
  };
  scope.defer(async () => {
    const started = await state.starting?.catch(() => undefined);
    await started?.remove();
  });
  return async () => {
    const starting =
      state.starting ??
      startDedicatedValkey().catch((error: unknown) => {
        state.starting = undefined;
        throw error;
      });
    state.starting = starting;
    const { url } = (await starting).container;
    await flushValkey(url);
    return url;
  };
};

/** One message published on a cache, as a watch received it. */
export interface CacheMessage {
  channel: string;
  payload: string;
}

/** What was published on a cache since a watch began. */
export interface CacheWatch {
  /**
   * Publishes a mark of the watch's own and settles once the watch has received it, giving its
   * position among the messages received: the cache delivers what it receives in order, so every
   * message published before the mark was sent sits before it.
   */
  mark(): Promise<number>;

  /** Every message received, in order, the watch's marks included. */
  messages(): readonly CacheMessage[];
}

/**
 * Watches every channel of a cache through a subscription of the test's own (`PSUBSCRIBE *`), as an
 * instance waiting for wake-ups does (`architecture.md`: a wake-up is published on Valkey's pub/sub
 * after a notice is written), with a second connection publishing its marks. Both connections end with
 * the test's cleanup. The cache must be the test's own, since every other test's Controller publishes
 * on the run's shared one.
 *
 * @param scope the cleanup ending its connections.
 * @param cacheUrl the cache's URL, credentials included.
 * @throws when the cache refuses the subscription.
 */
export const watchCache = async (
  scope: Cleanup,
  cacheUrl: string,
): Promise<CacheWatch> => {
  const subscriber = await openCacheConnection(cacheUrl);
  scope.defer(() => subscriber.close());
  const publisher = await openCacheConnection(cacheUrl);
  scope.defer(() => publisher.close());
  const subscribed = await subscriber.send(['PSUBSCRIBE', '*']);
  if (JSON.stringify(subscribed) !== JSON.stringify(['psubscribe', '*', 1])) {
    throw new Error('the cache refused the subscription to every channel');
  }
  const markChannel = `usher-test-mark-${randomBytes(6).toString('hex')}`;
  const messagesIn = (
    replies: readonly CacheReply[],
  ): readonly CacheMessage[] =>
    replies.flatMap((reply) =>
      Array.isArray(reply) &&
      reply[0] === 'pmessage' &&
      typeof reply[2] === 'string' &&
      typeof reply[3] === 'string'
        ? [{ channel: reply[2], payload: reply[3] }]
        : [],
    );
  return {
    mark: async () => {
      const payload = randomBytes(6).toString('hex');
      const position = (replies: readonly CacheReply[]): number =>
        messagesIn(replies).findIndex(
          (message) =>
            message.channel === markChannel && message.payload === payload,
        );
      await publisher.send(['PUBLISH', markChannel, payload]);
      await subscriber.until(
        (replies) => position(replies) >= 0,
        "the watch's own mark",
      );
      return position(subscriber.replies());
    },
    messages: () => messagesIn(subscriber.replies()),
  };
};

/**
 * How a relay treats traffic:
 * - pass it;
 * - refuse it: a connection refused, or for one HTTP path, each request closed unanswered. What is
 *   already open goes on as it was, a stream already answered included;
 * - close it: what is already open closed, a stream included, and from then on refused as `refuse`
 *   refuses it;
 * - freeze it: the connection held open and nothing forwarded, until a mode other than freeze lets it
 *   go on, an HTTP request held since its arrival forwarded then;
 * - reset it: what is open reset, and every connection or request from then on reset;
 * - delay it: for TCP, each chunk forwarded the given milliseconds late; for HTTP, the request
 *   forwarded at once and the answer's start held that long after the server gave it;
 * - pace it: each chunk forwarded no sooner than the given milliseconds after the one before it, for
 *   HTTP the answer's body, such as a stream's events;
 * - answer with a status, HTTP alone: each request from then on answered that status with an empty
 *   body, never forwarded.
 */
export type RelayMode =
  | { kind: 'close' }
  | { kind: 'delay'; ms: number }
  | { kind: 'freeze' }
  | { kind: 'pace'; ms: number }
  | { kind: 'pass' }
  | { kind: 'refuse' }
  | { kind: 'reset' }
  | { kind: 'status'; status: number };

/**
 * The paths the Bridge reaches the Controller at, relative to the Controller's URL, which an HTTP
 * relay treats one by one. They are the Bridge's own: follows `controllerClient.ts`, `poll.ts` and
 * `push.ts`.
 */
export const RELAYED_PATHS = Object.freeze({
  exchange: 'exchange',
  notices: 'notices',
  stream: 'notices/stream',
} as const);

/** A loopback relay to a server, through which a test causes network faults one client meets. */
export interface Relay {
  /** Resets every connection through it and refuses new ones: what cutting one client off does. */
  cut(): Promise<void>;

  /**
   * Sets how the relay treats traffic from now on, connections and answers already open included. For
   * an HTTP relay, a path given narrows it to the requests for that path alone: one of
   * {@link RELAYED_PATHS}, relative to the relay's URL as the Bridge resolves it, or an absolute path
   * such as `/notices/stream`. The latest mode set wins: a mode for every path replaces each path's
   * own, and a path's own set after it wins for that path. The relay stops listening, so a connection
   * is refused, only while the mode for every path refuses or closes and no path's own lets anything
   * through. A TCP relay has no paths, and answers no status.
   */
  setMode(mode: RelayMode, path?: string): Promise<void>;

  /** Points every connection or request from now on at another server, such as another Controller instance. */
  setTarget(target: string): void;

  /** Ends every connection and the relay itself, settling once both are done. */
  stop(): Promise<void>;

  /** The target's URL with the relay's host and port in its place, credentials and path kept. */
  url: string;
}

interface RelayState {
  /** The first target's URL, whose path an HTTP relay resolves a relative path against. */
  base: URL;

  closed: boolean;

  /** The mode for every path under the empty path, and each path's own under its absolute path. */
  modes: ReadonlyMap<string, RelayMode>;

  target: URL;
}

const PASS: RelayMode = Object.freeze({ kind: 'pass' });

const shutsOut = (mode: RelayMode): boolean =>
  mode.kind === 'refuse' || mode.kind === 'close';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const listening = (server: Server, port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });

const closedServer = (server: Server): Promise<void> =>
  server.listening
    ? new Promise((resolve) => {
        server.close(() => resolve());
      })
    : Promise.resolve();

// Each chunk's write is chained after the one before it, which keeps the order whatever the mode;
// the chain settles once every chunk received has been written.
const forwarded = (
  from: Socket,
  to: Socket,
  mode: () => RelayMode,
): { drained(): Promise<void> } => {
  const chain = { last: Promise.resolve() };
  from.on('data', (chunk: Buffer) => {
    const current = mode();
    const wait = current.kind === 'delay' ? sleep(current.ms) : undefined;
    chain.last = chain.last.then(async () => {
      await wait;
      to.write(chunk);
      if (current.kind === 'pace') {
        await sleep(current.ms);
      }
    });
  });
  from.on('end', () => {
    void chain.last.then(() => to.end());
  });
  return { drained: () => chain.last };
};

const tcpRelay = async (state: RelayState): Promise<Relay> => {
  const pairs = new Set<readonly [Socket, Socket]>();
  const mode = (): RelayMode => state.modes.get('') ?? PASS;
  const server = createServer((incoming) => {
    const current = mode();
    if (current.kind === 'reset') {
      incoming.resetAndDestroy();
      return;
    }
    const outgoing = connect({
      host: state.target.hostname,
      port: Number(state.target.port),
    });
    const pair = [incoming, outgoing] as const;
    pairs.add(pair);
    const toOutgoing = forwarded(incoming, outgoing, mode);
    const toIncoming = forwarded(outgoing, incoming, mode);
    // A side that closes leaves the other open until what was received for it, held by a delay or a
    // pace, has been written.
    const closing = [
      [incoming, outgoing, toOutgoing],
      [outgoing, incoming, toIncoming],
    ] as const;
    closing.forEach(([socket, other, toOther]) => {
      socket.on('error', () => socket.destroy());
      socket.once('close', () => {
        pairs.delete(pair);
        void toOther.drained().then(() => other.destroy());
      });
    });
    if (current.kind === 'freeze') {
      pair.forEach((socket) => socket.pause());
    }
  });
  const port = await listening(server, 0);
  const setMode = async (next: RelayMode): Promise<void> => {
    if (next.kind === 'status') {
      throw new TypeError('a TCP relay answers no status: start an HTTP relay');
    }
    state.modes = new Map([['', next]]);
    [...pairs].forEach((pair) => {
      if (next.kind === 'reset') {
        pair.forEach((socket) => socket.resetAndDestroy());
        return;
      }
      if (next.kind === 'close') {
        pair.forEach((socket) => socket.destroy());
        return;
      }
      pair.forEach((socket) =>
        next.kind === 'freeze' ? socket.pause() : socket.resume(),
      );
    });
    if (shutsOut(next)) {
      await closedServer(server);
      return;
    }
    if (!server.listening && !state.closed) {
      await listening(server, port);
    }
  };
  return relayFor(state, port, setMode, async () => {
    state.closed = true;
    [...pairs].forEach((pair) => pair.forEach((socket) => socket.destroy()));
    await closedServer(server);
  });
};

interface HttpExchange {
  path: string;
  request: IncomingMessage;

  /** Lets a frozen request or answer go on, once a mode other than freeze applies to its path. */
  thaw: (() => void) | undefined;
}

const httpRelay = async (state: RelayState): Promise<Relay> => {
  const exchanges = new Set<HttpExchange>();
  const modeFor = (path: string): RelayMode =>
    state.modes.get(path) ?? state.modes.get('') ?? PASS;
  const unfrozen = (exchange: HttpExchange): Promise<void> =>
    modeFor(exchange.path).kind === 'freeze'
      ? new Promise((resolve) => {
          exchange.thaw = resolve;
        })
      : Promise.resolve();
  const forwardAnswer = async (
    exchange: HttpExchange,
    answer: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const atStart = modeFor(exchange.path);
    if (atStart.kind === 'delay') {
      await sleep(atStart.ms);
    }
    await unfrozen(exchange);
    response.writeHead(answer.statusCode ?? 502, answer.headers);
    response.flushHeaders();
    // Each chunk is taken as it arrives and its write chained after the one before it, as the TCP
    // relay's are: a loop reading the answer would find the chunks sent during a pace buffered as one.
    const chain = { last: Promise.resolve() };
    answer.on('data', (chunk: Buffer) => {
      chain.last = chain.last.then(async () => {
        await unfrozen(exchange);
        response.write(chunk);
        const current = modeFor(exchange.path);
        if (current.kind === 'pace') {
          await sleep(current.ms);
        }
      });
    });
    await finished(answer);
    await chain.last;
    response.end();
  };
  const forward = (exchange: HttpExchange, response: ServerResponse): void => {
    const { request } = exchange;
    const upstream = httpRequest(
      {
        headers: { ...request.headers, host: state.target.host },
        host: state.target.hostname,
        method: request.method,
        path: request.url,
        port: Number(state.target.port),
      },
      (answer) => {
        forwardAnswer(exchange, answer, response).catch(() =>
          response.destroy(),
        );
      },
    );
    upstream.on('error', () => response.destroy());
    response.once('close', () => upstream.destroy());
    request.pipe(upstream);
  };
  // A request is handled by the mode its path has once it is no longer held: a request frozen since
  // its arrival meets the mode that let it go on.
  const handle = (exchange: HttpExchange, response: ServerResponse): void => {
    const current = modeFor(exchange.path);
    switch (current.kind) {
      case 'close':
      case 'refuse':
        exchange.request.socket.destroy();
        return;
      case 'reset':
        exchange.request.socket.resetAndDestroy();
        return;
      case 'status':
        response.writeHead(current.status, { 'content-length': '0' });
        response.end();
        return;
      default:
        forward(exchange, response);
    }
  };
  const proxy = (request: IncomingMessage, response: ServerResponse): void => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const exchange: HttpExchange = { path, request, thaw: undefined };
    exchanges.add(exchange);
    response.once('close', () => exchanges.delete(exchange));
    void unfrozen(exchange).then(() => handle(exchange, response));
  };
  const server = createHttpServer(proxy);
  const port = await listening(server, 0);
  const pathOf = (path: string | undefined): string =>
    path === undefined || path.startsWith('/')
      ? (path ?? '')
      : new URL(path, state.base).pathname;
  const shutOut = (): boolean =>
    shutsOut(state.modes.get('') ?? PASS) &&
    [...state.modes].every(([path, mode]) => path === '' || shutsOut(mode));
  const setMode = async (next: RelayMode, given?: string): Promise<void> => {
    const path = pathOf(given);
    state.modes =
      path === ''
        ? new Map([['', next]])
        : new Map([...state.modes, [path, next]]);
    [...exchanges]
      .filter((exchange) => path === '' || exchange.path === path)
      .forEach((exchange) => {
        if (next.kind === 'reset') {
          exchange.request.socket.resetAndDestroy();
          return;
        }
        if (next.kind === 'close') {
          exchange.request.socket.destroy();
          return;
        }
        if (modeFor(exchange.path).kind !== 'freeze') {
          const { thaw } = exchange;
          exchange.thaw = undefined;
          thaw?.();
        }
      });
    if (shutOut()) {
      await closedServer(server);
      return;
    }
    if (!server.listening && !state.closed) {
      await listening(server, port);
    }
  };
  return relayFor(state, port, setMode, async () => {
    state.closed = true;
    server.closeAllConnections();
    await closedServer(server);
  });
};

const relayFor = (
  state: RelayState,
  port: number,
  setMode: (mode: RelayMode, path?: string) => Promise<void>,
  stop: () => Promise<void>,
): Relay => {
  const relayed = new URL(state.target);
  relayed.hostname = '127.0.0.1';
  relayed.port = String(port);
  return {
    cut: async () => {
      await setMode({ kind: 'reset' });
      await setMode({ kind: 'refuse' });
    },
    setMode,
    setTarget: (target) => {
      state.target = new URL(target);
    },
    stop,
    url: relayed.href,
  };
};

/**
 * Starts a loopback relay to a server: plain TCP, such as a Valkey's, or HTTP, aware of each
 * request's path, such as the Controller's, between it and the Bridge. Every network fault a test
 * causes goes through one, so the test cuts one client off without touching the server the others
 * use.
 *
 * @param target the server's URL.
 * @param options `http` for a relay aware of paths: `tcp` by default.
 */
export const startRelay = (
  target: string,
  { protocol = 'tcp' }: { protocol?: 'http' | 'tcp' } = {},
): Promise<Relay> => {
  const state: RelayState = {
    base: new URL(target),
    closed: false,
    modes: new Map(),
    target: new URL(target),
  };
  return protocol === 'http' ? httpRelay(state) : tcpRelay(state);
};

/** A person a Keycloak realm holds, with a password the test made up. */
export interface KeycloakPerson {
  email: string;

  /** Whether the address is verified: true by default. */
  emailVerified?: boolean;

  /** Whether the account is enabled: true by default. */
  enabled?: boolean;

  /**
   * The given name: `Synthetic` by default, none when `null`. A person with no names may be refused a
   * direct access grant under Keycloak's default user profile, so give names to anyone signing in.
   */
  firstName?: string | null;

  /** The family name: `Person` by default, none when `null`. */
  lastName?: string | null;

  password: string;

  /** Realm roles beside Keycloak's defaults, such as the first-user role. */
  realmRoles?: readonly string[];

  username: string;
}

/** One client of a Keycloak realm. */
export interface KeycloakClient {
  /** The audiences its access tokens carry beside Keycloak's own, through an audience mapper each. */
  audiences: readonly string[];

  clientId: string;

  /**
   * The `realm-management` roles its service account holds, such as `view-users` and `query-users` for
   * the Controller's directory; none by default.
   */
  directoryRoles?: readonly string[];

  /** A confidential client's secret, which also gives it a service account; a public client when absent. */
  secret?: string;
}

/** What a Keycloak realm is set up with. */
export interface KeycloakRealmOptions {
  /** How long an access token lives, in seconds: 900 by default, over the 12 minutes a test may span. */
  accessTokenLifespanSeconds?: number;

  clients: readonly KeycloakClient[];

  /** Whether several accounts may hold one address, which also turns off signing in by address: false by default. */
  duplicateEmailsAllowed?: boolean;

  people: readonly KeycloakPerson[];
  realm: string;

  /** Realm roles the realm defines, such as the first-user role. */
  realmRoles?: readonly string[];
}

/** What the Controller's directory is configured with to read a Keycloak realm's users. */
export type KeycloakDirectory = Pick<
  ControllerConfiguration,
  | 'directoryClientId'
  | 'directoryClientSecret'
  | 'directoryRealm'
  | 'directoryUrl'
>;

/** A current Keycloak in a container, holding one realm. */
export interface KeycloakRealm {
  /** Generates an RS256 signing key in the realm, active and published, and gives its `kid`. */
  addKey(): Promise<string>;

  /**
   * Sets a client's back-channel logout URL to a URL on the host, reached from the container through
   * Testcontainers' host access, with "session required" on.
   */
  configureBackChannelLogout(clientId: string, hostUrl: URL): Promise<void>;

  /** Deletes a person's account, by username, while the test runs. */
  deleteUser(username: string): Promise<void>;

  /** The configuration fields pointing the Controller's directory at this realm through a client's service account. */
  directoryFor(clientId: string): KeycloakDirectory;

  /** Disables a key, so the realm neither signs with it nor publishes it. */
  disableKey(kid: string): Promise<void>;

  /** Disables a person's account, by username, while the test runs. */
  disableUser(username: string): Promise<void>;

  /** The realm's issuer, an http URL on a loopback host, as its tokens carry it. */
  issuer: string;

  /** Ends the container and the relay it is reached through, so its issuer refuses connections. */
  remove(): Promise<void>;

  /** A confidential client's service account token, through the client credentials grant. */
  serviceAccountToken(clientId: string): Promise<string>;

  /**
   * Signs a person in through the client's direct access grant, as Keycloak's own login does, with
   * the `openid` scope: the access token, the ID token and the refresh token of that one login.
   */
  signIn(
    clientId: string,
    person: KeycloakPerson,
  ): Promise<{ accessToken: string; idToken: string; refreshToken: string }>;

  /** Signs the session out through Keycloak's logout endpoint, as a person signing out does. */
  signOut(clientId: string, refreshToken: string): Promise<void>;

  /**
   * A person's subject, by username: the id of their account, which the realm's access tokens carry
   * as `sub` and its directory names them by. Read from the realm's admin API, so it needs no
   * directory client and no sign-in.
   */
  subject(username: string): Promise<string>;
}

/**
 * The realm the tests needing a real Keycloak use by default: `usher-test`, with `portal-test`, a
 * public client whose tokens name `arranger-test`; `bare-test`, one naming no audience of ours;
 * `lyric-svc`, a confidential client with a service account; and Ana at example.org.
 */
export const DEFAULT_KEYCLOAK_REALM: KeycloakRealmOptions = Object.freeze({
  clients: [
    { audiences: ['arranger-test'], clientId: 'portal-test' },
    { audiences: [], clientId: 'bare-test' },
    { audiences: [], clientId: 'lyric-svc', secret: randomPassword() },
  ],
  people: [
    {
      email: 'ana@example.org',
      password: randomPassword(),
      username: 'ana@example.org',
    },
  ],
  realm: 'usher-test',
});

/**
 * A realm for the suites resolving addresses (#212, #213): realm `overture`; a public client issuing
 * management tokens, its `azp` a management client and an audience mapper naming the management API;
 * `usher-directory`, a confidential client whose service account may view and query users, for the
 * Controller's directory; and people at example.org: Bo verified (`sub.bo@`), his near misses
 * (`bo.smith@`, `abo@`), non-ASCII text (`zoë@`), plus-addressing (`bo+ims@`), an unverified address
 * (`una@`), a disabled account (`disabled@`), two accounts sharing `dup@` (the realm allowing it), an
 * administrator (`admin.one@`) holding the first-user role, an owner (`owner.ana@`) and an outsider
 * (`outsider.cy@`) for the grants suites, and two accounts a test disables (`paused@`) or deletes
 * (`leaving@`) while it runs, each its own so a realm a suite shares stays as imported for every other
 * test. Usernames are the addresses, the two sharing one apart.
 *
 * @param options the first-user role, the management API's audience and client, and the realm's
 *   name, each the harness's by default.
 */
export const addressKeycloakRealm = ({
  firstUserRole = 'usher-first-user',
  managementAudience = 'usher-management-test',
  managementClient = 'usher-ui-test',
  realm = 'overture',
}: {
  firstUserRole?: string;
  managementAudience?: string;
  managementClient?: string;
  realm?: string;
} = {}): KeycloakRealmOptions => {
  const person = (
    username: string,
    email: string,
    details: Partial<KeycloakPerson> = {},
  ): KeycloakPerson => ({
    email,
    password: randomPassword(),
    username,
    ...details,
  });
  return {
    clients: [
      { audiences: [managementAudience], clientId: managementClient },
      {
        audiences: [],
        clientId: 'usher-directory',
        directoryRoles: ['query-users', 'view-users'],
        secret: randomPassword(),
      },
    ],
    duplicateEmailsAllowed: true,
    people: [
      person('sub.bo@example.org', 'sub.bo@example.org', {
        firstName: 'Bo',
        lastName: 'Example',
      }),
      person('bo.smith@example.org', 'bo.smith@example.org'),
      person('abo@example.org', 'abo@example.org'),
      person('zoë@example.org', 'zoë@example.org'),
      person('bo+ims@example.org', 'bo+ims@example.org'),
      person('una@example.org', 'una@example.org', { emailVerified: false }),
      person('disabled@example.org', 'disabled@example.org', {
        enabled: false,
      }),
      person('dup.one', 'dup@example.org'),
      person('dup.two', 'dup@example.org'),
      person('admin.one@example.org', 'admin.one@example.org', {
        realmRoles: [firstUserRole],
      }),
      person('owner.ana@example.org', 'owner.ana@example.org', {
        firstName: 'Ana',
        lastName: 'Example',
      }),
      person('outsider.cy@example.org', 'outsider.cy@example.org', {
        firstName: 'Cy',
        lastName: 'Example',
      }),
      person('leaving@example.org', 'leaving@example.org', {
        firstName: 'Lee',
        lastName: 'Example',
      }),
      person('paused@example.org', 'paused@example.org', {
        firstName: 'Pat',
        lastName: 'Example',
      }),
    ],
    realm,
    realmRoles: [firstUserRole],
  };
};

const KEYCLOAK_PORT = 8080;

const KEYCLOAK_ADMIN = 'usher-test-admin';

const realmImport = ({
  accessTokenLifespanSeconds = 900,
  clients,
  duplicateEmailsAllowed = false,
  people,
  realm,
  realmRoles = [],
}: KeycloakRealmOptions): string =>
  JSON.stringify({
    accessTokenLifespan: accessTokenLifespanSeconds,
    clients: clients.map(({ audiences, clientId, secret }) => ({
      clientId,
      directAccessGrantsEnabled: true,
      enabled: true,
      frontchannelLogout: false,
      protocol: 'openid-connect',
      protocolMappers: audiences.map((audience) => ({
        config: {
          'access.token.claim': 'true',
          'id.token.claim': 'false',
          'included.custom.audience': audience,
        },
        name: `audience ${audience}`,
        protocol: 'openid-connect',
        protocolMapper: 'oidc-audience-mapper',
      })),
      publicClient: secret === undefined,
      ...(secret === undefined ? {} : { secret, serviceAccountsEnabled: true }),
      standardFlowEnabled: false,
    })),
    duplicateEmailsAllowed,
    enabled: true,
    loginWithEmailAllowed: !duplicateEmailsAllowed,
    realm,
    roles: { realm: realmRoles.map((name) => ({ name })) },
    sslRequired: 'none',
    users: [
      ...people.map(
        ({
          email,
          emailVerified = true,
          enabled = true,
          firstName = 'Synthetic',
          lastName = 'Person',
          password,
          realmRoles: held = [],
          username,
        }) => ({
          credentials: [
            { temporary: false, type: 'password', value: password },
          ],
          email,
          emailVerified,
          enabled,
          ...(firstName === null ? {} : { firstName }),
          ...(lastName === null ? {} : { lastName }),
          realmRoles: [`default-roles-${realm}`, ...held],
          username,
        }),
      ),
      ...clients.flatMap(({ clientId, directoryRoles = [] }) =>
        directoryRoles.length === 0
          ? []
          : [
              {
                clientRoles: { 'realm-management': directoryRoles },
                enabled: true,
                serviceAccountClientId: clientId,
                username: `service-account-${clientId}`,
              },
            ],
      ),
    ],
  });

const formPost = async (
  url: string,
  form: Readonly<Record<string, string>>,
): Promise<unknown> => {
  const response = await fetch(url, {
    body: new URLSearchParams(form).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  });
  const text = await response.text();
  if (response.ok) {
    return text === '' ? undefined : (JSON.parse(text) as unknown);
  }
  throw new Error(
    `Keycloak answered ${response.status} at ${new URL(url).pathname}`,
  );
};

const member = (value: unknown, name: string): unknown =>
  typeof value === 'object' && value !== null
    ? Reflect.get(value, name)
    : undefined;

const text = (value: unknown, name: string): string => {
  const found = member(value, name);
  if (typeof found === 'string') {
    return found;
  }
  throw new Error(`Keycloak's answer carries no ${name}`);
};

// A host as a URL names it: an IPv6 literal, such as a daemon's host given by address, in brackets.
const hostInUrl = (host: string): string =>
  host.includes(':') ? `[${host}]` : host;

/**
 * Starts a current Keycloak in a container with one realm imported, reaching the host's loopback
 * through Testcontainers' host access, for the tests whose outcome is Keycloak's own behaviour.
 * Keycloak names its issuer by the host it is asked on, and it is asked through a TCP relay
 * ({@link startRelay}) listening on this machine's `127.0.0.1` alone, wherever the daemon publishes
 * its port: so its issuer is `http://127.0.0.1:<relay port>/realms/<realm>`, which the loopback rule
 * allows, and its `jwks_uri` sits under it. A failed relay start stops the container.
 *
 * @param options the realm, its clients and its people: {@link DEFAULT_KEYCLOAK_REALM} by default.
 */
export const startKeycloak = async (
  options: KeycloakRealmOptions = DEFAULT_KEYCLOAK_REALM,
): Promise<KeycloakRealm> => {
  await TestContainers.exposeHostPorts();
  const adminPassword = randomPassword();
  const started = await new GenericContainer(KEYCLOAK_IMAGE)
    .withEnvironment({
      KC_BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
      KC_BOOTSTRAP_ADMIN_USERNAME: KEYCLOAK_ADMIN,
    })
    .withCopyContentToContainer([
      {
        content: realmImport(options),
        target: `/opt/keycloak/data/import/${options.realm}.json`,
      },
    ])
    .withCommand(['start-dev', '--import-realm'])
    .withExposedPorts(KEYCLOAK_PORT)
    .withWaitStrategy(
      Wait.forHttp(
        `/realms/${options.realm}/.well-known/openid-configuration`,
        KEYCLOAK_PORT,
      ),
    )
    .withStartupTimeout(180_000)
    .start();
  const relay = await startRelay(
    `http://${hostInUrl(started.getHost())}:${started.getMappedPort(KEYCLOAK_PORT)}`,
  ).catch(async (error: unknown) => {
    await started.stop();
    throw error;
  });
  const base = new URL(relay.url).origin;
  const issuer = `${base}/realms/${options.realm}`;
  const admin = `${base}/admin/realms/${options.realm}`;
  const secretOf = (clientId: string): Readonly<Record<string, string>> => {
    const secret = options.clients.find(
      (client) => client.clientId === clientId,
    )?.secret;
    return secret === undefined ? {} : { client_secret: secret };
  };
  const adminCall = async (
    path: string,
    init: { body?: unknown; method?: string } = {},
  ): Promise<Response> => {
    const token = text(
      await formPost(`${base}/realms/master/protocol/openid-connect/token`, {
        client_id: 'admin-cli',
        grant_type: 'password',
        password: adminPassword,
        username: KEYCLOAK_ADMIN,
      }),
      'access_token',
    );
    const response = await fetch(`${admin}${path}`, {
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: init.method ?? 'GET',
    });
    if (response.ok) {
      return response;
    }
    throw new Error(
      `Keycloak's admin API answered ${response.status} at ${path}`,
    );
  };
  const adminJson = async (path: string): Promise<unknown> =>
    (await adminCall(path)).json() as Promise<unknown>;
  const userIdOf = async (username: string): Promise<string> => {
    const listed = await adminJson(
      `/users?exact=true&username=${encodeURIComponent(username)}`,
    );
    return text(Array.isArray(listed) ? listed[0] : undefined, 'id');
  };
  const keyProviderOf = async (kid: string): Promise<string> => {
    const keys = member(await adminJson('/keys'), 'keys');
    const found = Array.isArray(keys)
      ? keys.find((key: unknown) => member(key, 'kid') === kid)
      : undefined;
    return text(found, 'providerId');
  };

  return {
    addKey: async () => {
      const realmId = text(await adminJson(''), 'id');
      const created = await adminCall('/components', {
        body: {
          config: {
            active: ['true'],
            algorithm: ['RS256'],
            enabled: ['true'],
            priority: ['500'],
          },
          name: `test-key-${randomBytes(4).toString('hex')}`,
          parentId: realmId,
          providerId: 'rsa-generated',
          providerType: 'org.keycloak.keys.KeyProvider',
        },
        method: 'POST',
      });
      const componentId = (created.headers.get('location') ?? '')
        .split('/')
        .at(-1);
      const keys = member(await adminJson('/keys'), 'keys');
      const found = Array.isArray(keys)
        ? keys.find((key: unknown) => member(key, 'providerId') === componentId)
        : undefined;
      return text(found, 'kid');
    },

    configureBackChannelLogout: async (clientId, hostUrl) => {
      await TestContainers.exposeHostPorts(Number(hostUrl.port));
      const listed = await adminJson(
        `/clients?clientId=${encodeURIComponent(clientId)}`,
      );
      const client: unknown = Array.isArray(listed) ? listed[0] : undefined;
      const id = text(client, 'id');
      const attributes = member(client, 'attributes');
      const reached = new URL(hostUrl);
      reached.hostname = 'host.testcontainers.internal';
      await adminCall(`/clients/${id}`, {
        body: {
          ...(typeof client === 'object' && client !== null ? client : {}),
          attributes: {
            ...(typeof attributes === 'object' && attributes !== null
              ? attributes
              : {}),
            'backchannel.logout.revoke.offline.tokens': 'false',
            'backchannel.logout.session.required': 'true',
            'backchannel.logout.url': reached.href,
          },
          frontchannelLogout: false,
        },
        method: 'PUT',
      });
    },

    deleteUser: async (username) => {
      await adminCall(`/users/${await userIdOf(username)}`, {
        method: 'DELETE',
      });
    },

    directoryFor: (clientId) => ({
      directoryClientId: clientId,
      directoryClientSecret: secretOf(clientId)['client_secret'] ?? '',
      directoryRealm: options.realm,
      directoryUrl: base,
    }),

    disableKey: async (kid) => {
      const providerId = await keyProviderOf(kid);
      const component = await adminJson(`/components/${providerId}`);
      const config = member(component, 'config');
      await adminCall(`/components/${providerId}`, {
        body: {
          ...(typeof component === 'object' && component !== null
            ? component
            : {}),
          config: {
            ...(typeof config === 'object' && config !== null ? config : {}),
            active: ['false'],
            enabled: ['false'],
          },
        },
        method: 'PUT',
      });
    },

    disableUser: async (username) => {
      const id = await userIdOf(username);
      const user = await adminJson(`/users/${id}`);
      await adminCall(`/users/${id}`, {
        body: {
          ...(typeof user === 'object' && user !== null ? user : {}),
          enabled: false,
        },
        method: 'PUT',
      });
    },

    issuer,

    remove: async () => {
      try {
        await started.stop();
      } finally {
        await relay.stop();
      }
    },

    serviceAccountToken: async (clientId) =>
      text(
        await formPost(`${issuer}/protocol/openid-connect/token`, {
          client_id: clientId,
          grant_type: 'client_credentials',
          ...secretOf(clientId),
        }),
        'access_token',
      ),

    signIn: async (clientId, person) => {
      const answer = await formPost(`${issuer}/protocol/openid-connect/token`, {
        client_id: clientId,
        grant_type: 'password',
        password: person.password,
        scope: 'openid',
        username: person.username,
        ...secretOf(clientId),
      });
      return {
        accessToken: text(answer, 'access_token'),
        idToken: text(answer, 'id_token'),
        refreshToken: text(answer, 'refresh_token'),
      };
    },

    signOut: async (clientId, refreshToken) => {
      await formPost(`${issuer}/protocol/openid-connect/logout`, {
        client_id: clientId,
        refresh_token: refreshToken,
        ...secretOf(clientId),
      });
    },

    subject: (username) => userIdOf(username),
  };
};
