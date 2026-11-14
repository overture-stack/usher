import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';

import type { CONTROLLER_EXCHANGE_DEADLINE_MILLISECONDS } from '@overture-stack/usher-types';
import type pg from 'pg';

import {
  createAdmission,
  SHARE_EXCEEDED_TALLY_INTERVAL_MILLISECONDS,
  shareExceededTallyEvent,
} from '../admission/index.js';
import { createApiDocsRoutes } from '../apiDocs/index.js';
import { createApplicationKeyRing } from '../applicationKeyRing/index.js';
import {
  createApplicationKeyCipher,
  createApplicationRoutes,
} from '../applications/index.js';
import {
  createAssertionRefusals,
  createChannelAssertionVerifier,
  createRefusedAssertions,
  pendingRecordingLimit,
  REJECTION_TALLY_INTERVAL_MILLISECONDS,
  type RejectionReason,
  rejectionTallyEvent,
} from '../channelAssertion/index.js';
import type { ControllerConfiguration } from '../configuration/index.js';
import { createAuditTrail, createEventLog } from '../eventLog/index.js';
import {
  createExchange,
  createKeyConfirmations,
  LATE_REQUEST_THRESHOLD_MILLISECONDS,
  TOKEN_LIMIT_BYTES,
} from '../exchange/index.js';
import { ControllerError } from '../failures/index.js';
import { createGrantRoutes, sqlGrantStore } from '../grants/index.js';
import { createServer } from '../http/index.js';
import { createTokenVerifier } from '../identityProvider/index.js';
import {
  type AfterCommitStepName,
  type ManagementDependencies,
  REFUSAL_TALLY_INTERVAL_MILLISECONDS,
  refusalTallyEvent,
  type TallyReason,
} from '../managementApi/index.js';
import {
  createNoticeChannel,
  createUsedAssertions,
} from '../noticeChannel/index.js';
import {
  createCursorCipher,
  createNoticeReader,
} from '../noticeStream/index.js';
import { createReadiness } from '../readiness/index.js';
import { createResourceRoutes } from '../resources/index.js';
import { createRetentionSweep } from '../retention/index.js';
import {
  judgeSignInCredential,
  readStoredRefusal,
} from '../signInTokens/index.js';
import {
  createSignOutRoute,
  LOGOUT_TOKEN_TALLY_INTERVAL_MILLISECONDS,
  logoutTokenRefusalTallyEvent,
  type LogoutTokenTallyReason,
} from '../signOuts/index.js';
import {
  checkStatementLimits,
  openStore,
  prepareStore,
} from '../store/index.js';
import { createStoreReader } from '../storeTimeout/index.js';
import { createTally } from '../tally/index.js';
import { afterCommitTrail, runAfterCommit } from './afterCommitTrail.js';
import type { AfterCommitStep, Controller } from './types.js';

// A refused channel assertion, as its tally counts it: by reason, and by the registered application it
// names, or none.
interface RejectionCounted {
  applicationId: string | undefined;
  reason: RejectionReason;
}

interface Lifecycle {
  ready: boolean;
  started: Promise<{ url: URL }> | undefined;
  stopped: Promise<void> | undefined;

  /** Whether the database role writes, as the start found it. */
  writes: boolean;
}

const isAddress = (address: unknown): address is AddressInfo =>
  typeof address === 'object' && address !== null && 'port' in address;

const urlOf = (address: unknown): URL => {
  if (isAddress(address)) {
    const host =
      address.family === 'IPv6' ? `[${address.address}]` : address.address;
    return new URL(`http://${host}:${address.port}/`);
  }
  throw new ControllerError('the controller listens on no TCP address');
};

// The exchange's deadline, which must equal usher-types'
// `CONTROLLER_EXCHANGE_DEADLINE_MILLISECONDS`. It is typed as that constant's literal, so any other
// value here fails the type check. It is written here rather than imported, since the controller
// takes only types from the libraries.
const EXCHANGE_DEADLINE_MILLISECONDS: typeof CONTROLLER_EXCHANGE_DEADLINE_MILLISECONDS = 4000;

// What readiness asks the store: whether it reads as read-only, a statement reading no table.
const STORE_PROBE =
  'SELECT current_setting(\'transaction_read_only\') AS "readOnly"';

// Readiness's own pool holds one connection, used by nothing else: readiness means the instance can
// answer an exchange correctly, and a probe on either working pool would measure its queue rather
// than the store.
const READINESS_CONNECTIONS = 1;

