import type { ResourceIdentifier } from '@overture-stack/usher-types';

import { createBoundedMap, type Expiry } from './boundedMap.js';
import type { Clocks } from './clocks.js';

/** The part of each entry read by the positive store. */
export interface IndexedEntry {
  /** The resources named by the entry's payload. */
  resources: ReadonlySet<ResourceIdentifier>;

  /**
   * The per-audience tag of the subject named by the decrypted payload, as principal notices carry
   * it.
   */
  subjectTag: string;
}

/** The store of exchanged credentials, keyed by digest and indexed by subject tag. */
export interface PositiveStore<Entry extends IndexedEntry> {
  /** Drops every entry, and returns how many had not expired. */
  clear(): number;

  /**
   * Drops every live entry naming the resource, and every expired entry, and returns how many live
   * entries it dropped.
   */
  dropResource(resource: ResourceIdentifier): number;

  /** Drops every entry indexed under the subject tag, and returns how many had not expired. */
  dropSubjectTag(subjectTag: string): number;

  /** The entry for a digest while it has not expired. */
  get(digest: string): Entry | undefined;

  /** Holds an entry until its expiry, replacing any under the digest. */
  set(digest: string, entry: Entry, expiry: Expiry): void;

  /** The entries held, including any that have expired but not yet been read. */
  size(): number;
}

/**
 * Creates the positive store, holding at most `max` entries, the least recently used evicted first,
 * each until its own expiry.
 *
 * @throws {RangeError} for a bound that is not a positive whole number.
 */
export const createPositiveStore = <Entry extends IndexedEntry>({
  clocks,
  max,
}: {
  clocks: Clocks;
  max: number;
}): PositiveStore<Entry> => {
  // The bounded map's removal hook keeps this index in step through every eviction, expiry,
  // replacement, delete and clear.
  const digestsByTag = new Map<string, Set<string>>();

  const entries = createBoundedMap<string, Entry>({
    clocks,
    max,
    onRemove: ({ key, value }) => {
      const digests = digestsByTag.get(value.subjectTag);
      digests?.delete(key);
      if (digests?.size === 0) {
        digestsByTag.delete(value.subjectTag);
      }
    },
  });

  return {
    clear: () => entries.clear(),

    // Answered by scanning: a resource index would hold millions of memberships at scale.
    dropResource: (resource) =>
      entries.deleteWhere((entry) => entry.resources.has(resource)),

    dropSubjectTag: (subjectTag) => {
      const digests = Array.from(digestsByTag.get(subjectTag) ?? []);
      const removed = digests.map((digest) => entries.delete(digest));
      return removed.filter(Boolean).length;
    },

    get: (digest) => entries.get(digest),

    set: (digest, entry, expiry) => {
      entries.set(digest, entry, expiry);
      digestsByTag.set(
        entry.subjectTag,
        (digestsByTag.get(entry.subjectTag) ?? new Set()).add(digest),
      );
    },

    size: () => entries.size(),
  };
};
