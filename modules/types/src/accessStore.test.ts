import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { ACCESS_STORE_RULES, attachAccess, readAccess } from './accessStore.js';
import { deepFreeze } from './plainData.js';
import type { UsherRequestAccess } from './requestAccess.js';
import {
  assertCarriesNoInput,
  assertEveryRuleBroken,
  assertInputMarked,
  bypassTypes,
  contractErrorFrom,
  isDeeplyFrozen,
  LEAK_MARKER,
} from './testSupport.js';

const validAccess = (): UsherRequestAccess => ({
  principal: {
    credential: 'confirmed',
    openTierOnly: false,
    subject: '8f14e45f-ceea-467a-9c1a-1b0e4d9c6f2b',
    suspended: false,
  },
  results: {
    analyses: { kind: 'deny', reason: 'no-grants' },
    files: {
      kind: 'narrow',
      sqon: {
        content: [
          {
            content: [
              {
                content: { fieldName: 'study_id', value: ['HEART_STUDY'] },
                op: 'in',
              },
              {
                content: { fieldName: 'data_category', value: ['controlled'] },
                op: 'in',
              },
            ],
            op: 'and',
          },
        ],
        op: 'or',
      },
    },
    reference: { kind: 'allow' },
  },
  version: 1,
});

/** Values refused by `validateRequestAccess`, each for a different rule. */
const invalidAccessValues: readonly (readonly [string, unknown])[] = [
  [
    'a suspended principal not marked open-tier only',
    {
      ...validAccess(),
      principal: {
        attributionOnlySubject: '8f14e45f-ceea-467a-9c1a-1b0e4d9c6f2b',
        credential: 'confirmed',
        openTierOnly: false,
        suspended: true,
      },
    },
  ],
  ['an unknown version', { ...validAccess(), version: 2 }],
  ['an empty results map', { ...validAccess(), results: {} }],
  [
    'a result holding an exclusion',
    {
      ...validAccess(),
      results: {
        files: {
          kind: 'narrow',
          sqon: {
            content: { fieldName: 'data_category', value: ['controlled'] },
            op: 'not-in',
          },
        },
      },
    },
  ],
  ['a value that is not an object', 'usher'],
];

/** `access` and its objects down to each narrowing's `sqon`, so freezing can be checked at each. */
const nestedObjectsOf = (access: UsherRequestAccess): readonly unknown[] => [
  access,
  access.principal,
  access.results,
  ...Object.values(access.results),
  ...Object.values(access.results).flatMap((result) =>
    result.kind === 'narrow' ? [result.sqon] : [],
  ),
];

/**
 * A store holding `value` under `usher` as `attachAccess` holds a value, without validating it, so
 * a test can show how `readAccess` treats each value found there.
 */
const storeHolding = (value: unknown): object =>
  Object.defineProperty({}, 'usher', {
    configurable: false,
    enumerable: false,
    value: deepFreeze(structuredClone(value)),
    writable: false,
  });

