import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
  brokenRules,
  checkSnapshot,
  keySegment,
  memberPosition,
  nestedPosition,
  READ_RULE,
  UsherContractError,
  type ValidationProblem,
} from './problems.js';
import { assertCarriesNoInput, LEAK_MARKER } from './testSupport.js';

suite('UsherContractError', () => {
  test('carries the rule as its message, under its own name', () => {
    const rule = 'a rule was broken';

    const error = new UsherContractError(rule);

    assert.equal(error instanceof Error, true);
    assert.equal(error.message, rule);
    assert.equal(error.name, 'UsherContractError');
    assert.deepEqual(error.problems, []);
  });

  test('holds a frozen copy of its problems, which a later change to the list does not reach', () => {
    const problems: ValidationProblem[] = [
      { position: 'sub', rule: 'sub is present' },
    ];

    const error = new UsherContractError('a payload is valid', problems);
    problems.push({ position: 'iss', rule: 'iss is present' });

    assert.deepEqual(error.problems, [
      { position: 'sub', rule: 'sub is present' },
    ]);
    assert.equal(Object.isFrozen(error.problems), true);
    assert.equal(
      error.problems.every((problem) => Object.isFrozen(problem)),
      true,
    );
  });

  test('never holds a cause', () => {
    const error = new UsherContractError('a rule was broken');

    const holdsCause = Object.hasOwn(error, 'cause');

    assert.equal(holdsCause, false);
  });
});

suite('brokenRules', () => {
  test('names one problem at the position for each rule that does not hold', () => {
    const rules = [
      [true, 'held'],
      [false, 'first broken'],
      [false, 'second broken'],
    ] as const;

    const problems = brokenRules('sub', rules);

    assert.deepEqual(problems, [
      { position: 'sub', rule: 'first broken' },
      { position: 'sub', rule: 'second broken' },
    ]);
  });
});

suite('checkSnapshot', () => {
  test('returns the problems found in the snapshot, and the snapshot', () => {
    const value = { sub: null };

    const checked = checkSnapshot(value, () => [
      { position: 'sub', rule: 'sub is present' },
    ]);

    assert.deepEqual(checked, {
      problems: [{ position: 'sub', rule: 'sub is present' }],
      snapshot: { sub: null },
    });
    assert.notEqual(checked.snapshot, value);
  });

  test('refuses the whole value when reading it throws, passing on nothing thrown', () => {
    const value = Object.defineProperty({}, 'sub', {
      enumerable: true,
      get: (): never => {
        throw new Error(`${LEAK_MARKER}_thrown`);
      },
    });

    const checked = checkSnapshot(value, () => []);

    assert.deepEqual(checked, {
      problems: [{ position: '(root)', rule: READ_RULE }],
      snapshot: undefined,
    });
    assertCarriesNoInput(checked);
  });

  test('refuses the whole value when its check throws, passing on nothing thrown', () => {
    const value = { sub: `${LEAK_MARKER}_subject` };

    const checked = checkSnapshot(value, () => {
      throw new Error(`${LEAK_MARKER}_thrown`);
    });

    assert.deepEqual(checked.problems, [
      { position: '(root)', rule: READ_RULE },
    ]);
    assertCarriesNoInput(checked);
  });
});

suite('nestedPosition', () => {
  test('joins a nested position onto the position of the value holding it', () => {
    const positions = [
      nestedPosition('results.<key>', 'sqon'),
      nestedPosition('results.<key>', '(root)'),
    ];

    assert.deepEqual(positions, ['results.<key>.sqon', 'results.<key>']);
  });
});

suite('keySegment', () => {
  for (const [key, form, segment, position] of [
    ['study-1', 'bare', 'study-1', 'categories.resource.study-1'],
    ['a_b', 'bare', 'a_b', 'categories.resource.a_b'],
    ['HEART_STUDY', 'bare', 'HEART_STUDY', 'categories.resource.HEART_STUDY'],
    [
      'files.v2',
      'in brackets',
      '["files.v2"]',
      'categories.resource["files.v2"]',
    ],
    [
      'heart study',
      'in brackets',
      '["heart study"]',
      'categories.resource["heart study"]',
    ],
    ['', 'in brackets', '[""]', 'categories.resource[""]'],
    ['données', 'in brackets', '["données"]', 'categories.resource["données"]'],
    ['HEART*', 'in brackets', '["HEART*"]', 'categories.resource["HEART*"]'],
  ] as const) {
    test(`writes ${JSON.stringify(key)} ${form}, alone and after the position of its map`, () => {
      const written = [
        keySegment(key),
        memberPosition('categories.resource', key),
      ];

      assert.deepEqual(written, [segment, position]);
    });
  }
});
