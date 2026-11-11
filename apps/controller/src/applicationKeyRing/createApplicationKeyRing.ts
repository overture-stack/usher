import pg from 'pg';

import type { Actor, AuditEvent } from '../eventLog/index.js';
import { failureCodeOf } from '../failures/index.js';
import { CommitUnconfirmed } from '../storeTimeout/index.js';
import { applicationSubkeys } from './applicationSubkeys.js';
import type {
  ApplicationKeyRing,
  ApplicationKeyRingSettings,
  LiveApplicationKey,
} from './types.js';

/**
 * How long after its last read the ring reads the live keys again, beside the reloads asked for, in
 * milliseconds of the configured clock: 30 s.
 */
export const KEY_RELOAD_INTERVAL_MILLISECONDS = 30_000;

// How often the clock is read for the reload interval's end, in real time: the configured clock may be
// moved past the interval at any moment, and the reload is due soon after. A reload is due one reading
// early, so one paced by a clock running in real time begins before the interval has passed.
const CLOCK_READING_MILLISECONDS = 1000;

const SYSTEM: Actor = Object.freeze({ type: 'system' });

/** The line naming a read of the live keys that failed, the keys held before kept. */
export const KEY_READ_FAILED = 'applicationKeyRing.readFailed';

/** The line naming a failure of what a change to the live keys calls; the keys read are held. */
export const KEY_CHANGE_FAILED = 'applicationKeyRing.changeFailed';

/**
 * The line naming a key found unreadable whose `applicationKey.unreadable` the store did not take; the
 * next read finding it unreadable records it.
 */
export const KEY_UNREADABLE_UNRECORDED =
  'applicationKeyRing.unreadableUnrecorded';

interface KeyRow {
  applicationId: string;
  keyId: string | null;
  sealed: Buffer | null;
}

interface UnreadableKey {
  applicationId: string;
  keyId: string;
}

interface Held {
  byApplication: ReadonlyMap<string, readonly LiveApplicationKey[]>;
  unreadable: readonly UnreadableKey[];
}

const NOTHING_HELD: Held = Object.freeze({
  byApplication: new Map(),
  unreadable: [],
});

// The failure by its code alone, where it carries one, since a store's message may quote a value.
const codeOf = (failure: unknown): Readonly<Record<string, string>> => {
  const code: unknown =
    typeof failure === 'object' && failure !== null && 'code' in failure
      ? failure.code
      : undefined;
  return typeof code === 'string' ? { code } : {};
};

const unreadableEvent = ({
  applicationId,
  keyId,
}: UnreadableKey): AuditEvent => ({
  data: { applicationId, keyId },
  severity: 'critical',
  type: 'applicationKey.unreadable',
});

// Which keys are live, as one text, to tell whether a read changed them.
const liveKeysText = ({ byApplication }: Held): string =>
  [...byApplication.values()]
    .flat()
    .map(({ applicationId, keyId }) => `${applicationId}/${keyId}`)
    .toSorted()
    .join('\n');

/**
 * Creates the ring of live application keys an instance holds in memory, so a channel assertion is
 * verified with no read of the store. Each read takes every registered application and its keys not
 * revoked, opens each sealed key, derives its subkeys and zero-fills its bytes. A key that does not
 * open is left out at once, so its application is refused as one holding no other live key would be,
 * and is then recorded as `applicationKey.unreadable`, critical, naming its application and itself,
 * as the system, in a transaction of its own: once while it stays unreadable, again should it open or
 * be revoked and then stop opening, and at the next read should its recording not commit. A recording
 * that fails is written to the log naming the application, the key and the failure's code alone; one
 * whose commit went unconfirmed is named by the trail's own line. The ring reads at its start, then
 * whenever its configured clock reads within one second of {@link KEY_RELOAD_INTERVAL_MILLISECONDS}
 * past the start of its last read, or earlier than it, reading the clock every second of real time,
 * so a read the clock paces begins within the interval; and whenever a reload is asked for, reloads
 * asked for while a read is in flight sharing the one read begun after it. A read that changes which keys are live calls `changed`, whose failure is written to the log by
 * its code and never undoes the read; one that fails keeps the keys held and is written to the log by
 * its code.
 *
 * @param settings the store, the schema, the cipher, the clock, the trail, the log, and what to call
 *   on a change.
 */