/**
 * Creates a controller from its configuration, connecting to nothing until it starts. Its start
 * checks the store before anything listens, so a refused start never accepts a connection, reads
 * the live application keys into memory, and then serves the Management API's application, resource
 * and grant operations, each event they record written to the audit log and the log stream, the
 * revocation channel's poll and push, the token exchange, and the identity provider's back-channel
 * logout, and, while `apiDocsClient` names a client, the API documentation page at `/api-docs`,
 * taking no credential, its files read as the controller is created. A change committed through an
 * operation is held by the instance before it is answered: the instance's streams are woken to its
 * notices, as for a sign-out committed, and the live keys are read again for an operation naming
 * that step, as registering an application, issuing a key and revoking one do. A failure in either
 * step is written to the log and never changes the answer. The live keys are read again too each
 * time the configured clock passes the reload interval, and a stored key that does not open is
 * recorded as `applicationKey.unreadable`. A start finding that its database role writes then runs
 * the retention sweep until the stop, giving it the configured clock; a run of it that fails
 * changes no answer of any route, readiness's included. The Management API, the exchange and the
 * back-channel logout verify the identity provider's tokens through one verifier, and the
 * revocation channel and the exchange check channel assertions through one verifier, counting those
 * they cannot verify in one tally. Every unit of its store work, a request's statement or
 * transaction, a recorded event, a read of the keys or the notices, a run of the sweep, or the
 * start's transaction, runs within the store timeout.
 *
 * It holds three pools of store connections, each with the same limits, so no one kind of work can
 * hold the connections another needs: the exchange pool, of `databaseExchangeConnections`, for the
 * exchange's own transactions, its key confirmations and its recordings of refused assertions; the
 * control pool, of `databaseControlConnections`, for everything else, the Management API, the
 * back-channel logout, the notice channel's reads and its recordings of refused assertions, the key
 * reloads, the tallies, the retention sweep and the start; and one connection of readiness's own.
 * The start checks the store's limits on the sessions of each.
 *
 * A channel assertion that verifies and is refused anyway, on either route, is recorded as a
 * `channelAssertion.rejection` the first time the instance refuses it, and counted on every later
 * refusal; every route shares one memory of refused assertions, and each holds at most half its
 * pool's connections, at least one, in those recordings. The exchange admits each application's
 * exchanges within a share of the exchange pool, divided among the applications the key ring holds
 * as registered, lending the pool's idle connections past a share, and counts the exchanges it
 * refuses in a tally of its own; its recordings of refused assertions take a place in those shares
 * too. The token exchange answers every exchange by its deadline,
 * `CONTROLLER_EXCHANGE_DEADLINE_MILLISECONDS` from the request's arrival on the monotonic clock, so
 * its store work runs within that deadline too. Its stop first stops the sweep, so no run of it
 * begins once the stop has, then ends every stream, then closes the server, letting requests in
 * flight finish, waits for the refused channel assertions still being recorded and for the sweep's
 * run in flight, records the counts its four tallies hold, stops reading the keys, then closes
 * every pool's connections and lets go of the log stream. It reports itself ready while it is
 * started, its log stream takes its lines, and its store answers readiness's own connection within
 * the store timeout, not reading as read-only when its database role writes, writing each change.
 * It reports itself live until its log stream fails to take a line, which only a restart recovers
 * from, and writes nothing as it stops being live.
 *
 * @param configuration the controller's configuration.
 */
