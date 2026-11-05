import assert from 'node:assert/strict';
import { type AddressInfo, connect, createServer, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { suite, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import pg from 'pg';

import {
  administratorCaller,
  assertSucceeded,
  assertUnavailable,
  PROBLEMS,
  readLiveness,
  readReadiness,
  registerApplication,
} from '../../test-support/admin.js';
import {
  AUDIT_EVENT_TYPES,
  auditRows,
  awaitEventsOfType,
  dataOf,
  eventsIn,
  jsonObjectOf,
  SEVERITY_ATTRIBUTE,
} from '../../test-support/auditEvents.js';
import { startDedicatedPostgresql } from '../../test-support/containers.js';
import {
  captureLog,
  ENVIRONMENT_VARIABLES,
  type LogCapture,
} from '../../test-support/controller.js';
import { holdTable } from '../../test-support/database.js';
import { selectRows } from '../../test-support/fixtures/database.js';
import {
  COMPRESSED_CONTROLLER_TIMING,
  type HarnessOptions,
  startInstance,
  startReadOnlyInstance,
  withHarness,
} from '../../test-support/harness.js';
import { POLICY_TABLES, qualified } from '../../test-support/policy.js';
import { SCHEDULING_SLACK_MS } from '../../test-support/vendoredBridge.js';
import {
  type Cleanup,
  cleanupFor,
  eventually,
} from '../../test-support/waiting.js';

const { applications } = POLICY_TABLES;

const { applicationRegistration } = AUDIT_EVENT_TYPES;

const { storeTimeoutMilliseconds: STORE_TIMEOUT_MS } =
  COMPRESSED_CONTROLLER_TIMING;

/** How long the controller reuses one answer of the store's to readiness: a constant of its own. */
const STORE_PROBE_INTERVAL_MS = 1000;

/** The line the controller writes for a store failing a Management API request. */
const STORE_FAILED = 'managementApi.storeFailed';

/** The line naming the events of a transaction whose commit the store did not confirm. */
const COMMIT_UNCONFIRMED = 'audit.commitUnconfirmed';

/** The lines the controller writes as its readiness changes. */
const READINESS_LINES = Object.freeze({
  lost: 'readiness.lost',
  restored: 'readiness.restored',
});

/** The answer to a change whose commit the store did not confirm. */
const OUTCOME_UNKNOWN = Object.freeze({
  code: 'outcomeUnknown',
  detail:
    'The store did not confirm whether this change was made. Read what it changes before trying again.',
});

/** How long the readiness test asks readiness without pause, across a few probe intervals. */
const ASKING_MS = 2500;

/** How many callers ask readiness at once. */
const CALLERS = 4;

interface Timed<Value> {
  elapsedMs: number;
  value: Value;
}

const timed = async <Value>(
  work: () => Promise<Value>,
): Promise<Timed<Value>> => {
  const from = performance.now();
  const value = await work();
  return { elapsedMs: performance.now() - from, value };
};

// Whether an answer came once the store timeout had run out, and within scheduling's slack of it.
const answeredAtTimeout = ({ elapsedMs }: Timed<unknown>): boolean =>
  elapsedMs >= STORE_TIMEOUT_MS &&
  elapsedMs < STORE_TIMEOUT_MS + SCHEDULING_SLACK_MS;

const compressed = (
  log: LogCapture,
  options: Omit<HarnessOptions, 'configuration'> = {},
): HarnessOptions => ({
  applications: [],
  configuration: {
    logStream: log.stream,
    storeTimeoutMilliseconds: STORE_TIMEOUT_MS,
  },
  ...options,
});

const linesNamed = (
  log: LogCapture,
  message: string,
  since: number,
): readonly Readonly<Record<string, unknown>>[] =>
  log
    .lines()
    .slice(since)
    .map(jsonObjectOf)
    .filter((line) => line['message'] === message);

// Each event a line names, by its id and type.
const eventsNamedBy = (
  line: Readonly<Record<string, unknown>> | undefined,
): readonly { id: unknown; type: unknown }[] => {
  const events: unknown = line?.['events'];
  return Array.isArray(events)
    ? events.map((event: unknown) =>
        typeof event === 'object' && event !== null
          ? {
              id: 'id' in event ? event.id : undefined,
              type: 'type' in event ? event.type : undefined,
            }
          : { id: undefined, type: undefined },
      )
    : [];
};

// The lines a controller wrote as its readiness changed, in order.
const readinessLines = (
  log: LogCapture,
): readonly Readonly<Record<string, unknown>>[] =>
  log
    .lines()
    .map(jsonObjectOf)
    .filter(
      ({ message }) =>
        message === READINESS_LINES.lost ||
        message === READINESS_LINES.restored,
    );

const applicationsNamed = async (
  client: pg.ClientBase,
  displayName: string,
): Promise<number> =>
  (
    await selectRows<{ count: number }>(
      client,
      `SELECT count(*)::int AS count FROM ${qualified(applications)} WHERE ${applications.columns.displayName} = $1`,
      [displayName],
    )
  )[0]?.count ?? 0;

// The controller's sessions on the test's database still waiting on a lock or idle inside a
// transaction, read under the controller's own role, which sees its sessions' state.
const heldSessions = async (runtime: pg.ClientBase): Promise<number> =>
  (
    await selectRows<{ count: number }>(
      runtime,
      `SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database() AND usename = current_user AND pid <> pg_backend_pid()
          AND (state LIKE 'idle in transaction%' OR wait_event_type = 'Lock')`,
    )
  )[0]?.count ?? 0;

// The statements the controller's sessions on the test's database began after an instant on the
// store's clock, each as its session and its start, read under the controller's own role.
const statementsSince = async (
  runtime: pg.ClientBase,
  since: string,
): Promise<readonly string[]> =>
  (
    await selectRows<{ began: string; pid: number }>(
      runtime,
      `SELECT pid, query_start::text AS began FROM pg_stat_activity
        WHERE datname = current_database() AND usename = current_user AND pid <> pg_backend_pid()
          AND query_start > $1::timestamptz`,
      [since],
    )
  ).map(({ began, pid }) => `${pid} ${began}`);

// Every statement the controller's sessions began after an instant, read every few milliseconds
// until a deadline: a session keeps showing its last statement's start until it begins another.
const sampledUntil = async (
  runtime: pg.ClientBase,
  since: string,
  deadline: number,
  seen: ReadonlySet<string> = new Set(),
): Promise<ReadonlySet<string>> => {
  const sampled = new Set([
    ...seen,
    ...(await statementsSince(runtime, since)),
  ]);
  if (performance.now() < deadline) {
    await delay(10);
    return sampledUntil(runtime, since, deadline, sampled);
  }
  return sampled;
};

interface Asking {
  asked: number;

  /** How many asks were answered other than 200. */
  unready: number;
}

// Asks readiness, one ask after another, until a deadline.
const askedUntil = async (
  url: URL,
  deadline: number,
  { asked, unready }: Asking = { asked: 0, unready: 0 },
): Promise<Asking> => {
  if (performance.now() < deadline) {
    const { status } = await readReadiness(url);
    return askedUntil(url, deadline, {
      asked: asked + 1,
      unready: status === 200 ? unready : unready + 1,
    });
  }
  return { asked, unready };
};

// The parameters of a startup message the controller's limits travel in.
const STARTUP_LIMITS: ReadonlySet<string> = new Set([
  'idle_in_transaction_session_timeout',
  'statement_timeout',
]);

// The protocol's code for a query sent as text, the way a transaction's COMMIT is sent.
const SIMPLE_QUERY = 0x51;

/** A proxy between a controller and its store, speaking the store's protocol as far as it needs. */
interface StoreProxy {
  /** The database URL given, at the proxy's address. */
  databaseUrl: string;

  /** From now on, passes each COMMIT on to the store and holds back every answer after it. */
  holdCommitAnswers(): void;
}

// The length of the message at the start of what a client sent, once enough of it has arrived: the
// startup message's from its first four bytes, any other's from the four after its type.
const messageLength = (
  buffer: Buffer,
  started: boolean,
): number | undefined => {
  if (started) {
    return buffer.length >= 5 ? 1 + buffer.readInt32BE(1) : undefined;
  }
  return buffer.length >= 4 ? buffer.readInt32BE(0) : undefined;
};

// A startup message without the controller's limits: its length and protocol version, then each
// parameter as a name and a value, each ended by a zero byte, and a closing zero byte.
const withoutLimits = (startup: Buffer): Buffer => {
  const fields = startup
    .subarray(8, startup.length - 1)
    .toString('utf8')
    .split('\0')
    .slice(0, -1);
  const kept = Array.from({ length: fields.length / 2 }, (_, pair) => [
    fields[2 * pair] ?? '',
    fields[2 * pair + 1] ?? '',
  ]).filter(([name]) => !STARTUP_LIMITS.has(name ?? ''));
  const body = Buffer.from(
    `${kept.map(([name, value]) => `${name}\0${value}\0`).join('')}\0`,
    'utf8',
  );
  const header = Buffer.alloc(8);
  header.writeInt32BE(header.length + body.length, 0);
  startup.copy(header, 4, 4, 8);
  return Buffer.concat([header, body]);
};

const isCommit = (message: Buffer): boolean =>
  message[0] === SIMPLE_QUERY &&
  message.subarray(5, message.length - 1).toString('utf8') === 'COMMIT';

/**
 * Starts a proxy relaying every connection to the store a database URL names, and defers its end to
 * the cleanup given. One that drops the limits leaves them out of each connection's startup message,
 * as a connection pooler dropping startup parameters does.
 */
const startStoreProxy = async (
  scope: Cleanup,
  databaseUrl: string,
  { dropsLimits = false }: { dropsLimits?: boolean } = {},
): Promise<StoreProxy> => {
  const target = new URL(databaseUrl);
  const proxy = { holding: false, sockets: new Set<Socket>() };
  const relay = (client: Socket): void => {
    const upstream = connect({
      host: target.hostname,
      port: Number(target.port),
    });
    const connection = { buffer: Buffer.alloc(0), held: false, started: false };
    const forward = (): void => {
      const length = messageLength(connection.buffer, connection.started);
      if (length !== undefined && connection.buffer.length >= length) {
        const message = connection.buffer.subarray(0, length);
        connection.buffer = connection.buffer.subarray(length);
        if (connection.started) {
          connection.held ||= proxy.holding && isCommit(message);
          upstream.write(message);
        } else {
          connection.started = true;
          upstream.write(dropsLimits ? withoutLimits(message) : message);
        }
        forward();
      }
    };
    [client, upstream].forEach((socket) => {
      proxy.sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => {
        proxy.sockets.delete(socket);
        client.destroy();
        upstream.destroy();
      });
    });
    client.on('data', (chunk: Buffer) => {
      connection.buffer = Buffer.concat([connection.buffer, chunk]);
      forward();
    });
    upstream.on('data', (chunk: Buffer) => {
      if (connection.held === false) {
        client.write(chunk);
      }
    });
  };
  const server = createServer(relay);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  scope.defer(
    () =>
      new Promise<void>((resolve) => {
        proxy.sockets.forEach((socket) => socket.destroy());
        server.close(() => resolve());
      }),
  );
  const proxied = new URL(databaseUrl);
  proxied.hostname = '127.0.0.1';
  proxied.port = String((server.address() as AddressInfo).port);
  return {
    databaseUrl: proxied.href,
    holdCommitAnswers: () => {
      proxy.holding = true;
    },
  };
};

const refusalOf = (
  outcome: unknown,
): { message: string; name: string; variables: unknown } =>
  outcome instanceof Error && 'variables' in outcome
    ? {
        message: outcome.message,
        name: outcome.name,
        variables: outcome.variables,
      }
    : assert.fail('the start was not refused');

suite('a Management API request on a store not answering in time', () => {
  test('answers a Management API request 503 storeUnavailable within about the store timeout while the store is paused, writing nothing, and serves the next once the store answers', async (context) => {
    const scope = cleanupFor(context);
    const postgresql = await startDedicatedPostgresql();
    scope.defer(() => postgresql.remove());
    const log = captureLog();

    await withHarness(
      compressed(log, { postgresql }),
      async (harness) => {
        const migration = harness.clients.migration;
        const administrator = await administratorCaller(harness);
        assertSucceeded(
          await registerApplication(administrator, {
            displayName: 'Registered before the pause',
          }),
          'the registration before the pause',
        );
        const since = log.lines().length;

        await postgresql.pause();
        const paused = await timed(() =>
          registerApplication(administrator, {
            displayName: 'Registered while paused',
          }),
        ).finally(() => postgresql.unpause());
        const failures = linesNamed(log, STORE_FAILED, since);
        const afterwards = await registerApplication(administrator, {
          displayName: 'Registered once the store answers',
        });
        const stored = [
          await applicationsNamed(migration, 'Registered while paused'),
          await applicationsNamed(
            migration,
            'Registered once the store answers',
          ),
        ];

        assertUnavailable(
          paused.value,
          'the registration while paused',
          PROBLEMS.storeUnavailable.code,
        );
        assert.ok(
          answeredAtTimeout(paused),
          `answered in ${Math.round(paused.elapsedMs)} ms`,
        );
        assert.deepEqual(
          failures.map(({ code, method, route }) => ({ code, method, route })),
          [
            {
              code: 'storeTimeout',
              method: 'POST',
              route: '/admin/applications',
            },
          ],
        );
        assertSucceeded(afterwards, 'the registration once the store answers');
        assert.deepEqual(stored, [0, 1]);
      },
      context,
    );
  });

  test('abandons a transaction the store holds past the store timeout, answering 503 storeUnavailable, recording its event failed, committing nothing of it and leaving no session of it waiting', async (context) => {
    const log = captureLog();

    await withHarness(
      compressed(log),
      async (harness) => {
        const { migration, runtime } = harness.clients;
        const administrator = await administratorCaller(harness);
        assertSucceeded(
          await registerApplication(administrator, {
            displayName: 'Registered before the hold',
          }),
          'the registration before the hold',
        );
        const since = log.lines().length;
        const held = await holdTable(harness.database, applications);

        const abandoned = await timed(() =>
          registerApplication(administrator, {
            displayName: 'Held past the store timeout',
          }),
        );
        const [recorded] = await awaitEventsOfType(
          log,
          applicationRegistration,
          { since },
        );
        const failures = linesNamed(log, STORE_FAILED, since);
        const sessionsEnded = await eventually(
          async () => (await heldSessions(runtime)) === 0,
          STORE_TIMEOUT_MS + SCHEDULING_SLACK_MS,
          20,
        );
        await held.release();
        const afterwards = await registerApplication(administrator, {
          displayName: 'Registered after the hold',
        });
        const stored = [
          await applicationsNamed(migration, 'Held past the store timeout'),
          await applicationsNamed(migration, 'Registered after the hold'),
        ];
        const recordedRows = (await auditRows(migration)).filter(
          ({ id }) => id === recorded?.id,
        );

        assertUnavailable(
          abandoned.value,
          'the registration held past the store timeout',
          PROBLEMS.storeUnavailable.code,
        );
        assert.ok(
          answeredAtTimeout(abandoned),
          `answered in ${Math.round(abandoned.elapsedMs)} ms`,
        );
        assert.deepEqual(
          failures.map(({ code }) => code),
          ['storeTimeout'],
        );
        assert.ok(recorded, 'the registration recorded no event');
        assert.deepEqual(
          {
            reason: dataOf(recorded)['reason'],
            result: dataOf(recorded)['result'],
            severity: recorded[SEVERITY_ATTRIBUTE],
          },
          { reason: 'storeUnavailable', result: 'failed', severity: 'error' },
        );
        assert.equal(recordedRows.length, 1);
        assert.ok(
          sessionsEnded,
          'a session of the abandoned transaction still waits on the store',
        );
        assertSucceeded(afterwards, 'the registration after the hold');
        assert.deepEqual(stored, [0, 1]);
      },
      context,
    );
  });

  test('answers a change whose COMMIT the store does not answer within one more store timeout 503 outcomeUnknown, recording no failed event and writing one line naming its events, which the store did commit', async (context) => {
    const scope = cleanupFor(context);
    const log = captureLog();
    const instanceLog = captureLog();

    await withHarness(
      compressed(log),
      async (harness) => {
        const migration = harness.clients.migration;
        const proxy = await startStoreProxy(
          scope,
          harness.configuration.databaseUrl,
        );
        const instance = await startInstance(scope, harness, {
          databaseUrl: proxy.databaseUrl,
          logStream: instanceLog.stream,
        });
        const administrator = await administratorCaller(harness, {
          url: instance.url,
        });
        assertSucceeded(
          await registerApplication(administrator, {
            displayName: 'Registered before the hold',
          }),
          'the registration before the hold',
        );
        const since = instanceLog.lines().length;

        proxy.holdCommitAnswers();
        const unconfirmed = await timed(() =>
          registerApplication(administrator, {
            displayName: 'Registered unconfirmed',
          }),
        );
        const [line, ...moreLines] = linesNamed(
          instanceLog,
          COMMIT_UNCONFIRMED,
          since,
        );
        const named = eventsNamedBy(line);
        const committed = await eventually(
          async () =>
            (await auditRows(migration)).filter(({ id }) =>
              named.some((event) => event.id === id),
            ).length === named.length,
          SCHEDULING_SLACK_MS,
          20,
        );
        const failedRows = (await auditRows(migration)).filter(
          ({ data, type }) =>
            type === `bio.overture.${applicationRegistration}` &&
            typeof data === 'object' &&
            data !== null &&
            'result' in data &&
            data.result === 'failed',
        );

        assert.equal(unconfirmed.value.status, 503);
        assert.deepEqual(
          {
            code: unconfirmed.value.problem?.code,
            detail: unconfirmed.value.problem?.detail,
          },
          OUTCOME_UNKNOWN,
        );
        assert.ok(
          unconfirmed.elapsedMs >= STORE_TIMEOUT_MS &&
            unconfirmed.elapsedMs < 2 * STORE_TIMEOUT_MS + SCHEDULING_SLACK_MS,
          `answered in ${Math.round(unconfirmed.elapsedMs)} ms`,
        );
        assert.deepEqual(moreLines, []);
        assert.equal(line?.['level'], 50);
        assert.deepEqual(
          named.map(({ type }) => type),
          [
            `bio.overture.${applicationRegistration}`,
            `bio.overture.${AUDIT_EVENT_TYPES.applicationKeyIssuance}`,
          ],
        );
        assert.equal(
          JSON.stringify(line).includes('Registered unconfirmed'),
          false,
        );
        assert.deepEqual(linesNamed(instanceLog, STORE_FAILED, since), []);
        assert.deepEqual(eventsIn(instanceLog, since), []);
        assert.ok(committed, 'the rows the line names never reached audit_log');
        assert.deepEqual(failedRows, []);
        assert.equal(
          await applicationsNamed(migration, 'Registered unconfirmed'),
          1,
        );
      },
      context,
    );
  });
});

suite("the controller's start", () => {
  test('refuses a start the store does not answer within about the store timeout, naming the database URL and the store timeout and quoting neither, and starts once the store answers', async (context) => {
    const scope = cleanupFor(context);
    const postgresql = await startDedicatedPostgresql();
    scope.defer(() => postgresql.remove());
    const log = captureLog();

    await withHarness(
      compressed(log, { postgresql, startsController: false }),
      async (harness) => {
        await postgresql.pause();
        const refused = await timed(() =>
          harness.startController().then(
            () => undefined,
            (refusal: unknown) => refusal,
          ),
        ).finally(() => postgresql.unpause());
        await harness.startController();
        const ready = await readReadiness(harness.url);

        const refusal = refusalOf(refused.value);
        assert.equal(refusal.name, 'StartRefusal');
        assert.deepEqual(refusal.variables, [
          ENVIRONMENT_VARIABLES.databaseUrl,
        ]);
        assert.match(
          refusal.message,
          new RegExp(
            `\\b${ENVIRONMENT_VARIABLES.databaseUrl}\\b.*\\b${ENVIRONMENT_VARIABLES.storeTimeoutMilliseconds}\\b`,
            'u',
          ),
        );
        assert.equal(
          refusal.message.includes(harness.configuration.databaseUrl),
          false,
        );
        assert.equal(refusal.message.includes(String(STORE_TIMEOUT_MS)), false);
        assert.ok(
          answeredAtTimeout(refused),
          `refused in ${Math.round(refused.elapsedMs)} ms`,
        );
        assert.equal(ready.status, 200);
      },
      context,
    );
  });

  test("refuses a start on a connection that drops the controller's statement limits, as a pooler dropping startup parameters does, naming the database URL", async (context) => {
    const scope = cleanupFor(context);
    const log = captureLog();

    await withHarness(
      compressed(log),
      async (harness) => {
        const proxy = await startStoreProxy(
          scope,
          harness.configuration.databaseUrl,
          { dropsLimits: true },
        );

        await assert.rejects(
          startInstance(scope, harness, { databaseUrl: proxy.databaseUrl }),
          {
            message:
              "the controller refuses to start: USHER_DATABASE_URL names a connection on which the store does not apply the controller's statement limits, as a connection pooler that drops startup parameters does",
            name: 'StartRefusal',
            variables: [ENVIRONMENT_VARIABLES.databaseUrl],
          },
        );
      },
      context,
    );
  });

  test('refuses a start the store will not sign in, naming the password for a refused password and the database URL for a database the store lacks', async (context) => {
    const scope = cleanupFor(context);
    const log = captureLog();

    await withHarness(
      compressed(log),
      async (harness) => {
        const elsewhere = new URL(harness.configuration.databaseUrl);
        elsewhere.pathname = '/usher_no_such_database';

        const refusals = [
          await startInstance(scope, harness, {
            databasePassword: 'not the password of the role',
          }).then(
            () => undefined,
            (refusal: unknown) => refusal,
          ),
          await startInstance(scope, harness, {
            databaseUrl: elsewhere.href,
          }).then(
            () => undefined,
            (refusal: unknown) => refusal,
          ),
        ].map(refusalOf);

        assert.deepEqual(refusals, [
          {
            message:
              'the controller refuses to start: USHER_DATABASE_PASSWORD is not the password of the database role USHER_DATABASE_URL names, or that role does not exist',
            name: 'StartRefusal',
            variables: [ENVIRONMENT_VARIABLES.databasePassword],
          },
          {
            message:
              'the controller refuses to start: USHER_DATABASE_URL names a database the store does not hold',
            name: 'StartRefusal',
            variables: [ENVIRONMENT_VARIABLES.databaseUrl],
          },
        ]);
      },
      context,
    );
  });
});

suite("the controller's readiness", () => {
  test('answers 503 while the store is paused and 200 once it answers again, liveness 200 throughout, with no body, writing one line as it becomes unready and one as it is ready again', async (context) => {
    const scope = cleanupFor(context);
    const postgresql = await startDedicatedPostgresql();
    scope.defer(() => postgresql.remove());
    const log = captureLog();
    const settles =
      STORE_PROBE_INTERVAL_MS + STORE_TIMEOUT_MS + SCHEDULING_SLACK_MS;

    await withHarness(
      compressed(log, { postgresql }),
      async (harness) => {
        const before = await readReadiness(harness.url);

        await postgresql.pause();
        const pausedReadings = await (async () => {
          try {
            const turnedUnready = await eventually(
              async () => (await readReadiness(harness.url)).status === 503,
              settles,
              20,
            );
            const unready = await timed(() => readReadiness(harness.url));
            const live = await readLiveness(harness.url);
            return { live, turnedUnready, unready };
          } finally {
            await postgresql.unpause();
          }
        })();
        const turnedReady = await eventually(
          async () => (await readReadiness(harness.url)).status === 200,
          settles,
          20,
        );
        const after = await readReadiness(harness.url);

        assert.equal(before.status, 200);
        assert.ok(pausedReadings.turnedUnready, 'never unready while paused');
        assert.equal(pausedReadings.unready.value.status, 503);
        assert.ok(
          pausedReadings.unready.elapsedMs <
            STORE_TIMEOUT_MS + SCHEDULING_SLACK_MS,
          `answered in ${Math.round(pausedReadings.unready.elapsedMs)} ms`,
        );
        assert.equal(pausedReadings.live.status, 200);
        assert.ok(turnedReady, 'never ready again once the store answered');
        assert.equal(after.status, 200);
        assert.deepEqual(
          readinessLines(log).map(({ cause, level, message }) => ({
            cause,
            level,
            message,
          })),
          [
            { cause: 'storeTimeout', level: 40, message: READINESS_LINES.lost },
            {
              cause: undefined,
              level: 30,
              message: READINESS_LINES.restored,
            },
          ],
        );
        [
          before,
          pausedReadings.unready.value,
          pausedReadings.live,
          after,
        ].forEach((answer) => {
          assert.equal(answer.text, '');
        });
      },
      context,
    );
  });

  test('answers 503 on an instance whose role writes while its store reads as read-only, naming that cause, and 200 on one whose role only reads', async (context) => {
    const scope = cleanupFor(context);
    const postgresql = await startDedicatedPostgresql();
    scope.defer(() => postgresql.remove());
    const log = captureLog();
    const readingLog = captureLog();
    const settles =
      STORE_PROBE_INTERVAL_MS + STORE_TIMEOUT_MS + SCHEDULING_SLACK_MS;

    await withHarness(
      compressed(log, { postgresql }),
      async (harness) => {
        const reading = await startReadOnlyInstance(scope, harness, {
          logStream: readingLog.stream,
        });
        const superuser = new pg.Client({
          connectionString: postgresql.container.url,
        });
        superuser.on('error', () => undefined);
        await superuser.connect();
        scope.defer(() => superuser.end());
        const readOnlyStore = async (readOnly: boolean): Promise<void> => {
          await superuser.query(
            readOnly
              ? 'ALTER SYSTEM SET default_transaction_read_only = on'
              : 'ALTER SYSTEM RESET default_transaction_read_only',
          );
          await superuser.query('SELECT pg_reload_conf()');
        };
        const before = await readReadiness(harness.url);

        await readOnlyStore(true);
        const whileReadOnly = await (async () => {
          try {
            const writerUnready = await eventually(
              async () => (await readReadiness(harness.url)).status === 503,
              settles,
              20,
            );
            await delay(STORE_PROBE_INTERVAL_MS);
            const readerAnswer = await readReadiness(reading.url);
            return { readerAnswer, writerUnready };
          } finally {
            await readOnlyStore(false);
          }
        })();
        const writerReady = await eventually(
          async () => (await readReadiness(harness.url)).status === 200,
          settles,
          20,
        );

        assert.equal(before.status, 200);
        assert.ok(
          whileReadOnly.writerUnready,
          'the writing instance stayed ready',
        );
        assert.equal(whileReadOnly.readerAnswer.status, 200);
        assert.ok(writerReady, 'the writing instance never ready again');
        assert.deepEqual(
          readinessLines(log).map(({ cause, message }) => ({ cause, message })),
          [
            { cause: 'readOnly', message: READINESS_LINES.lost },
            { cause: undefined, message: READINESS_LINES.restored },
          ],
        );
        assert.deepEqual(readinessLines(readingLog), []);
      },
      context,
    );
  });

  test('asks the store at most once per interval however often, and by however many at once, readiness is asked', async (context) => {
    const log = captureLog();

    await withHarness(
      compressed(log),
      async (harness) => {
        const { runtime } = harness.clients;
        const [clock] = await selectRows<{ now: string }>(
          runtime,
          'SELECT clock_timestamp()::text AS now',
        );
        const since = clock?.now ?? assert.fail("the store's clock was unread");
        const deadline = performance.now() + ASKING_MS;

        const [statements, callers] = await Promise.all([
          sampledUntil(runtime, since, deadline),
          Promise.all(
            Array.from({ length: CALLERS }, () =>
              askedUntil(harness.url, deadline),
            ),
          ),
        ]);
        const asked = callers.reduce((sum, caller) => sum + caller.asked, 0);
        const unready = callers.reduce(
          (sum, caller) => sum + caller.unready,
          0,
        );
        const probes = (await sampledUntil(runtime, since, 0, statements)).size;

        assert.ok(asked >= 100, `asked only ${asked} times`);
        assert.equal(unready, 0);
        assert.ok(probes >= 2, `the store was probed ${probes} times`);
        assert.ok(
          probes <= Math.ceil(ASKING_MS / STORE_PROBE_INTERVAL_MS) + 1,
          `the store was probed ${probes} times for ${asked} asks`,
        );
      },
      context,
    );
  });
});
