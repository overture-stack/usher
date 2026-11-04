import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
  type BoundedMapRemoval,
  createBoundedMap,
  type Expiry,
} from './boundedMap.js';
import type { Clocks } from './clocks.js';

/** Clocks moved by hand from 0, since an entry set at time 0 must still expire. */
const handClocks = (): Clocks & {
  advanceMonotonic: (ms: number) => void;
  setWall: (ms: number) => void;
} => {
  const readings = { monotonic: 0, wall: 0 };

  return {
    advanceMonotonic: (ms) => {
      readings.monotonic += ms;
    },
    monotonic: { now: () => readings.monotonic },
    setWall: (ms) => {
      readings.wall = ms;
    },
    wall: { now: () => readings.wall },
  };
};

const NEVER = Number.POSITIVE_INFINITY;

const until = (monotonicMs: number, wallMs = NEVER): Expiry => ({
  monotonicMs,
  wallMs,
});

const recordingRemovals = (): {
  onRemove: (removal: BoundedMapRemoval<string, string>) => void;
  removals: BoundedMapRemoval<string, string>[];
} => {
  const removals: BoundedMapRemoval<string, string>[] = [];

  return { onRemove: (removal) => removals.push(removal), removals };
};

suite('createBoundedMap', () => {
  suite('expiry', () => {
    test('returns a value read before its expiry', () => {
      const clocks = handClocks();
      const map = createBoundedMap<string, string>({ clocks, max: 4 });
      map.set('digest-a', 'entry-a', until(1_000));

      clocks.advanceMonotonic(999);

      assert.equal(map.get('digest-a'), 'entry-a');
    });

    test('drops an entry at the exact instant of its monotonic expiry, as a JWT exp means', () => {
      const clocks = handClocks();
      const { onRemove, removals } = recordingRemovals();
      const map = createBoundedMap<string, string>({
        clocks,
        max: 4,
        onRemove,
      });
      map.set('digest-a', 'entry-a', until(1_000));

      clocks.advanceMonotonic(1_000);

      assert.equal(map.get('digest-a'), undefined);
      assert.deepEqual(removals, [
        { key: 'digest-a', reason: 'expire', value: 'entry-a' },
      ]);
    });

    test('drops an entry at its wall-clock expiry while its monotonic bound is far off', () => {
      const clocks = handClocks();
      const map = createBoundedMap<string, string>({ clocks, max: 4 });
      map.set('digest-a', 'entry-a', until(NEVER, 5_000));

      clocks.setWall(5_000);

      assert.equal(map.get('digest-a'), undefined);
    });

    test('expires an entry set at time 0 like any other, rather than reading 0 as no expiry', () => {
      const clocks = handClocks();
      const map = createBoundedMap<string, string>({ clocks, max: 4 });
      map.set('digest-a', 'entry-a', until(0 + 300));

      clocks.advanceMonotonic(300);

      assert.equal(map.get('digest-a'), undefined);
    });

    test('ends an entry at its monotonic bound even when the wall clock steps backward', () => {
      const clocks = handClocks();
      clocks.setWall(100_000);
      const map = createBoundedMap<string, string>({ clocks, max: 4 });
      map.set('digest-a', 'entry-a', until(1_000, 200_000));

      clocks.setWall(70_000);
      clocks.advanceMonotonic(1_000);

      assert.equal(map.get('digest-a'), undefined);
    });

    test('runs no timer of its own: an expired entry stays until it is read, then is removed', () => {
      const clocks = handClocks();
      const { onRemove, removals } = recordingRemovals();
      const map = createBoundedMap<string, string>({
        clocks,
        max: 4,
        onRemove,
      });
      map.set('digest-a', 'entry-a', until(1_000));

      clocks.advanceMonotonic(5_000);

      assert.deepEqual(removals, []);
      assert.equal(map.get('digest-a'), undefined);
      assert.equal(removals.length, 1);
    });
  });

  suite('the bound', () => {
    test('evicts the least recently used entry once a set passes the bound, counting a read as use', () => {
      const clocks = handClocks();
      const { onRemove, removals } = recordingRemovals();
      const map = createBoundedMap<string, string>({
        clocks,
        max: 2,
        onRemove,
      });
      map.set('digest-a', 'entry-a', until(NEVER));
      map.set('digest-b', 'entry-b', until(NEVER));
      map.get('digest-a');

      map.set('digest-c', 'entry-c', until(NEVER));

      assert.equal(map.get('digest-b'), undefined);
      assert.equal(map.get('digest-a'), 'entry-a');
      assert.equal(map.get('digest-c'), 'entry-c');
      assert.deepEqual(removals, [
        { key: 'digest-b', reason: 'evict', value: 'entry-b' },
      ]);
    });

    test('holds no more entries than its bound through a flood', () => {
      const clocks = handClocks();
      const map = createBoundedMap<string, string>({ clocks, max: 100 });

      for (const index of Array.from({ length: 10_000 }, (_, at) => at)) {
        map.set(`digest-${index}`, 'entry', until(NEVER));
      }

      assert.equal(map.size(), 100);
      assert.equal(map.get('digest-9999'), 'entry');
      assert.equal(map.get('digest-9899'), undefined);
    });

    for (const max of [0, -1, 1.5, Number.NaN, NEVER]) {
      test(`refuses a bound of ${max}, which is not a positive integer`, () => {
        assert.throws(() =>
          createBoundedMap<string, string>({ clocks: handClocks(), max }),
        );
      });
    }
  });

  suite('removal', () => {
    test('reports the value a set replaces, so an index of values stays in step', () => {
      const clocks = handClocks();
      const { onRemove, removals } = recordingRemovals();
      const map = createBoundedMap<string, string>({
        clocks,
        max: 4,
        onRemove,
      });
      map.set('digest-a', 'first', until(NEVER));

      map.set('digest-a', 'second', until(NEVER));

      assert.equal(map.get('digest-a'), 'second');
      assert.deepEqual(removals, [
        { key: 'digest-a', reason: 'replace', value: 'first' },
      ]);
    });

    test('reports a delete, and deleting an absent key reports nothing', () => {
      const clocks = handClocks();
      const { onRemove, removals } = recordingRemovals();
      const map = createBoundedMap<string, string>({
        clocks,
        max: 4,
        onRemove,
      });
      map.set('digest-a', 'entry-a', until(NEVER));

      const deleted = map.delete('digest-a');
      const deletedAgain = map.delete('digest-a');

      assert.equal(deleted, true);
      assert.equal(deletedAgain, false);
      assert.deepEqual(removals, [
        { key: 'digest-a', reason: 'delete', value: 'entry-a' },
      ]);
    });

    test('drops every entry a predicate matches, reports each, and counts them', () => {
      const clocks = handClocks();
      const { onRemove, removals } = recordingRemovals();
      const map = createBoundedMap<string, string>({
        clocks,
        max: 4,
        onRemove,
      });
      map.set('digest-a', 'names HEART_STUDY', until(NEVER));
      map.set('digest-b', 'names LUNG_COHORT', until(NEVER));
      map.set('digest-c', 'names HEART_STUDY', until(NEVER));

      const dropped = map.deleteWhere((value) => value.includes('HEART_STUDY'));

      assert.equal(dropped, 2);
      assert.equal(map.get('digest-b'), 'names LUNG_COHORT');
      assert.deepEqual(
        removals.map(({ key, reason }) => [key, reason]),
        [
          ['digest-a', 'delete'],
          ['digest-c', 'delete'],
        ],
      );
    });

    test('counts no expired entry among those a predicate drops, reporting it as expired', () => {
      const clocks = handClocks();
      const { onRemove, removals } = recordingRemovals();
      const map = createBoundedMap<string, string>({
        clocks,
        max: 4,
        onRemove,
      });
      map.set('digest-a', 'names HEART_STUDY', until(100));
      map.set('digest-b', 'names HEART_STUDY', until(NEVER));
      clocks.advanceMonotonic(100);

      const dropped = map.deleteWhere((value) => value.includes('HEART_STUDY'));

      assert.equal(dropped, 1);
      assert.deepEqual(
        removals.map(({ key, reason }) => [key, reason]),
        [
          ['digest-a', 'expire'],
          ['digest-b', 'delete'],
        ],
      );
    });

    test('clears every entry, reporting each, and counts the live ones', () => {
      const clocks = handClocks();
      const { onRemove, removals } = recordingRemovals();
      const map = createBoundedMap<string, string>({
        clocks,
        max: 4,
        onRemove,
      });
      map.set('digest-a', 'entry-a', until(NEVER));
      map.set('digest-b', 'entry-b', until(NEVER));

      const cleared = map.clear();

      assert.equal(cleared, 2);
      assert.equal(map.size(), 0);
      assert.deepEqual(
        removals.map(({ reason }) => reason),
        ['clear', 'clear'],
      );
    });
  });
});
