import assert from 'node:assert/strict';
import { suite, test } from 'node:test';
import { inspect } from 'node:util';

import {
  type CategoryCondition,
  CONDITION_RULES,
  conditionWalkProblems,
  fieldNamesReadBy,
  normalizedCondition,
  RENDERED_WRAPPING_NODES,
  validateCategoryCondition,
} from './categoryCondition.js';
import { READ_RULE } from './problems.js';
import {
  assertAccepted,
  assertCarriesNoInput,
  assertEveryRuleBroken,
  assertInputMarked,
  assertRefusedFor,
  type CheckedResult,
  LEAK_MARKER,
  LEAK_NUMBER,
  type LeakCase,
} from './testSupport.js';

const CONDITION_POSITION = 'condition';

/** A clause testing one field, under any operator. */
const clause = (
  op: string,
  fieldName: unknown,
  value: unknown,
): Record<string, unknown> => ({ content: { fieldName, value }, op });

const inClause = (
  fieldName: unknown,
  value: unknown,
): Record<string, unknown> => clause('in', fieldName, value);

/** A valid `and` holding `node` as its second entry, so a refusal of `node` comes from below the root. */
const nestedSecond = (node: unknown): Record<string, unknown> => ({
  content: [inClause('data_category', ['controlled']), node],
  op: 'and',
});

const nestedDeeperThan = (levels: number, leaf: unknown): unknown =>
  Array.from({ length: levels }).reduce<unknown>(
    (inner) => ({ content: [inner], op: 'and' }),
    leaf,
  );

/** What the walk alone finds, as a validator's result. */
const walkResult = (condition: unknown): CheckedResult => {
  const problems = conditionWalkProblems(condition, CONDITION_POSITION);

  return problems.length > 0 ? { problems, success: false } : { success: true };
};

/** The condition returned by validating `value`, failing the test when the value is refused. */
const validated = (value: unknown): CategoryCondition => {
  const result = validateCategoryCondition(value);

  if (result.success) {
    return result.condition;
  }

  return assert.fail(`expected acceptance; found ${inspect(result.problems)}`);
};

