import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';

import type pg from 'pg';

import { createApplicationKeyRing } from '../applicationKeyRing/index.js';
import {
  createApplicationKeyCipher,
  createApplicationRoutes,
} from '../applications/index.js';
import {
  createChannelAssertionVerifier,
  REJECTION_TALLY_INTERVAL_MILLISECONDS,
  rejectionTallyEvent,
  type UnverifiedRejectionReason,
} from '../channelAssertion/index.js';
import type { ControllerConfiguration } from '../configuration/index.js';
import { createAuditTrail, createEventLog } from '../eventLog/index.js';
import { ControllerError } from '../failures/index.js';
import { createServer } from '../http/index.js';
import { createTokenVerifier } from '../identityProvider/index.js';
import {
  type ManagementDependencies,
  readStoredRefusal,
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
import { openStore, prepareStore } from '../store/index.js';
import { createStoreReader } from '../storeTimeout/index.js';
import { createTally } from '../tally/index.js';
import { afterCommitTrail } from './afterCommitTrail.js';
import type { Controller } from './types.js';

// A channel assertion refused unverified, as its tally counts it: by reason, and by the registered
// application it names, or none.
interface RejectionCounted {
  applicationId: string | undefined;
  reason: UnverifiedRejectionReason;
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

// What readiness asks the store: whether it reads as read-only, a statement reading no table.
const STORE_PROBE =
  'SELECT current_setting(\'transaction_read_only\') AS "readOnly"';

/**
 * Creates a controller from its configuration, connecting to nothing until it starts. Its start
 * checks the store before anything listens, so a refused start never accepts a connection, reads the
 * live application keys into memory, and then serves the Management API's application operations,
 * each event they record written to the audit log and the log stream, and the revocation channel's
 * poll and push. A change committed through an operation is held by the instance before it is
 * answered: the live keys are read again, and the instance's streams are woken to its notices; a
 * failure in either is written to the log and never changes the answer. Every unit of its store
 * work, a request's statement or transaction, a recorded event, a read of the keys or the notices, or
 * the start's transaction, runs within the store timeout. Its stop ends every stream, then closes the
 * server, letting requests in flight finish, records the counts its two refusal tallies hold, stops
 * reading the keys, then closes the store's connections and lets go of the log stream. It reports itself ready
 * while it is started, its log stream takes its lines, and its store answers within the store
 * timeout, not reading as read-only when its database role writes, as `createReadiness` judges it,
 * writing each change. It reports itself live until its log stream fails to take a line, which only
 * a restart recovers from, and writes nothing as it stops being live.
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
  const store = openStore(configuration, eventLog);
  const reader = createStoreReader(
    store,
    configuration.storeTimeoutMilliseconds,
  );
  const trail = createAuditTrail<pg.PoolClient>({
    eventLog,
    settings: configuration,
    store,
  });
  const refusalTally = createTally<TallyReason>({
    clock: configuration.clock,
    eventOf: refusalTallyEvent,
    intervalMilliseconds: REFUSAL_TALLY_INTERVAL_MILLISECONDS,
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
  const cipher = createApplicationKeyCipher(configuration.keyEncryptionKey);
  const keyRing = createApplicationKeyRing({
    changed: () => {
      channel.keysChanged();
    },
    cipher,
    log: eventLog,
    schema: configuration.databaseSchema,
    store: reader,
  });
  const channel = createNoticeChannel({
    cursors: createCursorCipher(configuration.cursorKey),
    eventLog,
    keyRing,
    reader: createNoticeReader(reader, configuration.databaseSchema),
    rejections: {
      count: (reason, applicationId) => {
        assertionRejections.count({ applicationId, reason });
      },
    },
    settings: configuration,
    trail,
    usedAssertions: createUsedAssertions(configuration.clock),
    verifier: createChannelAssertionVerifier({
      clock: configuration.clock,
      keyRing,
    }),
  });
  const operationTrail = afterCommitTrail({
    log: eventLog,
    steps: [
      { name: 'noticeWake', run: () => channel.wake() },
      { name: 'keyReload', run: () => keyRing.reload() },
    ],
    trail,
  });
  const management: ManagementDependencies = {
    eventLog,
    refusalTally,
    settings: configuration,
    storedRefusal: (question) =>
      readStoredRefusal(reader, configuration.databaseSchema, question),
    tokenVerifier: createTokenVerifier(configuration, eventLog),
    trail: operationTrail,
  };
  const readiness = createReadiness({
    isLogWritable: () => eventLog.isWritable(),
    isServing: () => lifecycle.ready,
    log: eventLog,
    monotonicNow: () => performance.now(),
    // Any answer but off reads as read-only, so a store whose answer cannot be read never passes.
    probeStore: async () => ({
      readOnly:
        (await reader.query<{ readOnly: string }>(STORE_PROBE)).rows[0]
          ?.readOnly !== 'off',
    }),
    writesStore: () => lifecycle.writes,
  });
  const server = createServer({
    // A log stream that has failed a write takes nothing more until the process restarts, so the
    // instance is not live from then on. Unlike readiness, liveness writes no line as it changes:
    // the line would go to the stream that failed.
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
        trail: operationTrail,
      },
      management,
    ),
    ...channel.routes,
  ].forEach((route) => {
    server.route(route);
  });

  const startOnce = async (): Promise<{ url: URL }> => {
    const { writes } = await prepareStore(trail, configuration, eventLog);
    lifecycle.writes = writes;
    await keyRing.start();
    await server.listen({ host: configuration.host, port: configuration.port });
    refusalTally.start();
    assertionRejections.start();
    lifecycle.ready = lifecycle.stopped === undefined;
    return { url: urlOf(server.server.address()) };
  };

  const stopOnce = async (): Promise<void> => {
    lifecycle.ready = false;
    await lifecycle.started?.catch(() => undefined);
    try {
      try {
        await channel.stop();
        await server.close();
      } finally {
        await Promise.all([
          refusalTally.stop(),
          assertionRejections.stop(),
          keyRing.stop(),
        ]);
      }
    } finally {
      try {
        await store.end();
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
