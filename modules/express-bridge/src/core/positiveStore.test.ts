import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type { Expiry } from './boundedMap.js';
import type { Clocks } from './clocks.js';
import { createPositiveStore, type IndexedEntry } from './positiveStore.js';

const NEVER = Number.POSITIVE_INFINITY;

const forever: Expiry = { monotonicMs: NEVER, wallMs: NEVER };

const handClocks = (): Clocks & { advance: (ms: number) => void } => {
  const reading = { now: 0 };

  return {
    advance: (ms) => {
      reading.now += ms;
    },
    monotonic: { now: () => reading.now },
    wall: { now: () => reading.now },
  };
};

const entryFor = (
  subjectTag: string,
  resources: readonly string[],
): IndexedEntry => ({ resources: new Set(resources), subjectTag });

suite('createPositiveStore', () => {
  test('drops every entry indexed under a subject tag, counting them, and leaves other subjects alone', () => {
    const store = createPositiveStore<IndexedEntry>({
      clocks: handClocks(),
      max: 8,
    });
    store.set('digest-laptop', entryFor('tag-ana', ['HEART_STUDY']), forever);
    store.set('digest-phone', entryFor('tag-ana', ['HEART_STUDY']), forever);
    store.set('digest-ben', entryFor('tag-ben', ['HEART_STUDY']), forever);

    const dropped = store.dropSubjectTag('tag-ana');

    assert.equal(dropped, 2);
    assert.equal(store.get('digest-laptop'), undefined);
    assert.equal(store.get('digest-phone'), undefined);
    assert.notEqual(store.get('digest-ben'), undefined);
  });

  test('unindexes an evicted entry, so its tag never reaches the digest once another subject holds it', () => {
    const store = createPositiveStore<IndexedEntry>({
      clocks: handClocks(),
      max: 1,
    });
    store.set('digest-reused', entryFor('tag-ana', ['HEART_STUDY']), forever);
    store.set('digest-other', entryFor('tag-ben', ['HEART_STUDY']), forever);
    store.set('digest-reused', entryFor('tag-cy', ['HEART_STUDY']), forever);

    const dropped = store.dropSubjectTag('tag-ana');

    assert.equal(dropped, 0);
    assert.notEqual(store.get('digest-reused'), undefined);
  });

  test('unindexes an expired entry, so its tag never reaches the digest once another subject holds it', () => {
    const clocks = handClocks();
    const store = createPositiveStore<IndexedEntry>({ clocks, max: 8 });
    store.set('digest-reused', entryFor('tag-ana', ['HEART_STUDY']), {
      monotonicMs: 100,
      wallMs: NEVER,
    });
    clocks.advance(100);
    store.get('digest-reused');
    store.set('digest-reused', entryFor('tag-ben', ['HEART_STUDY']), forever);

    const dropped = store.dropSubjectTag('tag-ana');

    assert.equal(dropped, 0);
    assert.notEqual(store.get('digest-reused'), undefined);
  });

  test('moves a replaced entry to its new subject tag, so the old tag no longer reaches it', () => {
    const store = createPositiveStore<IndexedEntry>({
      clocks: handClocks(),
      max: 8,
    });
    store.set('digest-shared', entryFor('tag-ana', ['HEART_STUDY']), forever);
    store.set('digest-shared', entryFor('tag-ben', ['HEART_STUDY']), forever);

    const droppedForAna = store.dropSubjectTag('tag-ana');
    const droppedForBen = store.dropSubjectTag('tag-ben');

    assert.equal(droppedForAna, 0);
    assert.equal(droppedForBen, 1);
  });

  test('finds a subject tag again after every entry under it has gone', () => {
    const store = createPositiveStore<IndexedEntry>({
      clocks: handClocks(),
      max: 8,
    });
    store.set('digest-first', entryFor('tag-ana', ['HEART_STUDY']), forever);
    store.dropSubjectTag('tag-ana');
    store.set('digest-second', entryFor('tag-ana', ['HEART_STUDY']), forever);

    const dropped = store.dropSubjectTag('tag-ana');

    assert.equal(dropped, 1);
  });

  test('drops every entry naming a resource, counting them, by scanning the store', () => {
    const store = createPositiveStore<IndexedEntry>({
      clocks: handClocks(),
      max: 8,
    });
    store.set(
      'digest-ana',
      entryFor('tag-ana', ['HEART_STUDY', 'LUNG_COHORT']),
      forever,
    );
    store.set('digest-ben', entryFor('tag-ben', ['LUNG_COHORT']), forever);
    store.set('digest-cy', entryFor('tag-cy', ['REEF_ARCHIVE']), forever);

    const dropped = store.dropResource('LUNG_COHORT');

    assert.equal(dropped, 2);
    assert.equal(store.get('digest-ana'), undefined);
    assert.notEqual(store.get('digest-cy'), undefined);
  });

  test('clears every entry and its index, counting them', () => {
    const store = createPositiveStore<IndexedEntry>({
      clocks: handClocks(),
      max: 8,
    });
    store.set('digest-ana', entryFor('tag-ana', ['HEART_STUDY']), forever);
    store.set('digest-ben', entryFor('tag-ben', ['HEART_STUDY']), forever);

    const cleared = store.clear();

    assert.equal(cleared, 2);
    assert.equal(store.dropSubjectTag('tag-ana'), 0);
    assert.equal(store.size(), 0);
  });
});