suite('validateCategoryCondition', () => {
  suite('the conditions an author writes', () => {
    const authoredConditions: readonly (readonly [string, unknown])[] = [
      [
        'a field equal to one value, the simplest category',
        inClause('data_category', ['controlled']),
      ],
      [
        'an in listing several values of one field',
        inClause('data_category', ['controlled', 'restricted']),
      ],
      ['an in listing numbers', inClause('consent_version', [2, 3])],
      [
        'an in listing a number and the string of that number, which are distinct values',
        inClause('consent_version', [2, '2']),
      ],
      [
        'an in listing values that only resemble a marker',
        inClause('data_category', ['set_id', '_missing_', 'missing__']),
      ],
      ['an in written as =', clause('=', 'data_category', ['controlled'])],
      ['an in written as ==', clause('==', 'data_category', ['controlled'])],
      ['an in written as ===', clause('===', 'data_category', ['controlled'])],
      ['a gt on a number', clause('gt', 'donor_age', 17)],
      ['a gte on a number', clause('gte', 'donor_age', 18)],
      ['an lt on a date', clause('lt', 'collection_date', '2020-03-01')],
      ['an lte on a date', clause('lte', 'collection_date', '2020-02-29')],
      ['a range written as >', clause('>', 'donor_age', 17)],
      ['a range written as >=', clause('>=', 'collection_date', '2021-01-01')],
      ['a range written as <', clause('<', 'donor_age', 65)],
      ['a range written as <=', clause('<=', 'collection_date', '2020-12-31')],
      [
        'a range on a negative, fractional number',
        clause('gt', 'ph_level', -0.5),
      ],
      ['a between of two numbers', clause('between', 'donor_age', [18, 65])],
      [
        'a between of two dates',
        clause('between', 'collection_date', ['2020-01-01', '2020-12-31']),
      ],
      [
        'a between of two timestamps',
        clause('between', 'collection_date', [
          '2020-01-01T00:00:00Z',
          '2020-06-30T23:59:59Z',
        ]),
      ],
      [
        'an and of an in and a range on another field',
        {
          content: [
            inClause('data_category', ['controlled']),
            clause('gte', 'donor_age', 18),
          ],
          op: 'and',
        },
      ],
      [
        'an and reading one field twice, as a bounded range',
        {
          content: [
            clause('gte', 'collection_date', '2020-01-01'),
            clause('lt', 'collection_date', '2021-01-01'),
          ],
          op: 'and',
        },
      ],
      [
        'an or of ranges on one date field',
        {
          content: [
            clause('lt', 'collection_date', '2020-03-01'),
            clause('gte', 'collection_date', '2022-01-01'),
          ],
          op: 'or',
        },
      ],
      [
        'an and holding one condition',
        { content: [inClause('data_category', ['controlled'])], op: 'and' },
      ],
      [
        'an or holding one condition',
        { content: [inClause('data_category', ['controlled'])], op: 'or' },
      ],
      [
        'a not around an in, which is how a value is excluded',
        { content: [inClause('data_category', ['open'])], op: 'not' },
      ],
      [
        'a not around an and',
        {
          content: [
            {
              content: [
                inClause('data_category', ['controlled']),
                clause('lt', 'donor_age', 18),
              ],
              op: 'and',
            },
          ],
          op: 'not',
        },
      ],
      [
        'a not around a not',
        {
          content: [
            { content: [inClause('data_category', ['open'])], op: 'not' },
          ],
          op: 'not',
        },
      ],
      [
        'an and beside a not inside an or, several levels deep',
        {
          content: [
            {
              content: [
                inClause('study_id', ['HEART_STUDY']),
                { content: [inClause('data_category', ['open'])], op: 'not' },
              ],
              op: 'and',
            },
            clause('between', 'donor_age', [0, 17]),
          ],
          op: 'or',
        },
      ],
    ];

    for (const [description, condition] of authoredConditions) {
      test(`accepts ${description} and returns it unchanged`, () => {
        const result = validateCategoryCondition(condition);

        assertAccepted(result);
        assert.deepEqual(result.success && result.condition, condition);
      });
    }
  });

  suite('a node', () => {
    for (const [description, value] of [
      ['undefined', undefined],
      ['null', null],
      ['a string', 'data_category'],
      ['a list', [inClause('data_category', ['controlled'])]],
    ] as const) {
      test(`refuses ${description} as a condition, returning the refusal rather than throwing`, () => {
        const result = validateCategoryCondition(value);

        assertRefusedFor(result, 'condition', CONDITION_RULES.validSqon);
      });
    }

    test('refuses a node that is a class instance rather than a map, though SQON accepts it', () => {
      class Clause {
        content = { fieldName: 'data_category', value: ['controlled'] };
        op = 'in';
      }

      const result = validateCategoryCondition(nestedSecond(new Clause()));

      assertRefusedFor(
        result,
        'condition.content[1]',
        CONDITION_RULES.nodeIsMap,
      );
    });

    for (const [description, entry] of [
      ['null', null],
      ['a string', 'data_category'],
      ['a list', [inClause('data_category', ['controlled'])]],
    ] as const) {
      test(`refuses an entry that is ${description}, by the walk alone`, () => {
        const result = walkResult(nestedSecond(entry));

        assertRefusedFor(
          result,
          'condition.content[1]',
          CONDITION_RULES.nodeIsMap,
        );
      });
    }

    for (const [description, node, position] of [
      [
        'a clause',
        nestedSecond({ ...inClause('data_category', ['a']), grants: ['all'] }),
        'condition.content[1]',
      ],
      [
        'a group',
        {
          ...nestedSecond(inClause('data_category', ['a'])),
          __unflat__: true,
        },
        'condition',
      ],
    ] as const) {
      test(`refuses ${description} carrying a member other than op and content`, () => {
        const result = validateCategoryCondition(node);

        assertRefusedFor(result, position, CONDITION_RULES.nodeMembers);
      });
    }

    for (const [description, pivot] of [
      ['a pivot path', 'donors'],
      ['a null pivot', null],
      ['a pivot member set to undefined', undefined],
    ] as const) {
      test(`refuses a clause carrying ${description}, since nested values come later`, () => {
        const condition = nestedSecond({
          ...inClause('data_category', ['controlled']),
          pivot,
        });

        const result = validateCategoryCondition(condition);

        assertRefusedFor(result, 'condition.content[1]', CONDITION_RULES.pivot);
      });
    }

    test('refuses a group carrying a pivot', () => {
      const condition = {
        ...nestedSecond(inClause('data_category', ['controlled'])),
        pivot: 'donors',
      };

      const result = validateCategoryCondition(condition);

      assertRefusedFor(result, 'condition', CONDITION_RULES.pivot);
    });
  });

  suite('the operators', () => {
    for (const operator of ['wildcard', 'filter']) {
      test(`refuses a pattern written ${operator}, since a condition matches values as listed`, () => {
        const condition = nestedSecond({
          content: { fieldNames: ['data_category'], value: 'contr*' },
          op: operator,
        });

        const result = validateCategoryCondition(condition);

        assertRefusedFor(
          result,
          'condition.content[1]',
          CONDITION_RULES.pattern,
        );
      });
    }

    for (const operator of ['not-in', 'some-not-in', '!=', '!==']) {
      test(`refuses an exclusion written ${operator}, which is written as a not around an in instead`, () => {
        const condition = nestedSecond(
          clause(operator, 'data_category', ['open']),
        );

        const result = validateCategoryCondition(condition);

        assertRefusedFor(
          result,
          'condition.content[1]',
          CONDITION_RULES.exclusion,
        );
      });
    }

    test('tells the author of an exclusion to write a not around an in', () => {
      const rule = CONDITION_RULES.exclusion;

      assert.match(rule, /not around an in/u);
    });

    test('refuses an exclusion that is the whole condition', () => {
      const condition = clause('not-in', 'data_category', ['open']);

      const result = validateCategoryCondition(condition);

      assertRefusedFor(result, 'condition', CONDITION_RULES.exclusion);
    });

    test('refuses an exclusion inside a not, which still excludes', () => {
      const condition = {
        content: [clause('not-in', 'data_category', ['open'])],
        op: 'not',
      };

      const result = validateCategoryCondition(condition);

      assertRefusedFor(
        result,
        'condition.content[0]',
        CONDITION_RULES.exclusion,
      );
    });

    test('refuses an all, since requiring several values is written as an and of in clauses', () => {
      const condition = nestedSecond(
        clause('all', 'consent_codes', ['GRU', 'NPU']),
      );

      const result = validateCategoryCondition(condition);

      assertRefusedFor(result, 'condition.content[1]', CONDITION_RULES.all);
    });

    test('accepts an and of in clauses on one field, which is what an all is written as', () => {
      const condition = nestedSecond({
        content: [
          inClause('consent_codes', ['GRU']),
          inClause('consent_codes', ['NPU']),
        ],
        op: 'and',
      });

      const result = validateCategoryCondition(condition);

      assertAccepted(result);
    });

    test('refuses an operator SQON does not define, which SqonSchema refuses first', () => {
      const condition = nestedSecond(clause('matches', 'data_category', ['a']));

      const result = validateCategoryCondition(condition);

      assertRefusedFor(result, 'condition', CONDITION_RULES.validSqon);
    });

    for (const operator of [
      'matches',
      'xor',
      'constructor',
      'toString',
      '__proto__',
      'IN',
    ]) {
      test(`refuses the operator ${operator}, unknown to SQON, by the walk alone`, () => {
        const condition = nestedSecond(
          clause(operator, 'data_category', ['a']),
        );

        const result = walkResult(condition);

        assertRefusedFor(
          result,
          'condition.content[1]',
          CONDITION_RULES.operator,
        );
      });
    }

    test('refuses an operator that is not a string, by the walk alone', () => {
      const condition = {
        content: [inClause('data_category', ['controlled'])],
        op: ['and'],
      };

      const result = walkResult(condition);

      assertRefusedFor(result, 'condition', CONDITION_RULES.operator);
    });
  });

  suite('an and or an or', () => {
    for (const operator of ['and', 'or']) {
      test(`refuses an empty ${operator} as the whole condition, since an empty group matches every record`, () => {
        const result = validateCategoryCondition({ content: [], op: operator });

        assertRefusedFor(result, 'condition', CONDITION_RULES.groupNotEmpty);
      });

      test(`refuses an empty ${operator} nested two levels down`, () => {
        const condition = nestedSecond(
          nestedSecond({ content: [], op: operator }),
        );

        const result = validateCategoryCondition(condition);

        assertRefusedFor(
          result,
          'condition.content[1].content[1]',
          CONDITION_RULES.groupNotEmpty,
        );
      });

      test(`refuses an ${operator} whose content is not a list, by the walk alone`, () => {
        const condition = nestedSecond({
          content: { fieldName: 'data_category', value: ['controlled'] },
          op: operator,
        });

        const result = walkResult(condition);

        assertRefusedFor(
          result,
          'condition.content[1]',
          CONDITION_RULES.contentIsList,
        );
      });
    }

    test('reports a problem in every entry, not only the first', () => {
      const condition = {
        content: [
          clause('not-in', 'data_category', ['open']),
          clause('all', 'consent_codes', ['GRU']),
        ],
        op: 'or',
      };

      const result = validateCategoryCondition(condition);

      assertRefusedFor(
        result,
        'condition.content[0]',
        CONDITION_RULES.exclusion,
      );
      assertRefusedFor(result, 'condition.content[1]', CONDITION_RULES.all);
    });
  });

  suite('a not', () => {
    test('refuses an empty not', () => {
      const result = validateCategoryCondition(
        nestedSecond({ content: [], op: 'not' }),
      );

      assertRefusedFor(
        result,
        'condition.content[1]',
        CONDITION_RULES.notHoldsOne,
      );
    });

    test('refuses a not holding two conditions', () => {
      const condition = {
        content: [
          inClause('data_category', ['open']),
          inClause('data_category', ['registered']),
        ],
        op: 'not',
      };

      const result = validateCategoryCondition(condition);

      assertRefusedFor(result, 'condition', CONDITION_RULES.notHoldsOne);
    });

    test('accepts a not holding one in that lists both values, which is how neither is written', () => {
      const condition = {
        content: [inClause('data_category', ['open', 'registered'])],
        op: 'not',
      };

      const result = validateCategoryCondition(condition);

      assertAccepted(result);
    });

    test('refuses a not whose content is not a list, by the walk alone', () => {
      const condition = {
        content: inClause('data_category', ['open']),
        op: 'not',
      };

      const result = walkResult(condition);

      assertRefusedFor(result, 'condition', CONDITION_RULES.contentIsList);
    });

    test('reports a problem inside a not holding two conditions', () => {
      const condition = {
        content: [
          inClause('data_category', ['open']),
          clause('not-in', 'data_category', ['registered']),
        ],
        op: 'not',
      };

      const result = validateCategoryCondition(condition);

      assertRefusedFor(result, 'condition', CONDITION_RULES.notHoldsOne);
      assertRefusedFor(
        result,
        'condition.content[1]',
        CONDITION_RULES.exclusion,
      );
    });
  });

  suite('a clause', () => {
    for (const [operator, value] of [
      ['in', [18]],
      ['gte', 18],
      ['between', [18, 65]],
    ] as const) {
      test(`refuses ${operator} content carrying a member other than fieldName and value`, () => {
        const condition = nestedSecond({
          content: { fieldName: 'donor_age', grants: ['all'], value },
          op: operator,
        });

        const result = validateCategoryCondition(condition);

        assertRefusedFor(
          result,
          'condition.content[1]',
          CONDITION_RULES.clauseMembers,
        );
      });

      test(`refuses ${operator} content naming fieldNames beside fieldName`, () => {
        const condition = nestedSecond({
          content: {
            fieldName: 'donor_age',
            fieldNames: ['donor_age'],
            value,
          },
          op: operator,
        });

        const result = validateCategoryCondition(condition);

        assertRefusedFor(
          result,
          'condition.content[1]',
          CONDITION_RULES.clauseMembers,
        );
      });
    }

    for (const [description, content] of [
      ['an empty field name', { fieldName: '', value: ['a'] }],
      ['a field name that is not a string', { fieldName: 42, value: ['a'] }],
      ['no field name', { value: ['a'] }],
      ['fieldNames in place of fieldName', { fieldNames: ['a'], value: ['a'] }],
    ] as const) {
      test(`refuses a clause with ${description}, which SqonSchema refuses first`, () => {
        const result = validateCategoryCondition(
          nestedSecond({ content, op: 'in' }),
        );

        assertRefusedFor(result, 'condition', CONDITION_RULES.validSqon);
      });

      test(`refuses a clause with ${description}, by the walk alone`, () => {
        const result = walkResult(nestedSecond({ content, op: 'in' }));

        assertRefusedFor(
          result,
          'condition.content[1]',
          CONDITION_RULES.namesField,
        );
      });
    }

    test('refuses clause content that is not a map, by the walk alone', () => {
      const result = walkResult(
        nestedSecond({ content: 'data_category', op: 'in' }),
      );

      assertRefusedFor(
        result,
        'condition.content[1]',
        CONDITION_RULES.namesField,
      );
    });
  });

  suite('an in', () => {
    for (const operator of ['in', '=']) {
      test(`refuses an ${operator} with an empty value list, which would carry the category on no record`, () => {
        const result = validateCategoryCondition(
          nestedSecond(clause(operator, 'data_category', [])),
        );

        assertRefusedFor(
          result,
          'condition.content[1]',
          CONDITION_RULES.inValueList,
        );
      });

      test(`refuses an ${operator} with a single value written without a list`, () => {
        const result = validateCategoryCondition(
          nestedSecond(clause(operator, 'data_category', 'controlled')),
        );

        assertRefusedFor(
          result,
          'condition.content[1]',
          CONDITION_RULES.inValueList,
        );
      });
    }

    test('refuses an in naming one value twice', () => {
      const result = validateCategoryCondition(
        nestedSecond(inClause('data_category', ['controlled', 'controlled'])),
      );

      assertRefusedFor(
        result,
        'condition.content[1]',
        CONDITION_RULES.inValuesDistinct,
      );
    });

    test('refuses an in naming zero twice, as 0 and -0', () => {
      const result = validateCategoryCondition(
        nestedSecond(inClause('consent_version', [0, -0])),
      );

      assertRefusedFor(
        result,
        'condition.content[1]',
        CONDITION_RULES.inValuesDistinct,
      );
    });

    for (const [description, value] of [
      ['a boolean', [true]],
      ['an empty string', ['']],
      ['a boolean beside a usable value', ['controlled', false]],
    ] as const) {
      test(`refuses an in listing ${description}`, () => {
        const result = validateCategoryCondition(
          nestedSecond(inClause('data_category', value)),
        );

        assertRefusedFor(
          result,
          'condition.content[1]',
          CONDITION_RULES.inValueKinds,
        );
      });
    }

    for (const [description, value] of [
      ['null', [null]],
      ['an object', [{ id: 'controlled' }]],
      ['a nested list', [['controlled']]],
      ['NaN', [Number.NaN]],
      ['an infinite number', [Number.POSITIVE_INFINITY]],
    ] as const) {
      test(`refuses an in listing ${description}, which SqonSchema refuses first`, () => {
        const result = validateCategoryCondition(
          nestedSecond(inClause('data_category', value)),
        );

        assertRefusedFor(result, 'condition', CONDITION_RULES.validSqon);
      });

      test(`refuses an in listing ${description}, by the walk alone`, () => {
        const result = walkResult(
          nestedSecond(inClause('data_category', value)),
        );

        assertRefusedFor(
          result,
          'condition.content[1]',
          CONDITION_RULES.inValueKinds,
        );
      });
    }

    for (const [description, value] of [
      ['a * pattern', ['*']],
      ['a * pattern beside a literal value', ['controlled', 'restr*']],
      ['a saved-set reference', ['set_id:a1b2']],
      ['the missing-field marker', ['__missing__']],
      ['a single * pattern written without a list', '*'],
    ] as const) {
      test(`refuses an in listing ${description}, since a condition names literal values`, () => {
        const result = validateCategoryCondition(
          nestedSecond(inClause('data_category', value)),
        );

        assertRefusedFor(
          result,
          'condition.content[1]',
          CONDITION_RULES.literalValues,
        );
      });
    }
  });

  suite('a range', () => {
    for (const operator of ['gt', 'gte', 'lt', 'lte', '>', '>=', '<', '<=']) {
      test(`refuses a ${operator} holding a list, though it holds one bound`, () => {
        const result = validateCategoryCondition(
          nestedSecond(clause(operator, 'donor_age', [18])),
        );

        assertRefusedFor(
          result,
          'condition.content[1]',
          CONDITION_RULES.openRangeBound,
        );
      });
    }

    for (const [description, value] of [
      ['an empty string', ''],
      ['a boolean', true],
    ] as const) {
      test(`refuses a gte bounded by ${description}`, () => {
        const result = validateCategoryCondition(
          nestedSecond(clause('gte', 'donor_age', value)),
        );

        assertRefusedFor(
          result,
          'condition.content[1]',
          CONDITION_RULES.openRangeBound,
        );
      });
    }

    for (const [description, value] of [
      ['an empty string', ['', '2020-12-31']],
      ['a boolean', [true, 65]],
    ] as const) {
      test(`refuses a between bounded by ${description}`, () => {
        const result = validateCategoryCondition(
          nestedSecond(clause('between', 'donor_age', value)),
        );

        assertRefusedFor(
          result,
          'condition.content[1]',
          CONDITION_RULES.betweenBounds,
        );
      });
    }

    for (const [description, value] of [
      ['two numbers highest first', [65, 18]],
      ['two dates latest first', ['2020-12-31', '2020-01-01']],
      ['a number and a date', [18, '2020-12-31']],
      ['a date and a number', ['2020-01-01', 65]],
    ] as const) {
      test(`refuses a between holding ${description}, since it would bound no record and leave the category on none`, () => {
        const result = validateCategoryCondition(
          nestedSecond(clause('between', 'donor_age', value)),
        );

        assertRefusedFor(
          result,
          'condition.content[1]',
          CONDITION_RULES.betweenOrder,
        );
      });
    }

    for (const [description, value] of [
      ['one number twice', [18, 18]],
      ['two dates earliest first', ['2020-01-01', '2020-12-31']],
      ['one date twice', ['2020-01-01', '2020-01-01']],
    ] as const) {
      test(`accepts a between holding ${description}`, () => {
        assertAccepted(
          validateCategoryCondition(clause('between', 'donor_age', value)),
        );
      });
    }

    for (const [description, operator, value] of [
      ['an in listing now', 'in', ['controlled', 'now']],
      ['an in listing a relative date', 'in', ['now-1y']],
      ['an in listing a rounded date', 'in', ['now/d']],
      ['an in listing an anchored date', 'in', ['2024-01-01||+1M']],
      ['a gte from now less a year', 'gte', 'now-1y'],
      ['an lt before an anchored date', 'lt', '2024-01-01||-1d'],
      ['a between ending now', 'between', ['2020-01-01', 'now']],
      [
        'a between from an anchored date',
        'between',
        ['2024-01-01||+1M', '2024-06-30'],
      ],
      ['an in listing now in upper case', 'in', ['NOW']],
      ['a gte from now in upper case less a year', 'gte', 'NOW-1y'],
      ['an in listing a rounded date in mixed case', 'in', ['Now/d']],
      [
        'an in listing a relative date after leading spaces',
        'in',
        ['  now-1y'],
      ],
      ['an lt before now after a leading tab', 'lt', '\tnow'],
      ['an in listing now followed by a space', 'in', ['now ']],
    ] as const) {
      test(`refuses ${description}, since date math moves records between categories as time passes`, () => {
        const result = validateCategoryCondition(
          nestedSecond(clause(operator, 'collection_date', value)),
        );

        assertRefusedFor(
          result,
          'condition.content[1]',
          CONDITION_RULES.fixedValues,
        );
      });
    }

    for (const value of [
      'unknown',
      'snow',
      'nowhere',
      'now1',
      'not now',
      'a|b',
      'snowfall',
      'NOWHERE',
      '  nowhere',
      'now and then',
    ]) {
      test(`accepts the keyword value ${value}, which is not date math`, () => {
        assertAccepted(
          validateCategoryCondition(clause('in', 'data_category', [value])),
        );
      });
    }

    for (const [description, value] of [
      ['one bound', [18]],
      ['three bounds', [18, 40, 65]],
      ['a single bound written without a list', 18],
    ] as const) {
      test(`refuses a between holding ${description}, which SqonSchema refuses first`, () => {
        const result = validateCategoryCondition(
          nestedSecond(clause('between', 'donor_age', value)),
        );

        assertRefusedFor(result, 'condition', CONDITION_RULES.validSqon);
      });

      test(`refuses a between holding ${description}, by the walk alone`, () => {
        const result = walkResult(
          nestedSecond(clause('between', 'donor_age', value)),
        );

        assertRefusedFor(
          result,
          'condition.content[1]',
          CONDITION_RULES.betweenBounds,
        );
      });
    }

    for (const [operator, value] of [
      ['lt', '2020*'],
      ['gte', 'set_id:a1b2'],
      ['between', ['__missing__', '2020-12-31']],
      ['between', ['2020-01-01', '*']],
    ] as const) {
      test(`refuses a ${operator} bounded by ${JSON.stringify(value)}, since a condition names literal values`, () => {
        const result = validateCategoryCondition(
          nestedSecond(clause(operator, 'collection_date', value)),
        );

        assertRefusedFor(
          result,
          'condition.content[1]',
          CONDITION_RULES.literalValues,
        );
      });
    }
  });

  suite('the depth', () => {
    test('accepts a condition nested to the depth limit, by the walk alone', () => {
      const condition = nestedDeeperThan(
        128,
        inClause('data_category', ['controlled']),
      );

      const result = walkResult(condition);

      assertAccepted(result);
    });

    test('refuses a condition nested one level past the depth limit, by the walk alone', () => {
      const condition = nestedDeeperThan(
        129,
        inClause('data_category', ['controlled']),
      );

      const result = walkResult(condition);

      assertRefusedFor(
        result,
        `condition${'.content[0]'.repeat(129)}`,
        CONDITION_RULES.depth,
      );
    });

    /** Nots around a range, whose bound sits two JSON levels below the range node. */
    const negatedRange = (levels: number): unknown =>
      Array.from({ length: levels }).reduce<unknown>(
        (inner) => ({ content: [inner], op: 'not' }),
        clause('gte', 'donor_age', 18),
      );

    /** The deepest nesting of nots whose range bound stays within the authored limit. */
    const deepestLevels = (128 - 2 * RENDERED_WRAPPING_NODES - 2) / 2;

    test('accepts a condition reaching the depth that leaves room for the rendered narrowing around it', () => {
      const condition = negatedRange(deepestLevels);

      const result = validateCategoryCondition(condition);

      assertAccepted(result);
    });

    test('refuses a condition one level deeper than leaves room for the rendered narrowing, at its own position', () => {
      const condition = negatedRange(deepestLevels + 1);

      const result = validateCategoryCondition(condition);

      assertRefusedFor(result, 'condition', CONDITION_RULES.depth);
    });

    test('refuses a condition nested past any usable depth, which SqonSchema refuses first', () => {
      const condition = nestedDeeperThan(
        10_000,
        inClause('data_category', ['controlled']),
      );

      const result = validateCategoryCondition(condition);

      assertRefusedFor(result, 'condition', CONDITION_RULES.validSqon);
    });
  });

  suite('what it returns', () => {
    test('returns a copy, so a later change to the input reaches nothing returned', () => {
      const condition = {
        content: [inClause('data_category', ['controlled'])],
        op: 'and',
      };

      const result = validateCategoryCondition(condition);
      condition.op = 'or';

      assert.deepEqual(result.success && result.condition, {
        content: [inClause('data_category', ['controlled'])],
        op: 'and',
      });
    });

    test('returns no member a node inherits', () => {
      const inherited = Object.assign(Object.create(null), { pivot: 'donors' });
      const condition = Object.assign(
        Object.create(inherited),
        inClause('data_category', ['controlled']),
      );

      const result = validateCategoryCondition(condition);
      const returned: unknown = result.success && result.condition;

      assertAccepted(result);
      assert.equal('pivot' in Object(returned), false);
    });

    test('refuses a condition holding a getter that throws, returning the refusal rather than throwing', () => {
      const condition = Object.defineProperty({ op: 'in' }, 'content', {
        enumerable: true,
        get: (): never => {
          throw new Error('unreadable');
        },
      });

      const result = validateCategoryCondition(condition);

      assertRefusedFor(result, '(root)', READ_RULE);
    });
  });

  suite('what problems carry', () => {
    const MARKED_FIELD = `${LEAK_MARKER}_field`;
    const MARKED_VALUE = `${LEAK_MARKER}_value`;

    /** The words fixed by the contract, carried unmarked by a leak input. */
    const CONTRACT_WORDS: ReadonlySet<string> = new Set([
      'all',
      'and',
      'between',
      'content',
      'field',
      'fieldName',
      'fieldNames',
      'gt',
      'in',
      'not',
      'not-in',
      'op',
      'or',
      'pivot',
      'value',
      'wildcard',
    ]);

    const markedClause = (
      operator: string,
      value: unknown,
    ): Record<string, unknown> => clause(operator, MARKED_FIELD, value);

    /** A valid `and` holding a marked `in`, then `node` as its second entry. */
    const markedNested = (node: unknown): Record<string, unknown> => ({
      content: [markedClause('in', [MARKED_VALUE]), node],
      op: 'and',
    });

    const leakCases: readonly (LeakCase & { walkOnly?: true })[] = [
      {
        description: 'an all',
        input: markedNested(markedClause('all', [MARKED_VALUE])),
        position: 'condition.content[1]',
        rule: CONDITION_RULES.all,
      },
      {
        description: 'a between holding an unusable bound',
        input: markedNested(markedClause('between', [true, LEAK_NUMBER])),
        position: 'condition.content[1]',
        rule: CONDITION_RULES.betweenBounds,
      },
      {
        description: 'an in listing date math',
        input: markedNested(markedClause('in', [`${LEAK_MARKER}||+1M`])),
        position: 'condition.content[1]',
        rule: CONDITION_RULES.fixedValues,
      },
      {
        description: 'a between holding two numbers highest first',
        input: markedNested(markedClause('between', [LEAK_NUMBER, 1])),
        position: 'condition.content[1]',
        rule: CONDITION_RULES.betweenOrder,
      },
      {
        description: 'an unknown member in clause content',
        input: markedNested({
          content: {
            fieldName: MARKED_FIELD,
            value: [MARKED_VALUE],
            [`${LEAK_MARKER}_member`]: `${LEAK_MARKER}_passenger`,
          },
          op: 'in',
        }),
        position: 'condition.content[1]',
        rule: CONDITION_RULES.clauseMembers,
      },
      {
        description: 'combination content that is not a list',
        input: markedNested({
          content: { fieldName: MARKED_FIELD, value: [MARKED_VALUE] },
          op: 'and',
        }),
        position: 'condition.content[1]',
        rule: CONDITION_RULES.contentIsList,
        walkOnly: true,
      },
      {
        description: 'nesting past the depth limit',
        input: nestedDeeperThan(
          200,
          markedClause('in', [MARKED_VALUE, LEAK_NUMBER]),
        ),
        position: `condition${'.content[0]'.repeat(129)}`,
        rule: CONDITION_RULES.depth,
        walkOnly: true,
      },
      {
        description: 'nesting past the room left for the rendered narrowing',
        input: nestedDeeperThan(
          60,
          markedClause('in', [MARKED_VALUE, LEAK_NUMBER]),
        ),
        position: 'condition',
        rule: CONDITION_RULES.depth,
      },
      {
        description: 'an exclusion',
        input: markedNested(markedClause('not-in', [MARKED_VALUE])),
        position: 'condition.content[1]',
        rule: CONDITION_RULES.exclusion,
      },
      {
        description: 'an empty group',
        input: markedNested({ content: [], op: 'or' }),
        position: 'condition.content[1]',
        rule: CONDITION_RULES.groupNotEmpty,
      },
      {
        description: 'an in listing a value of the wrong kind',
        input: markedNested(markedClause('in', [MARKED_VALUE, true])),
        position: 'condition.content[1]',
        rule: CONDITION_RULES.inValueKinds,
      },
      {
        description: 'an in whose value is not a list',
        input: markedNested(markedClause('in', MARKED_VALUE)),
        position: 'condition.content[1]',
        rule: CONDITION_RULES.inValueList,
      },
      {
        description: 'an in naming a value twice',
        input: markedNested(markedClause('in', [MARKED_VALUE, MARKED_VALUE])),
        position: 'condition.content[1]',
        rule: CONDITION_RULES.inValuesDistinct,
      },
      {
        description: 'a value holding a marker',
        input: markedNested(markedClause('in', [`${LEAK_MARKER}*`])),
        position: 'condition.content[1]',
        rule: CONDITION_RULES.literalValues,
      },
      {
        description: 'a clause using the key field',
        input: markedNested({
          content: { field: MARKED_FIELD, value: [MARKED_VALUE] },
          op: 'in',
        }),
        position: 'condition.content[1]',
        rule: CONDITION_RULES.namesField,
        walkOnly: true,
      },
      {
        description: 'an entry that is not a map',
        input: markedNested(`${LEAK_MARKER}_entry`),
        position: 'condition.content[1]',
        rule: CONDITION_RULES.nodeIsMap,
        walkOnly: true,
      },
      {
        description: 'an unknown member on a node',
        input: markedNested({
          ...markedClause('in', [MARKED_VALUE]),
          [`${LEAK_MARKER}_member`]: `${LEAK_MARKER}_passenger`,
        }),
        position: 'condition.content[1]',
        rule: CONDITION_RULES.nodeMembers,
      },
      {
        description: 'a not holding two conditions',
        input: markedNested({
          content: [
            markedClause('in', [MARKED_VALUE]),
            markedClause('in', [`${LEAK_MARKER}_other`]),
          ],
          op: 'not',
        }),
        position: 'condition.content[1]',
        rule: CONDITION_RULES.notHoldsOne,
      },
      {
        description: 'an open range holding a list',
        input: markedNested(markedClause('gt', [LEAK_NUMBER])),
        position: 'condition.content[1]',
        rule: CONDITION_RULES.openRangeBound,
      },
      {
        description: 'an unknown operator',
        input: markedNested(markedClause(`${LEAK_MARKER}_op`, [MARKED_VALUE])),
        position: 'condition.content[1]',
        rule: CONDITION_RULES.operator,
        walkOnly: true,
      },
      {
        description: 'a wildcard pattern',
        input: markedNested({
          content: {
            fieldNames: [MARKED_FIELD],
            value: `${LEAK_MARKER}_pattern`,
          },
          op: 'wildcard',
        }),
        position: 'condition.content[1]',
        rule: CONDITION_RULES.pattern,
      },
      {
        description: 'a pivot path',
        input: markedNested({
          ...markedClause('in', [MARKED_VALUE]),
          pivot: `${LEAK_MARKER}_pivot`,
        }),
        position: 'condition.content[1]',
        rule: CONDITION_RULES.pivot,
      },
      {
        description: 'a value list holding an object',
        input: markedNested(
          markedClause('in', [{ [LEAK_MARKER]: MARKED_VALUE }]),
        ),
        position: 'condition',
        rule: CONDITION_RULES.validSqon,
      },
    ];

    for (const { description, input, position, rule, walkOnly } of leakCases) {
      test(`names no content of the input in the problems for ${description}`, () => {
        assertInputMarked(input, CONTRACT_WORDS);

        const result = walkOnly
          ? walkResult(input)
          : validateCategoryCondition(input);

        assertRefusedFor(result, position, rule);
        assertCarriesNoInput(result);
      });
    }

    test('names no content of an error thrown by a getter while the condition is read', () => {
      const condition = Object.defineProperty({ op: 'in' }, 'content', {
        enumerable: true,
        get: (): never => {
          throw new Error(`${LEAK_MARKER}_thrown`);
        },
      });

      const result = validateCategoryCondition(condition);

      assertRefusedFor(result, '(root)', READ_RULE);
      assertCarriesNoInput(result);
    });

    test('breaks every rule held by the validator, between the inputs above', () => {
      const cases = leakCases;

      assertEveryRuleBroken(cases, CONDITION_RULES);
    });
  });
});