export const createController = (
  configuration: ControllerConfiguration,
): Controller => {
  const lifecycle: Lifecycle = {
    ready: false,
    started: undefined,
    stopped: undefined,
    writes: false,
  };
  const eventLog = createEventLog(configuration);
  const controlStore = openStore(
    configuration,
    eventLog,
    configuration.databaseControlConnections,
  );
  const exchangeStore = openStore(
    configuration,
    eventLog,
    configuration.databaseExchangeConnections,
  );
  const readinessStore = openStore(
    configuration,
    eventLog,
    READINESS_CONNECTIONS,
  );
  const pools = [controlStore, exchangeStore, readinessStore];
  // The reader and the trail serve the control pool; the exchange and readiness hold their own.
  const reader = createStoreReader(
    controlStore,
    configuration.storeTimeoutMilliseconds,
  );
  const exchangeReader = createStoreReader(
    exchangeStore,
    configuration.storeTimeoutMilliseconds,
  );
  const readinessReader = createStoreReader(
    readinessStore,
    configuration.storeTimeoutMilliseconds,
  );
  const trail = createAuditTrail<pg.PoolClient>({
    eventLog,
    settings: configuration,
    store: controlStore,
  });
  const exchangeTrail = createAuditTrail<pg.PoolClient>({
    eventLog,
    settings: configuration,
    store: exchangeStore,
  });
  const refusalTally = createTally<TallyReason>({
    clock: configuration.clock,
    eventOf: refusalTallyEvent,
    intervalMilliseconds: REFUSAL_TALLY_INTERVAL_MILLISECONDS,
    partsOf: (reason) => [reason],
    trail,
  });
  const logoutTokenRefusals = createTally<LogoutTokenTallyReason>({
    clock: configuration.clock,
    eventOf: logoutTokenRefusalTallyEvent,
    intervalMilliseconds: LOGOUT_TOKEN_TALLY_INTERVAL_MILLISECONDS,
    partsOf: (reason) => [reason],
    trail,
  });
  const assertionRejections = createTally<RejectionCounted>({
    clock: configuration.clock,
    eventOf: ({ applicationId, reason }, count) =>
      rejectionTallyEvent(reason, applicationId, count),
    intervalMilliseconds: REJECTION_TALLY_INTERVAL_MILLISECONDS,
    // By reason, then by application, a count naming none first.
    partsOf: ({ applicationId, reason }) => [reason, applicationId ?? ''],
    trail,
  });
  // Counts every refused channel assertion not recorded one by one, from either route.
  const rejections = {
    count: (reason: RejectionReason, applicationId?: string): void => {
      assertionRejections.count({ applicationId, reason });
    },
  };
  // One memory of refused assertions for the instance, shared by every route reading an assertion, its
  // failed recordings written to the log on the configured clock.
  const assertionRefusals = createAssertionRefusals({
    clock: configuration.clock,
    log: eventLog,
    refusedAssertions: createRefusedAssertions(configuration.clock),
    rejections,
  });
  const sharesExceeded = createTally<string>({
    clock: configuration.clock,
    eventOf: shareExceededTallyEvent,
    intervalMilliseconds: SHARE_EXCEEDED_TALLY_INTERVAL_MILLISECONDS,
    partsOf: (applicationId) => [applicationId],
    trail,
  });
  const sweep = createRetentionSweep({
    clock: configuration.clock,
    log: eventLog,
    schema: configuration.databaseSchema,
    trail,
  });
  const cipher = createApplicationKeyCipher(configuration.keyEncryptionKey);
  const keyRing = createApplicationKeyRing({
    changed: () => {
      channel.keysChanged();
    },
    cipher,
    clock: configuration.clock,
    log: eventLog,
    schema: configuration.databaseSchema,
    store: reader,
    trail,
  });
  // One verifier for every route reading a channel assertion, checking each against the keys in memory.
  const assertionVerifier = createChannelAssertionVerifier({
    clock: configuration.clock,
    keyRing,
  });
  // Each route holds at most half its pool in recordings of refused assertions waiting on the store:
  // the notice channel's on the control pool here, the exchange's on the exchange pool.
  const channel = createNoticeChannel({
    assertionRefusals: assertionRefusals.forRoute({
      pendingLimit: pendingRecordingLimit(
        configuration.databaseControlConnections,
      ),
      trail,
    }),
    cursors: createCursorCipher(configuration.cursorKey),
    eventLog,
    keyRing,
    reader: createNoticeReader(reader, configuration.databaseSchema),
    rejections,
    settings: configuration,
    usedAssertions: createUsedAssertions(configuration.clock),
    verifier: assertionVerifier,
  });
  const noticeWake = { name: 'noticeWake', run: () => channel.wake() };
  // Every change committed through it wakes the streams to its notices before it is answered.
  const wakingTrail = afterCommitTrail({
    log: eventLog,
    steps: [noticeWake],
    trail,
  });
  // What each step a Management API operation may name runs.
  const namedSteps: Readonly<
    Record<AfterCommitStepName, AfterCommitStep['run']>
  > = { keyReload: () => keyRing.reload() };
  // One verifier for every route verifying the identity provider's tokens, so the keys fetched for
  // one are held for all, and their fetches share one cooldown.
  const tokenVerifier = createTokenVerifier(configuration, eventLog);
  // The shares divide the exchange pool the instance holds; the registered count follows each read of
  // the key ring.
  const admission = createAdmission({
    poolSize: configuration.databaseExchangeConnections,
    registeredCount: () => keyRing.registeredCount(),
  });
  const exchange = createExchange({
    admission,
    assertionRecordingLimit: pendingRecordingLimit(
      configuration.databaseExchangeConnections,
    ),
    assertionRefusals,
    assertionRejections: rejections,
    assertions: assertionVerifier,
    deadlineMilliseconds: EXCHANGE_DEADLINE_MILLISECONDS,
    eventLog,
    judgeCredential: (credential, context) =>
      judgeSignInCredential(credential, {
        ...context,
        signInTokenMaximumLifetimeSeconds:
          configuration.signInTokenMaximumLifetimeSeconds,
        verifier: tokenVerifier,
      }),
    keyConfirmations: createKeyConfirmations({
      eventLog,
      settings: configuration,
      trail: exchangeTrail,
    }),
    lateRequestThresholdMilliseconds: LATE_REQUEST_THRESHOLD_MILLISECONDS,
    monotonicNow: () => performance.now(),
    settings: configuration,
    sharesExceeded,
    tokenLimitBytes: TOKEN_LIMIT_BYTES,
    trail: exchangeTrail,
  });
  const management: ManagementDependencies = {
    eventLog,
    refusalTally,
    runAfterCommit: (names) =>
      runAfterCommit({
        log: eventLog,
        steps: names.map((name) => ({ name, run: namedSteps[name] })),
      }),
    settings: configuration,
    storedRefusal: (question) =>
      readStoredRefusal(reader, configuration.databaseSchema, question),
    tokenVerifier,
    trail: wakingTrail,
  };
  const readiness = createReadiness({
    isLogWritable: () => eventLog.isWritable(),
    isServing: () => lifecycle.ready,
    log: eventLog,
    monotonicNow: () => performance.now(),
    // Any answer but off reads as read-only, so a store whose answer cannot be read never passes.
    probeStore: async () => ({
      readOnly:
        (await readinessReader.query<{ readOnly: string }>(STORE_PROBE)).rows[0]
          ?.readOnly !== 'off',
    }),
    writesStore: () => lifecycle.writes,
  });
  const server = createServer({
    // The instance is live while its event log can still be written.
    isLive: () => eventLog.isWritable(),
    isReady: readiness.isReady,
    trustedProxies: configuration.trustedProxies,
  });
  [
    ...createApplicationRoutes(
      {
        cipher,
        settings: configuration,
        store: reader,
        trail: wakingTrail,
      },
      management,
    ),
    ...createResourceRoutes(
      { settings: configuration, store: reader, trail: wakingTrail },
      management,
    ),
    ...createGrantRoutes(
      {
        grantStoreOf: (connection) =>
          sqlGrantStore(connection, {
            issuer: configuration.identityProviderIssuer,
            schema: configuration.databaseSchema,
          }),
        settings: configuration,
        store: reader,
        trail: wakingTrail,
      },
      management,
    ),
    ...channel.routes,
    exchange.route,
    createSignOutRoute({
      eventLog,
      refusalTally: logoutTokenRefusals,
      settings: configuration,
      tokenVerifier,
      trail: wakingTrail,
    }),
    ...createApiDocsRoutes(configuration, eventLog),
  ].forEach((route) => {
    server.route(route);
  });

  const startOnce = async (): Promise<{ url: URL }> => {
    const { writes } = await prepareStore(trail, configuration, eventLog);
    lifecycle.writes = writes;
    // Checks the statement limits of the exchange's and readiness's pools. The control pool's must
    // already have been checked, in prepareStore's transaction.
    await Promise.all(
      [exchangeReader, readinessReader].map((poolReader) =>
        checkStatementLimits(poolReader, configuration),
      ),
    );
    await keyRing.start();
    await server.listen({ host: configuration.host, port: configuration.port });
    refusalTally.start();
    logoutTokenRefusals.start();
    assertionRejections.start();
    sharesExceeded.start();
    // A role that may only read deletes nothing, so its runs could only fail.
    if (writes) {
      sweep.start();
    }
    lifecycle.ready = lifecycle.stopped === undefined;
    return { url: urlOf(server.server.address()) };
  };

  const stopOnce = async (): Promise<void> => {
    lifecycle.ready = false;
    // Stopped before anything is awaited, so no run of the sweep begins once the stop has.
    const sweepStopped = sweep.stop();
    await lifecycle.started?.catch(() => undefined);
    try {
      try {
        await channel.stop();
        await server.close();
      } finally {
        await Promise.all([
          refusalTally.stop(),
          logoutTokenRefusals.stop(),
          // The rejection tally stops after the assertion refusals, so any count they make while
          // stopping reaches it.
          assertionRefusals.stop().then(() => assertionRejections.stop()),
          sharesExceeded.stop(),
          keyRing.stop(),
          sweepStopped,
        ]);
      }
    } finally {
      try {
        await Promise.all(pools.map((pool) => pool.end()));
      } finally {
        eventLog.close();
      }
    }
  };

  return {
    start: () => {
      if (lifecycle.started === undefined && lifecycle.stopped === undefined) {
        lifecycle.started = startOnce();
        return lifecycle.started;
      }
      return Promise.reject(
        new ControllerError('a controller starts once, and never once stopped'),
      );
    },
    stop: () => {
      lifecycle.stopped ??= stopOnce();
      return lifecycle.stopped;
    },
  };
};