suite('attachAccess', () => {
  test('attaches a value that reads back equal to the value attached', () => {
    const store = {};

    attachAccess(store, validAccess());

    assert.deepEqual(readAccess(store), validAccess());
  });

  test("attaches a deeply frozen copy rather than the caller's object", () => {
    const store: Record<string, unknown> = {};
    const access = validAccess();

    attachAccess(store, access);

    assert.notEqual(store['usher'], access);
    assert.equal(isDeeplyFrozen(store['usher']), true);
  });

  test("leaves the caller's object unfrozen, at every depth", () => {
    const access = validAccess();

    attachAccess({}, access);

    assert.deepEqual(
      nestedObjectsOf(access).map((nested) => Object.isFrozen(nested)),
      nestedObjectsOf(access).map(() => false),
    );
  });

  test('keeps the attached value as it was when the caller changes its own object afterwards', () => {
    const store: Record<string, unknown> = {};
    const access = validAccess();

    attachAccess(store, access);
    access.principal.openTierOnly = true;
    access.results['analyses'] = { kind: 'allow' };

    assert.deepEqual(store['usher'], validAccess());
  });

  test('defines the member under the key usher as neither writable, configurable nor enumerable', () => {
    const store = {};

    attachAccess(store, validAccess());
    const descriptor = Object.getOwnPropertyDescriptor(store, 'usher');

    assert.equal(descriptor?.writable, false);
    assert.equal(descriptor?.configurable, false);
    assert.equal(descriptor?.enumerable, false);
    assert.equal(descriptor?.get, undefined);
    assert.equal(descriptor?.set, undefined);
  });

  test('keeps the attached member out of a spread or a serialization of the store', () => {
    const store = { locale: 'en-CA' };

    attachAccess(store, validAccess());

    assert.equal('usher' in { ...store }, false);
    assert.equal(JSON.stringify(store), '{"locale":"en-CA"}');
  });

  test('refuses a later assignment to the member, keeping the attached value', () => {
    const store: Record<string, unknown> = {};

    attachAccess(store, validAccess());
    const attached = store['usher'];

    assert.throws(() => {
      store['usher'] = {
        ...validAccess(),
        principal: {
          credential: 'confirmed',
          openTierOnly: false,
          subject: 'another-subject',
          suspended: false,
        },
      };
    }, TypeError);
    assert.equal(store['usher'], attached);
  });

  test('refuses a later redefinition or deletion of the member, keeping the attached value', () => {
    const store: Record<string, unknown> = {};

    attachAccess(store, validAccess());
    const attached = store['usher'];

    assert.throws(() => {
      Object.defineProperty(store, 'usher', { value: validAccess() });
    }, TypeError);
    assert.throws(() => {
      delete store['usher'];
    }, TypeError);
    assert.equal(store['usher'], attached);
  });

  test('throws on a second attach to the same store, keeping the first value', () => {
    const store: Record<string, unknown> = {};

    attachAccess(store, validAccess());
    const attached = store['usher'];

    contractErrorFrom(
      () =>
        attachAccess(store, {
          ...validAccess(),
          results: { reference: { kind: 'allow' } },
        }),
      ACCESS_STORE_RULES.alreadyHeld,
    );
    assert.equal(store['usher'], attached);
  });

  for (const [description, existing] of [
    ['a value', { version: 1 }],
    ['undefined', undefined],
  ] as const) {
    test(`throws when the store already holds an usher member set to ${description}, leaving it as it was`, () => {
      const store: Record<string, unknown> = { usher: existing };

      contractErrorFrom(
        () => attachAccess(store, validAccess()),
        ACCESS_STORE_RULES.alreadyHeld,
      );

      assert.deepEqual(Object.getOwnPropertyDescriptor(store, 'usher'), {
        configurable: true,
        enumerable: true,
        value: existing,
        writable: true,
      });
    });
  }

  for (const [description, value] of invalidAccessValues) {
    test(`throws for ${description} and attaches nothing`, () => {
      const store = {};

      const error = contractErrorFrom(
        () => attachAccess(store, bypassTypes<UsherRequestAccess>(value)),
        ACCESS_STORE_RULES.attachedInvalid,
      );

      assert.ok(error.problems.length > 0);
      assert.equal(Object.hasOwn(store, 'usher'), false);
    });
  }

  for (const [description, prepare] of [
    ['frozen', (store: object): object => Object.freeze(store)],
    [
      'closed to new members',
      (store: object): object => Object.preventExtensions(store),
    ],
  ] as const) {
    test(`throws for a store that is ${description}, attaching nothing`, () => {
      const store = prepare({});

      contractErrorFrom(
        () => attachAccess(store, validAccess()),
        ACCESS_STORE_RULES.noNewMember,
      );

      assert.equal(Object.hasOwn(store, 'usher'), false);
    });
  }

  for (const [description, store] of [
    ['null', null],
    ['a string', 'res.locals'],
  ] as const) {
    test(`throws for a store that is ${description}`, () => {
      const given = bypassTypes<object>(store);

      contractErrorFrom(
        () => attachAccess(given, validAccess()),
        ACCESS_STORE_RULES.storeIsObject,
      );
    });
  }

  test('throws for a store that throws when used', () => {
    const store = new Proxy(
      {},
      {
        defineProperty: (): never => {
          throw new Error('unusable');
        },
      },
    );

    contractErrorFrom(
      () => attachAccess(store, validAccess()),
      ACCESS_STORE_RULES.storeUsable,
    );
  });
});

