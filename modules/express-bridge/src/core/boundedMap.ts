import type { Clocks } from './clocks.js';
import { positiveWhole } from './numbers.js';

/**
 * When an entry ends: the first of an instant on the monotonic clock and one on the wall clock. An
 * instant of `Infinity` leaves that clock without a bound.
 */
export interface Expiry {
  monotonicMs: number;
  wallMs: number;
}

/**
 * Whether an expiry has passed on either of its clocks, from the exact instant it names on, as a JWT
 * `exp` means.
 */
export const hasExpired = (clocks: Clocks, expiry: Expiry): boolean =>
  clocks.monotonic.now() >= expiry.monotonicMs ||
  clocks.wall.now() >= expiry.wallMs;

/** Why an entry left the map. */
export type RemovalReason = 'clear' | 'delete' | 'evict' | 'expire' | 'replace';

/** One entry leaving the map, as its removal hook receives it. */
export interface BoundedMapRemoval<Key, Value> {
  key: Key;
  reason: RemovalReason;
  value: Value;
}

/** What {@link createBoundedMap} needs. */
export interface BoundedMapOptions<Key, Value> {
  /** The clocks against which each expiry is read. */
  clocks: Clocks;

  /** The most entries held at once: a positive whole number. */
  max: number;

  /** Called once for every entry that leaves the map, whatever the reason. */
  onRemove?: (removal: BoundedMapRemoval<Key, Value>) => void;
}

/** A map kept in recency order, holding at most its bound, each entry ending at its own expiry. */
export interface BoundedMap<Key, Value> {
  /** Removes every entry, and returns how many had not expired. */
  clear(): number;

  /** Removes the entry, and returns whether a live one was there. */
  delete(key: Key): boolean;

  /**
   * Removes every live entry accepted by `matches`, and every expired entry, and returns how many
   * live entries it removed.
   */
  deleteWhere(matches: (value: Value, key: Key) => boolean): number;

  /** The entry's value while it has not expired, counting the read as use. */
  get(key: Key): Value | undefined;

  /** Holds the value until its expiry, replacing any entry under the key. */
  set(key: Key, value: Value, expiry: Expiry): void;

  /** The entries held, including any that have expired but not yet been read. */
  size(): number;
}

interface Slot<Value> {
  expiry: Expiry;
  value: Value;
}

/**
 * Creates a bounded map, holding at most `max` entries, the least recently used evicted first, each
 * until its own expiry. It runs no timer: an entry is found expired when it is next read, at the
 * exact instant of its expiry, as a JWT `exp` means, and never later.
 *
 * @throws {RangeError} for a bound that is not a positive whole number.
 */
export const createBoundedMap = <Key, Value>({
  clocks,
  max,
  onRemove = () => undefined,
}: BoundedMapOptions<Key, Value>): BoundedMap<Key, Value> => {
  const bound = positiveWhole(max, 'the bound on a store');
  const slots = new Map<Key, Slot<Value>>();

  const isExpired = ({ expiry }: Slot<Value>): boolean =>
    hasExpired(clocks, expiry);

  const remove = (key: Key, slot: Slot<Value>, reason: RemovalReason): void => {
    slots.delete(key);
    onRemove({ key, reason, value: slot.value });
  };

  /** Every entry, each with whether it has expired, read once. */
  const heldNow = (): readonly {
    expired: boolean;
    key: Key;
    slot: Slot<Value>;
  }[] =>
    Array.from(slots, ([key, slot]) => ({
      expired: isExpired(slot),
      key,
      slot,
    }));

  const removeOldestBeyondBound = (): void => {
    const [oldest] = slots;
    if (slots.size > bound && oldest !== undefined) {
      remove(oldest[0], oldest[1], 'evict');
    }
  };

  return {
    clear: () => {
      const held = heldNow();
      held.forEach(({ key, slot }) => remove(key, slot, 'clear'));
      return held.filter(({ expired }) => !expired).length;
    },

    delete: (key) => {
      const slot = slots.get(key);
      if (slot === undefined) {
        return false;
      }
      const live = !isExpired(slot);
      remove(key, slot, live ? 'delete' : 'expire');
      return live;
    },

    deleteWhere: (matches) => {
      const held = heldNow();
      held
        .filter(({ expired }) => expired)
        .forEach(({ key, slot }) => remove(key, slot, 'expire'));
      const matched = held.filter(
        ({ expired, key, slot }) => !expired && matches(slot.value, key),
      );
      matched.forEach(({ key, slot }) => remove(key, slot, 'delete'));
      return matched.length;
    },

    get: (key) => {
      const slot = slots.get(key);
      if (slot === undefined) {
        return undefined;
      }
      if (isExpired(slot)) {
        remove(key, slot, 'expire');
        return undefined;
      }
      slots.delete(key);
      slots.set(key, slot);
      return slot.value;
    },

    set: (key, value, expiry) => {
      const replaced = slots.get(key);
      if (replaced !== undefined) {
        remove(key, replaced, 'replace');
      }
      slots.set(key, { expiry, value });
      removeOldestBeyondBound();
    },

    size: () => slots.size,
  };
};
