import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { isMissingField, matchesSqon } from './sqonEvaluator.js';

const clause = (
  op: string,
  fieldName: string,
  value: unknown,
): Record<string, unknown> => ({ content: { fieldName, value }, op });

const inClause = (fieldName: string, value: unknown): Record<string, unknown> =>
  clause('in', fieldName, value);

const group = (
  op: string,
  ...content: readonly unknown[]
): Record<string, unknown> => ({ content, op });

suite('matchesSqon', () => {
  suite('an in', () => {
    test('matches a record whose field holds a listed value', () => {
      const record = { data_category: 'controlled' };

      const matched = matchesSqon(
        inClause('data_category', ['open', 'controlled']),
        record,
      );

      assert.equal(matched, true);
    });

    test('matches a record when any of its values at the field is listed', () => {
      const record = { study_id: ['REEF_ARCHIVE', 'HEART_STUDY'] };

      const matched = matchesSqon(
        inClause('study_id', ['HEART_STUDY']),
        record,
      );

      assert.equal(matched, true);
    });

    test('matches an in only when the field holds a listed value', () => {
      const record = { study_id: ['REEF_ARCHIVE', 'LUNG_COHORT'] };

      const matched = matchesSqon(
        inClause('study_id', ['HEART_STUDY']),
        record,
      );

      assert.equal(matched, false);
    });

    test('tells a number from the string of that number', () => {
      const record = { consent_version: '2' };

      const matched = matchesSqon(inClause('consent_version', [2]), record);

      assert.equal(matched, false);
    });

    test('reads a single value written without a list as that value', () => {
      const record = { data_category: 'controlled' };

      const matched = matchesSqon(
        inClause('data_category', 'controlled'),
        record,
      );

      assert.equal(matched, true);
    });

    for (const spelling of ['=', '==', '===']) {
      test(`reads ${spelling} as an in`, () => {
        const record = { data_category: 'controlled' };

        const matched = matchesSqon(
          clause(spelling, 'data_category', ['controlled']),
          record,
        );

        assert.equal(matched, true);
      });
    }
  });

  suite('the missing-field marker', () => {
    for (const [description, record] of [
      ['absent', {}],
      ['null', { data_category: null }],
      ['an empty list', { data_category: [] }],
    ] as const) {
      test(`matches a field that is ${description}`, () => {
        const matched = matchesSqon(
          inClause('data_category', ['__missing__']),
          record,
        );

        assert.equal(matched, true);
      });
    }

    test('matches no field holding a value', () => {
      const record = { data_category: ['controlled'] };

      const matched = matchesSqon(
        inClause('data_category', ['__missing__']),
        record,
      );

      assert.equal(matched, false);
    });

    test('matches a missing field when listed beside ordinary values', () => {
      const record = {};

      const matched = matchesSqon(
        inClause('data_category', ['controlled', '__missing__']),
        record,
      );

      assert.equal(matched, true);
    });

    for (const [description, record] of [
      ['absent', {}],
      ['null', { data_category: null }],
      ['an empty list', { data_category: [] }],
    ] as const) {
      test(`matches no ordinary in value when the field is ${description}`, () => {
        const matched = matchesSqon(
          inClause('data_category', ['controlled']),
          record,
        );

        assert.equal(matched, false);
      });
    }
  });

  suite('a range', () => {
    for (const [op, bound, matching, failing] of [
      ['gt', 17, 18, 17],
      ['gte', 18, 18, 17],
      ['lt', 65, 64, 65],
      ['lte', 65, 65, 66],
      ['>', 17, 18, 17],
      ['>=', 18, 18, 17],
      ['<', 65, 64, 65],
      ['<=', 65, 65, 66],
    ] as const) {
      test(`reads ${op} ${bound} as matching ${matching} and not ${failing}`, () => {
        const condition = clause(op, 'donor_age', bound);

        const verdicts = [
          matchesSqon(condition, { donor_age: matching }),
          matchesSqon(condition, { donor_age: failing }),
        ];

        assert.deepEqual(verdicts, [true, false]);
      });
    }

    test('compares numbers numerically, so 9 is below 10', () => {
      const condition = clause('lt', 'donor_age', 10);

      const matched = matchesSqon(condition, { donor_age: 9 });

      assert.equal(matched, true);
    });

    test('compares strings by code unit, so Zeta is below alpha', () => {
      const condition = clause('lt', 'label', 'alpha');

      const matched = matchesSqon(condition, { label: 'Zeta' });

      assert.equal(matched, true);
    });

    test('compares dates written as ISO strings in date order', () => {
      const condition = clause('gte', 'collection_date', '2020-01-01');

      const verdicts = [
        matchesSqon(condition, { collection_date: '2020-06-30' }),
        matchesSqon(condition, { collection_date: '2019-12-31' }),
      ];

      assert.deepEqual(verdicts, [true, false]);
    });

    test('matches when any value of a list is within the range', () => {
      const condition = clause('gte', 'donor_age', 18);

      const matched = matchesSqon(condition, { donor_age: [12, 40] });

      assert.equal(matched, true);
    });

    test('matches nothing when comparing a number with a string bound', () => {
      const condition = clause('gte', 'donor_age', '18');

      const matched = matchesSqon(condition, { donor_age: 40 });

      assert.equal(matched, false);
    });

    for (const [description, record] of [
      ['absent', {}],
      ['null', { donor_age: null }],
      ['an empty list', { donor_age: [] }],
    ] as const) {
      test(`matches no range when the field is ${description}`, () => {
        const verdicts = ['gt', 'gte', 'lt', 'lte'].map((op) =>
          matchesSqon(clause(op, 'donor_age', 0), record),
        );

        assert.deepEqual(verdicts, [false, false, false, false]);
      });
    }

    test('reads a between as including both of its bounds', () => {
      const condition = clause('between', 'donor_age', [18, 65]);

      const verdicts = [17, 18, 40, 65, 66].map((age) =>
        matchesSqon(condition, { donor_age: age }),
      );

      assert.deepEqual(verdicts, [false, true, true, true, false]);
    });

    test('reads a between of dates in date order', () => {
      const condition = clause('between', 'collection_date', [
        '2020-01-01',
        '2020-12-31',
      ]);

      const verdicts = ['2019-12-31', '2020-01-01', '2021-01-01'].map((date) =>
        matchesSqon(condition, { collection_date: date }),
      );

      assert.deepEqual(verdicts, [false, true, false]);
    });
  });

  suite('a combination', () => {
    const controlled = inClause('data_category', ['controlled']);
    const adult = clause('gte', 'donor_age', 18);

    test('matches an and only when every entry matches', () => {
      const condition = group('and', controlled, adult);

      const verdicts = [
        matchesSqon(condition, { data_category: 'controlled', donor_age: 30 }),
        matchesSqon(condition, { data_category: 'controlled', donor_age: 12 }),
      ];

      assert.deepEqual(verdicts, [true, false]);
    });

    test('matches an or when any entry matches', () => {
      const condition = group('or', controlled, adult);

      const verdicts = [
        matchesSqon(condition, { data_category: 'open', donor_age: 30 }),
        matchesSqon(condition, { data_category: 'open', donor_age: 12 }),
      ];

      assert.deepEqual(verdicts, [true, false]);
    });

    test('reads a not as the negation of its one entry', () => {
      const condition = group('not', controlled);

      const verdicts = [
        matchesSqon(condition, { data_category: 'open' }),
        matchesSqon(condition, { data_category: 'controlled' }),
      ];

      assert.deepEqual(verdicts, [true, false]);
    });

    test('throws for a not holding two entries, a form outside what it reads', () => {
      const condition = group('not', controlled, adult);

      assert.throws(() => matchesSqon(condition, {}));
    });

    for (const op of ['and', 'or']) {
      test(`throws for an ${op} holding no entry, since an empty group means every record`, () => {
        const condition = group(op);

        assert.throws(() => matchesSqon(condition, { data_category: 'open' }));
      });

      test(`throws for an ${op} holding no entry nested inside another group`, () => {
        const condition = group('or', group(op), controlled);

        assert.throws(() =>
          matchesSqon(condition, { data_category: 'controlled' }),
        );
      });
    }
  });

  suite('the other operators', () => {
    for (const spelling of ['not-in', '!=', '!==']) {
      test(`reads ${spelling} as the negation of an in`, () => {
        const condition = clause(spelling, 'data_category', ['controlled']);

        const verdicts = [
          matchesSqon(condition, { data_category: 'open' }),
          matchesSqon(condition, { data_category: 'controlled' }),
        ];

        assert.deepEqual(verdicts, [true, false]);
      });
    }

    test('matches an all only when every listed value is held', () => {
      const condition = clause('all', 'tags', ['pilot', 'adult']);

      const verdicts = [
        matchesSqon(condition, { tags: ['adult', 'pilot', 'other'] }),
        matchesSqon(condition, { tags: ['pilot'] }),
      ];

      assert.deepEqual(verdicts, [true, false]);
    });

    for (const spelling of ['wildcard', 'filter', 'some-not-in']) {
      test(`throws for ${spelling}, a form outside what it evaluates`, () => {
        const condition =
          spelling === 'some-not-in'
            ? clause(spelling, 'tags', ['pilot'])
            : {
                content: { fieldNames: ['tags'], value: 'pil*' },
                op: spelling,
              };

        assert.throws(() => matchesSqon(condition, { tags: ['pilot'] }));
      });
    }

    test('throws for an operator SQON does not define', () => {
      const condition = clause('matches', 'tags', ['pilot']);

      assert.throws(() => matchesSqon(condition, { tags: ['pilot'] }));
    });

    for (const [description, condition] of [
      ['a range whose bound is a list', clause('gt', 'donor_age', [18])],
      ['a between holding one bound', clause('between', 'donor_age', [18])],
      [
        'a between holding three bounds',
        clause('between', 'donor_age', [1, 2, 3]),
      ],
      ['a between of one value', clause('between', 'donor_age', 18)],
      ['an in listing a * pattern', inClause('tags', ['pil*'])],
      ['an in listing a set_id: reference', inClause('tags', ['set_id:a1b2'])],
      [
        'an all listing the missing-field marker',
        clause('all', 'tags', ['__missing__']),
      ],
    ] as const) {
      test(`throws for ${description}, a form outside what it evaluates`, () => {
        assert.throws(() =>
          matchesSqon(condition, { donor_age: 30, tags: ['pilot'] }),
        );
      });
    }
  });
});

suite('isMissingField', () => {
  for (const [description, record, missing] of [
    ['absent', {}, true],
    ['null', { donor_age: null }, true],
    ['an empty list', { donor_age: [] }, true],
    ['zero', { donor_age: 0 }, false],
    ['the empty string', { donor_age: '' }, false],
    ['a list holding a value', { donor_age: [40] }, false],
  ] as const) {
    test(`reads a field that is ${description} as ${missing ? 'missing' : 'present'}`, () => {
      const result = isMissingField(record, 'donor_age');

      assert.equal(result, missing);
    });
  }

  test('reads no member a record inherits', () => {
    const record = Object.create({ donor_age: 40 });

    const result = isMissingField(record, 'donor_age');

    assert.equal(result, true);
  });
});
