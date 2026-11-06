import pg from 'pg';

import { applicationSubkeys } from './applicationSubkeys.js';
import type {
  ApplicationKeyRing,
  ApplicationKeyRingSettings,
  LiveApplicationKey,
} from './types.js';

/** How often the ring reads the live keys again beside the reloads asked for, in milliseconds: 30 s. */
export const KEY_RELOAD_INTERVAL_MILLISECONDS = 30_000;

/** The line naming a stored key that does not open, written once while it stays so. */
export const KEY_UNREADABLE = 'applicationKeyRing.keyUnreadable';

/** The line naming a read of the live keys that failed, the keys held before kept. */
export const KEY_READ_FAILED = 'applicationKeyRing.readFailed';

/** The line naming a failure of what a change to the live keys calls; the keys read are held. */
export const KEY_CHANGE_FAILED = 'applicationKeyRing.changeFailed';

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
 * revoked, opens each sealed key, derives its subkeys and zero-fills its bytes; a key that does not
 * open is left out, so its application is refused as one holding no other live key would be, and its
 * ids are written to the log once while it stays so. The ring reads at its start and every
 * {@link KEY_RELOAD_INTERVAL_MILLISECONDS} after, and whenever a reload is asked for: reloads asked
 * for while a read is in flight share the one read begun after it. A read that changes which keys are
 * live calls `changed`, whose failure is written to the log by its code and never undoes the read;
 * one that fails keeps the keys held and is written to the log by its code.
 *
 * @param settings the store, the schema, the cipher, the log, and what to call on a change.
 */
export const createApplicationKeyRing = ({
  changed,
  cipher,
  log,
  schema,
  store,
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
    reading: Promise<void> | undefined;
    stopped: boolean;
    timer: ReturnType<typeof setInterval> | undefined;
  } = {
    held: NOTHING_HELD,
    queued: undefined,
    reading: undefined,
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

  const hold = (next: Held): void => {
    const before = state.held;
    state.held = next;
    next.unreadable
      .filter(
        ({ keyId }) =>
          !before.unreadable.some((unreadable) => unreadable.keyId === keyId),
      )
      .forEach((unreadable) => {
        log.error(KEY_UNREADABLE, { ...unreadable });
      });
    if (liveKeysText(before) !== liveKeysText(next)) {
      try {
        changed();
      } catch (failure) {
        log.error(KEY_CHANGE_FAILED, codeOf(failure));
      }
    }
  };

  const read = async (): Promise<Held> =>
    heldFrom((await store.query<KeyRow>(statement)).rows);

  const readOnce = (): Promise<void> => {
    const reading = read()
      .then(
        (next) => {
          if (!state.stopped) {
            hold(next);
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
      hold(await read());
      state.timer = setInterval(() => {
        void reload();
      }, KEY_RELOAD_INTERVAL_MILLISECONDS);
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
