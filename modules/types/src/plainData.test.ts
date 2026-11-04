import assert from 'node:assert/strict';
import { suite, test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { SQON_MAX_DEPTH } from '@overture-stack/sqon';

import {
  deepFreeze,
  hasOnlyMembers,
  isFrozenData,
  isNonEmptyString,
  isPlainRecord,
  isUsableKey,
  listEntries,
  ownEntries,
  ownMember,
  plainSnapshot,
} from './plainData.js';
import { isDeeplyFrozen } from './testSupport.js';

const PROTO = '__proto__';

suite('isPlainRecord', () => {
  for (const [description, value] of [
    ['an object literal', { sub: null }],
    ['an object with no prototype', Object.create(null)],
    ['an object parsed from JSON', JSON.parse('{"sub":null}')],
    ['an object made in another realm', runInNewContext('({ sub: null })')],
  ] as const) {
    test(`accepts ${description}`, () => {
      const given: unknown = value;

      const plain = isPlainRecord(given);

      assert.equal(plain, true);
    });
  }

  for (const [description, value] of [
    ['null', null],
    ['a list', []],
    ['a class instance', new (class Payload {})()],
    ['a Map', new Map()],
    ['a Date', new Date(0)],
    ['a function', (): void => undefined],
    ['a string', 'sub'],
  ] as const) {
    test(`refuses ${description}`, () => {
      const given: unknown = value;

      const plain = isPlainRecord(given);

      assert.equal(plain, false);
    });
  }
});

suite('ownMember', () => {
  test('reads an own member', () => {
    const record = { sub: 'subject-id' };

    const member = ownMember(record, 'sub');

    assert.equal(member, 'subject-id');
  });

  test('never reads an inherited member, so a polluted prototype supplies nothing', () => {
    const record = Object.create({ sub: null });

    const member = ownMember(record, 'sub');

    assert.equal(member, undefined);
  });
});

suite('ownEntries', () => {
  test('lists every own key, a non-enumerable one and __proto__ included', () => {
    const record = Object.defineProperty(
      JSON.parse('{"__proto__":1,"constructor":2}'),
      'hidden',
      { enumerable: false, value: 3 },
    );

    const entries = ownEntries(record);

    assert.deepEqual(entries, [
      [PROTO, 1],
      ['constructor', 2],
      ['hidden', 3],
    ]);
  });

  test('returns undefined for a record carrying a symbol key, which only a constructed value can carry', () => {
    const record = { [Symbol('resource')]: 1, sub: null };

    const entries = ownEntries(record);

    assert.equal(entries, undefined);
  });

  test('returns undefined for a value other than a plain record', () => {
    const value = new Map([['sub', null]]);

    const entries = ownEntries(value);

    assert.equal(entries, undefined);
  });
});

suite('listEntries', () => {
  test('reads a hole in a sparse list as undefined, so every check sees it', () => {
    const list = ['view', , 'export'];

    const entries = listEntries(list);

    assert.deepEqual(entries, ['view', undefined, 'export']);
    assert.equal(Object.hasOwn(entries ?? [], 1), true);
  });

  test('returns undefined for a value other than a list', () => {
    const value = 'view';

    const entries = listEntries(value);

    assert.equal(entries, undefined);
  });
});

suite('hasOnlyMembers', () => {
  test('holds for a record carrying only the members named', () => {
    const record = { op: 'in' };

    const holds = hasOnlyMembers(record, new Set(['content', 'op']));

    assert.equal(holds, true);
  });

  test('fails for a record carrying a symbol key', () => {
    const record = { [Symbol('op')]: 'in', op: 'in' };

    const holds = hasOnlyMembers(record, new Set(['content', 'op']));

    assert.equal(holds, false);
  });
});

suite('isUsableKey and isNonEmptyString', () => {
  for (const [key, usable] of [
    ['', false],
    [PROTO, false],
    ['constructor', true],
    ['HEART_STUDY', true],
  ] as const) {
    test(`judges ${JSON.stringify(key)} ${usable ? 'usable' : 'unusable'} as a key`, () => {
      const given = key;

      const judged = isUsableKey(given);

      assert.equal(judged, usable);
    });
  }

  test('judges only a string holding a character to be a non-empty string', () => {
    const values = ['', 'a', 1, null];

    const judged = values.map(isNonEmptyString);

    assert.deepEqual(judged, [false, true, false, false]);
  });
});

suite('plainSnapshot', () => {
  test('copies own data, sharing nothing with the original', () => {
    const original = { permissions: { HEART_STUDY: ['view'] } };

    const snapshot = plainSnapshot(original);
    original.permissions.HEART_STUDY.push('export');

    assert.deepEqual(snapshot, { permissions: { HEART_STUDY: ['view'] } });
  });

  test('copies no inherited member', () => {
    const inherited = Object.assign(Object.create(null), { EXTRA: true });
    const original = Object.assign(Object.create(inherited), { OWN: true });

    const snapshot = plainSnapshot(original);

    assert.deepEqual(snapshot, { OWN: true });
    assert.equal(Object.getPrototypeOf(snapshot), Object.prototype);
  });

  test('reads each member once, through its getter', () => {
    const reads = { count: 0 };
    const original = Object.defineProperty({}, 'sub', {
      enumerable: true,
      get: (): number => {
        reads.count += 1;

        return reads.count;
      },
    });

    const snapshot = plainSnapshot(original);

    assert.deepEqual(snapshot, { sub: 1 });
    assert.equal(reads.count, 1);
  });

  test('keeps a __proto__ key as an own member of an ordinary object', () => {
    const original = JSON.parse('{"__proto__":{"record":["view"]}}');

    const snapshot = plainSnapshot(original);

    assert.equal(Object.hasOwn(Object(snapshot), PROTO), true);
    assert.equal(Object.getPrototypeOf(snapshot), Object.prototype);
  });

  test('reads a hole in a list as undefined', () => {
    const original = ['view', , 'export'];

    const snapshot = plainSnapshot(original);

    assert.deepEqual(snapshot, ['view', undefined, 'export']);
  });

  test('keeps a value that is not plain data as it is, for a validator to refuse', () => {
    const map = new Map([['sub', null]]);

    const snapshot = plainSnapshot({ permissions: map });

    assert.equal(Reflect.get(Object(snapshot), 'permissions'), map);
  });

  test('copies twice as deep as SQON allows, then keeps the rest as it is, so a cycle ends the copy', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    const snapshot = plainSnapshot(cyclic);
    const levels = Array.from({ length: 2 * SQON_MAX_DEPTH }).reduce<
      readonly unknown[]
    >(
      (reached) => [...reached, Reflect.get(Object(reached.at(-1)), 'self')],
      [snapshot],
    );

    assert.deepEqual(
      levels.map((level) => level === cyclic),
      levels.map((_level, depth) => depth === 2 * SQON_MAX_DEPTH),
    );
  });

  test('throws whatever reading the value throws', () => {
    const original = Object.defineProperty({}, 'sub', {
      enumerable: true,
      get: (): never => {
        throw new RangeError('unreadable');
      },
    });

    assert.throws(() => plainSnapshot(original), RangeError);
  });
});

suite('deepFreeze and isFrozenData', () => {
  test('freezes a value at every depth and returns it', () => {
    const value = {
      principal: { subject: null },
      results: [{ kind: 'allow' }],
    };

    const frozen = deepFreeze(value);

    assert.equal(frozen, value);
    assert.equal(isDeeplyFrozen(value), true);
    assert.equal(isFrozenData(value), true);
  });

  test('counts a value as frozen data only when every depth is frozen', () => {
    const value = Object.freeze({ principal: { subject: null } });

    const frozenData = isFrozenData(value);

    assert.equal(frozenData, false);
  });

  test('finds a frozen value holding an accessor not to be frozen data, without running it', () => {
    const reads = { count: 0 };
    const value = Object.freeze(
      Object.defineProperty({}, 'subject', {
        enumerable: true,
        get: (): null => {
          reads.count += 1;

          return null;
        },
      }),
    );

    const frozenData = isFrozenData(value);

    assert.equal(frozenData, false);
    assert.equal(reads.count, 0);
  });

  test('finds a value other than an object to be frozen data', () => {
    const values = [null, 'subject', 1, true, undefined];

    const frozenData = values.map(isFrozenData);

    assert.deepEqual(frozenData, [true, true, true, true, true]);
  });
});