suite('readAccess', () => {
  test('returns the value attached, deeply frozen', () => {
    const store = {};

    attachAccess(store, validAccess());
    const access = readAccess(store);

    assert.deepEqual(access, validAccess());
    assert.equal(isDeeplyFrozen(access), true);
  });

  test('throws when the store holds no access', () => {
    const store = {};

    contractErrorFrom(() => readAccess(store), ACCESS_STORE_RULES.notHeld);
  });

  test('throws when the store only inherits an usher member', () => {
    const store = Object.create(storeHolding(validAccess()));

    contractErrorFrom(() => readAccess(store), ACCESS_STORE_RULES.notHeld);
  });

  for (const [description, store] of [
    ['set to undefined', { usher: undefined }],
    ['as a plain, writable member', { usher: validAccess() }],
    [
      'as a hidden, fixed member holding a value that is not frozen',
      Object.defineProperty({}, 'usher', { value: validAccess() }),
    ],
    [
      'as a fixed member that is enumerable',
      Object.defineProperty({}, 'usher', {
        enumerable: true,
        value: deepFreeze(validAccess()),
      }),
    ],
  ] as const) {
    test(`throws when the store holds access ${description}, which attachAccess never leaves`, () => {
      const given = store;

      contractErrorFrom(
        () => readAccess(given),
        ACCESS_STORE_RULES.heldOtherwise,
      );
    });
  }

  test('throws for an usher accessor without running it', () => {
    const reads = { count: 0 };
    const store = Object.defineProperty({}, 'usher', {
      get: (): UsherRequestAccess => {
        reads.count += 1;

        return validAccess();
      },
    });

    contractErrorFrom(
      () => readAccess(store),
      ACCESS_STORE_RULES.heldOtherwise,
    );

    assert.equal(reads.count, 0);
  });

  test('throws for frozen access holding an accessor, without running it', () => {
    const reads = { count: 0 };
    const access = Object.defineProperty(validAccess(), 'version', {
      enumerable: true,
      get: (): 1 => {
        reads.count += 1;

        return 1;
      },
    });
    const store = Object.defineProperty({}, 'usher', {
      value: Object.freeze(access),
    });

    contractErrorFrom(
      () => readAccess(store),
      ACCESS_STORE_RULES.heldOtherwise,
    );

    assert.equal(reads.count, 0);
  });

  for (const [description, value] of invalidAccessValues) {
    test(`throws when the store holds ${description}, since every read validates the value held in the store`, () => {
      const store = storeHolding(value);

      const error = contractErrorFrom(
        () => readAccess(store),
        ACCESS_STORE_RULES.heldInvalid,
      );

      assert.ok(error.problems.length > 0);
    });
  }

  for (const [description, store] of [
    ['null', null],
    ['a number', 42],
  ] as const) {
    test(`throws for a store that is ${description}`, () => {
      const given = bypassTypes<object>(store);

      contractErrorFrom(
        () => readAccess(given),
        ACCESS_STORE_RULES.storeIsObject,
      );
    });
  }

  test('throws for a store that throws when read', () => {
    const store = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: (): never => {
          throw new Error('unreadable');
        },
      },
    );

    contractErrorFrom(() => readAccess(store), ACCESS_STORE_RULES.storeUsable);
  });
});