export const createApplicationKeyRing = ({
  changed,
  cipher,
  clock,
  log,
  schema,
  store,
  trail,
}: ApplicationKeyRingSettings): ApplicationKeyRing => {
  const table = (name: string): string =>
    `${pg.escapeIdentifier(schema)}.${name}`;
  const statement = `SELECT application.id::text AS "applicationId", held.id::text AS "keyId",
         held.encrypted_key AS sealed
    FROM ${table('applications')} application
    LEFT JOIN ${table('application_keys')} held
      ON held.application_id = application.id AND held.revoked_at IS NULL
   ORDER BY application.id, held.issued_at, held.id`;

  const state: {
    held: Held;
    queued: Promise<void> | undefined;

    /** The clock's instant as the last read began. */
    readAt: number;

    reading: Promise<void> | undefined;

    /** The ids of the keys recorded unreadable, each unreadable at every read since. */
    recorded: ReadonlySet<string>;

    stopped: boolean;
    timer: ReturnType<typeof setInterval> | undefined;
  } = {
    held: NOTHING_HELD,
    queued: undefined,
    readAt: clock.now(),
    reading: undefined,
    recorded: new Set(),
    stopped: false,
    timer: undefined,
  };

  const opened = (
    applicationId: string,
    keyId: string,
    sealed: Buffer,
  ): LiveApplicationKey | undefined => {
    const key = cipher.open({ applicationId, keyId }, sealed);
    if (key === undefined) {
      return undefined;
    }
    try {
      return { applicationId, keyId, ...applicationSubkeys(key) };
    } finally {
      key.fill(0);
    }
  };

  const heldFrom = (rows: readonly KeyRow[]): Held => {
    const keys = rows.flatMap(({ applicationId, keyId, sealed }) =>
      keyId === null || sealed === null
        ? []
        : [
            {
              applicationId,
              keyId,
              live: opened(applicationId, keyId, sealed),
            },
          ],
    );
    return {
      byApplication: new Map(
        [...new Set(rows.map(({ applicationId }) => applicationId))].map(
          (applicationId) => [
            applicationId,
            keys.flatMap(({ applicationId: holder, live }) =>
              holder === applicationId && live !== undefined ? [live] : [],
            ),
          ],
        ),
      ),
      unreadable: keys.flatMap(({ applicationId, keyId, live }) =>
        live === undefined ? [{ applicationId, keyId }] : [],
      ),
    };
  };

  // Records each key in turn, giving the ids of those whose recording committed; one that did not is
  // recorded at the next read finding the key unreadable.
  const recordUnreadable = (
    keys: readonly UnreadableKey[],
  ): Promise<readonly string[]> =>
    keys.reduce<Promise<readonly string[]>>(async (earlier, key) => {
      const committed = await earlier;
      try {
        await trail.inTransaction(SYSTEM, ({ record }) =>
          record(unreadableEvent(key)),
        );
        return [...committed, key.keyId];
      } catch (failure) {
        if (failure instanceof CommitUnconfirmed) {
          return committed;
        }
        const code = failureCodeOf(failure);
        log.error(KEY_UNREADABLE_UNRECORDED, {
          applicationId: key.applicationId,
          ...(code === undefined ? {} : { code }),
          keyId: key.keyId,
        });
        return committed;
      }
    }, Promise.resolve([]));

  // The keys are held before any is recorded, so a key that does not open is refused at once.
  const hold = async (next: Held): Promise<void> => {
    const before = state.held;
    state.held = next;
    if (liveKeysText(before) !== liveKeysText(next)) {
      try {
        changed();
      } catch (failure) {
        log.error(KEY_CHANGE_FAILED, codeOf(failure));
      }
    }
    const stillRecorded = new Set(
      next.unreadable
        .map(({ keyId }) => keyId)
        .filter((keyId) => state.recorded.has(keyId)),
    );
    const committed = await recordUnreadable(
      next.unreadable.filter(({ keyId }) => !stillRecorded.has(keyId)),
    );
    state.recorded = new Set([...stillRecorded, ...committed]);
  };

  const read = async (): Promise<Held> => {
    state.readAt = clock.now();
    return heldFrom((await store.query<KeyRow>(statement)).rows);
  };

  // Due once the interval since the last read began would pass before the next reading of the clock,
  // or once the clock reads earlier than that instant, since a clock moved back would otherwise hold
  // off every read until it caught up.
  const isDue = (): boolean => {
    const elapsed = clock.now() - state.readAt;
    return (
      elapsed + CLOCK_READING_MILLISECONDS >=
        KEY_RELOAD_INTERVAL_MILLISECONDS || elapsed < 0
    );
  };

  const readOnce = (): Promise<void> => {
    const reading = read()
      .then(
        async (next) => {
          if (!state.stopped) {
            await hold(next);
          }
        },
        (failure: unknown) => {
          log.error(KEY_READ_FAILED, codeOf(failure));
        },
      )
      .finally(() => {
        if (state.reading === reading) {
          state.reading = undefined;
        }
      });
    state.reading = reading;
    return reading;
  };

  const reload = (): Promise<void> => {
    if (state.stopped) {
      return Promise.resolve();
    }
    if (state.queued !== undefined) {
      return state.queued;
    }
    if (state.reading === undefined) {
      return readOnce();
    }
    const queued = state.reading.then(() => {
      state.queued = undefined;
      return state.stopped ? undefined : readOnce();
    });
    state.queued = queued;
    return queued;
  };

  return {
    holds: ({ applicationId, keyId }) =>
      (state.held.byApplication.get(applicationId) ?? []).some(
        (key) => key.keyId === keyId,
      ),

    liveKeysOf: (applicationId) => state.held.byApplication.get(applicationId),

    reload,

    start: async () => {
      await hold(await read());
      state.timer = setInterval(() => {
        if (isDue()) {
          void reload();
        }
      }, CLOCK_READING_MILLISECONDS);
      state.timer.unref();
    },

    stop: async () => {
      state.stopped = true;
      clearInterval(state.timer);
      state.timer = undefined;
      await state.queued;
      await state.reading;
    },
  };
};