suite('fieldNamesReadBy', () => {
  test('returns the one field a single clause reads', () => {
    const condition = validated(inClause('data_category', ['controlled']));

    const fieldNames = fieldNamesReadBy(condition);

    assert.deepEqual(fieldNames, ['data_category']);
  });

  test('returns each field once, sorted, for a nested condition reading some fields more than once', () => {
    const condition = validated({
      content: [
        inClause('study_id', ['HEART_STUDY']),
        {
          content: [
            clause('lt', 'collection_date', '2020-03-01'),
            clause('gte', 'collection_date', '2022-01-01'),
          ],
          op: 'or',
        },
        {
          content: [
            {
              content: [
                inClause('data_category', ['open']),
                clause('<', 'donor_age', 18),
              ],
              op: 'and',
            },
          ],
          op: 'not',
        },
        clause('between', 'donor_age', [18, 65]),
        clause('=', 'study_id', ['LUNG_COHORT']),
      ],
      op: 'and',
    });

    const fieldNames = fieldNamesReadBy(condition);

    assert.deepEqual(fieldNames, [
      'collection_date',
      'data_category',
      'donor_age',
      'study_id',
    ]);
  });

  test('sorts by code unit, so the order never depends on a locale', () => {
    const condition = validated({
      content: [
        inClause('alpha', ['a']),
        inClause('Zeta', ['z']),
        inClause('élan', ['e']),
      ],
      op: 'or',
    });

    const fieldNames = fieldNamesReadBy(condition);

    assert.deepEqual(fieldNames, ['Zeta', 'alpha', 'élan']);
  });
});