suite('what attachAccess and readAccess throw carries', () => {
  /** The words fixed by the contract, carried unmarked by a leak input. */
  const CONTRACT_WORDS: ReadonlySet<string> = new Set([
    'attributionOnlySubject',
    'confirmed',
    'content',
    'credential',
    'deny',
    'fieldName',
    'kind',
    'narrow',
    'no-grants',
    'not-in',
    'op',
    'openTierOnly',
    'principal',
    'reason',
    'results',
    'sqon',
    'subject',
    'suspended',
    'usher',
    'value',
    'version',
  ]);

  /** A value refused by the validator, every identifier and value of it marked. */
  const markedInvalidAccess = (): Record<string, unknown> => ({
    principal: {
      attributionOnlySubject: `${LEAK_MARKER}_subject`,
      credential: 'confirmed',
      openTierOnly: false,
      suspended: true,
    },
    results: {
      [`${LEAK_MARKER}_key`]: {
        kind: 'narrow',
        sqon: {
          content: {
            fieldName: `${LEAK_MARKER}_field`,
            value: [`${LEAK_MARKER}_value`],
          },
          op: 'not-in',
        },
      },
    },
    version: 1,
  });

  const markedValidAccess = (): Record<string, unknown> => ({
    principal: {
      credential: 'confirmed',
      openTierOnly: false,
      subject: `${LEAK_MARKER}_subject`,
      suspended: false,
    },
    results: {
      [`${LEAK_MARKER}_key`]: { kind: 'deny', reason: 'no-grants' },
    },
    version: 1,
  });

  const throwingProxy = (
    trap: 'defineProperty' | 'getOwnPropertyDescriptor',
  ): object =>
    new Proxy(
      {},
      {
        [trap]: (): never => {
          throw new Error(`${LEAK_MARKER}_thrown`);
        },
      },
    );

  const leakCases: readonly {
    description: string;
    input: unknown;
    rule: string;
    run: (input: unknown) => unknown;
  }[] = [
    {
      description: 'attaching invalid access',
      input: markedInvalidAccess(),
      rule: ACCESS_STORE_RULES.attachedInvalid,
      run: (input) => attachAccess({}, bypassTypes<UsherRequestAccess>(input)),
    },
    {
      description: 'attaching to a store already holding access',
      input: markedValidAccess(),
      rule: ACCESS_STORE_RULES.alreadyHeld,
      run: (input) =>
        attachAccess(
          { usher: input },
          bypassTypes<UsherRequestAccess>(markedValidAccess()),
        ),
    },
    {
      description: 'attaching to a frozen store',
      input: markedValidAccess(),
      rule: ACCESS_STORE_RULES.noNewMember,
      run: (input) =>
        attachAccess(
          Object.freeze({ [`${LEAK_MARKER}_member`]: `${LEAK_MARKER}_value` }),
          bypassTypes<UsherRequestAccess>(input),
        ),
    },
    {
      description: 'attaching to a store that is a string',
      input: `${LEAK_MARKER}_store`,
      rule: ACCESS_STORE_RULES.storeIsObject,
      run: (input) =>
        attachAccess(
          bypassTypes<object>(input),
          bypassTypes<UsherRequestAccess>(markedValidAccess()),
        ),
    },
    {
      description: 'attaching to a store whose trap throws',
      input: markedValidAccess(),
      rule: ACCESS_STORE_RULES.storeUsable,
      run: (input) =>
        attachAccess(
          throwingProxy('defineProperty'),
          bypassTypes<UsherRequestAccess>(input),
        ),
    },
    {
      description: 'reading invalid access',
      input: markedInvalidAccess(),
      rule: ACCESS_STORE_RULES.heldInvalid,
      run: (input) => readAccess(storeHolding(input)),
    },
    {
      description: 'reading access held as a plain member',
      input: markedValidAccess(),
      rule: ACCESS_STORE_RULES.heldOtherwise,
      run: (input) => readAccess({ usher: input }),
    },
    {
      description: 'reading a store holding no access',
      input: { [`${LEAK_MARKER}_member`]: `${LEAK_MARKER}_value` },
      rule: ACCESS_STORE_RULES.notHeld,
      run: (input) => readAccess(Object(input)),
    },
    {
      description: 'reading a store whose trap throws',
      input: undefined,
      rule: ACCESS_STORE_RULES.storeUsable,
      run: () => readAccess(throwingProxy('getOwnPropertyDescriptor')),
    },
  ];

  for (const { description, input, rule, run } of leakCases) {
    test(`names no content of the value or the store when ${description}`, () => {
      assertInputMarked(input, CONTRACT_WORDS);

      const error = contractErrorFrom(() => run(input), rule);

      assertCarriesNoInput(error);
    });
  }

  test('breaks every rule they hold, between the cases above', () => {
    const cases = leakCases;

    assertEveryRuleBroken(cases, ACCESS_STORE_RULES);
  });
});