suite('normalizedCondition', () => {
  test('sorts the keys of every node by code unit, at every depth, whatever order they were written in', () => {
    const condition = validated(
      JSON.parse(
        '{"op":"and","content":[{"op":"in","content":{"value":["late"],"fieldName":"cohort"}},{"content":{"value":65,"fieldName":"donor_age"},"op":"gte"}]}',
      ),
    );

    const normalized = normalizedCondition(condition);

    assert.equal(
      JSON.stringify(normalized),
      '{"content":[{"content":{"fieldName":"cohort","value":["late"]},"op":"in"},{"content":{"fieldName":"donor_age","value":65},"op":"gte"}],"op":"and"}',
    );
  });

  test('writes a bound of negative zero as zero, so the two spellings give one condition', () => {
    const condition = validated(clause('gte', 'balance', -0));

    const normalized = normalizedCondition(condition);

    assert.deepEqual(normalized, {
      content: { fieldName: 'balance', value: 0 },
      op: 'gte',
    });
  });

  test('returns a copy, leaving the condition given unchanged and sharing no object with it', () => {
    const condition = Object.freeze(
      validated({
        content: [inClause('cohort', ['late'])],
        op: 'not',
      }),
    );
    const given = structuredClone(condition);

    const normalized = normalizedCondition(condition);

    assert.deepEqual(condition, given);
    assert.deepEqual(normalized, given);
    assert.notEqual(normalized, condition);
    assert.notEqual(normalized.content, condition.content);
  });
});
