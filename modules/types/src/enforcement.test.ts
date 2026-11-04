import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type { SqonNode } from '@overture-stack/sqon';

import {
  ENFORCEMENT_RULES,
  type Enforcement,
  validateEnforcement,
  walkProblems,
} from './enforcement.js';
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

const inClause = (
  fieldName: unknown,
  value: unknown,
): Record<string, unknown> => ({ content: { fieldName, value }, op: 'in' });

const narrow = (sqon: unknown): unknown => ({ kind: 'narrow', sqon });

/** A valid `and` holding `node` as its second entry, so a refusal of `node` comes from depth. */
const nestedSecond = (node: unknown): Record<string, unknown> => ({
  content: [inClause('study_id', ['HEART_STUDY']), node],
  op: 'and',
});

/** What the walk alone finds, as a validator's result. */
const walkResult = (sqon: unknown): CheckedResult => {
  const problems = walkProblems(sqon);

  return problems.length > 0 ? { problems, success: false } : { success: true };
};

/** A narrowing grouped by category, which the walk accepts: one category clause and one unmarked clause. */
const groupedSqon: SqonNode = {
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
    {
      content: [
        {
          content: {
            fieldName: 'study_id',
            value: ['HEART_STUDY', 'LUNG_COHORT'],
          },
          op: 'in',
        },
        {
          content: [
            {
              content: { fieldName: 'data_category', value: ['controlled'] },
              op: 'in',
            },
          ],
          op: 'not',
        },
      ],
      op: 'and',
    },
  ],
  op: 'or',
};

const nestedDeeperThan = (levels: number, leaf: unknown): unknown =>
  Array.from({ length: levels }).reduce<unknown>(
    (inner) => ({ content: [inner], op: 'and' }),
    leaf,
  );

suite('validateEnforcement', () => {
  suite('the arms', () => {
    const validArms: readonly (readonly [string, Enforcement])[] = [
      ['an allow', { kind: 'allow' }],
      [
        'a deny for grants more than the filter can express',
        { kind: 'deny', reason: 'filter-limit' },
      ],
      ['a deny for holding no grants', { kind: 'deny', reason: 'no-grants' }],
      [
        'a deny for a rendered filter disagreeing with its payload',
        { kind: 'deny', reason: 'rendering-mismatch' },
      ],
      [
        'a deny for an unknown resource',
        { kind: 'deny', reason: 'unknown-resource' },
      ],
      [
        'a deny for a global category the catalogue leaves unmapped',
        { kind: 'deny', reason: 'unmapped-category' },
      ],
      [
        'a narrowing grouped by category',
        { kind: 'narrow', sqon: groupedSqon },
      ],
      [
        'a narrowing that is a single in clause',
        {
          kind: 'narrow',
          sqon: {
            content: { fieldName: 'study_id', value: ['HEART_STUDY'] },
            op: 'in',
          },
        },
      ],
      [
        'a narrowing that is an in clause over a single value',
        {
          kind: 'narrow',
          sqon: {
            content: { fieldName: 'study_id', value: 'HEART_STUDY' },
            op: 'in',
          },
        },
      ],
      [
        'a narrowing that writes in as =',
        {
          kind: 'narrow',
          sqon: {
            content: { fieldName: 'study_id', value: ['HEART_STUDY'] },
            op: '=',
          },
        },
      ],
      [
        'a narrowing holding a bounded range',
        {
          kind: 'narrow',
          sqon: {
            content: [
              {
                content: { fieldName: 'study_id', value: ['HEART_STUDY'] },
                op: 'in',
              },
              { content: { fieldName: 'donor.age', value: 18 }, op: 'gte' },
            ],
            op: 'and',
          },
        },
      ],
      [
        'a narrowing holding a range written as >=',
        {
          kind: 'narrow',
          sqon: {
            content: [
              {
                content: { fieldName: 'study_id', value: ['HEART_STUDY'] },
                op: 'in',
              },
              { content: { fieldName: 'donor.age', value: [18] }, op: '>=' },
            ],
            op: 'and',
          },
        },
      ],
      [
        'a narrowing holding a non-empty all',
        {
          kind: 'narrow',
          sqon: {
            content: { fieldName: 'study_id', value: ['HEART_STUDY'] },
            op: 'all',
          },
        },
      ],
    ];

    for (const [description, enforcement] of validArms) {
      test(`accepts ${description} and returns it unchanged`, () => {
        const result = validateEnforcement(enforcement);

        assertAccepted(result);
        assert.deepEqual(result.success && result.enforcement, enforcement);
      });
    }

    for (const [description, value] of [
      ['undefined', undefined],
      ['null', null],
      ['a string', 'allow'],
      ['a list', [{ kind: 'allow' }]],
    ] as const) {
      test(`refuses ${description} as an enforcement result, returning the refusal rather than throwing`, () => {
        const result = validateEnforcement(value);

        assertRefusedFor(result, '(root)', ENFORCEMENT_RULES.isMap);
      });
    }

    for (const [description, value, position, rule] of [
      ['an unknown kind', { kind: 'permit' }, 'kind', ENFORCEMENT_RULES.kind],
      [
        'a kind named like a member of Object.prototype',
        { kind: 'constructor' },
        'kind',
        ENFORCEMENT_RULES.kind,
      ],
      [
        'a missing kind',
        { reason: 'no-grants' },
        'kind',
        ENFORCEMENT_RULES.kind,
      ],
      [
        'an allow carrying a filter',
        { kind: 'allow', sqon: groupedSqon },
        '(root)',
        ENFORCEMENT_RULES.armMembers,
      ],
      [
        'an allow carrying a reason',
        { kind: 'allow', reason: 'no-grants' },
        '(root)',
        ENFORCEMENT_RULES.armMembers,
      ],
      [
        'a deny with an unknown reason',
        { kind: 'deny', reason: 'expired' },
        'reason',
        ENFORCEMENT_RULES.denyReason,
      ],
      [
        'a deny with no reason',
        { kind: 'deny' },
        'reason',
        ENFORCEMENT_RULES.denyReason,
      ],
      [
        'a deny carrying a filter',
        { kind: 'deny', reason: 'no-grants', sqon: groupedSqon },
        '(root)',
        ENFORCEMENT_RULES.armMembers,
      ],
      [
        'a narrowing with no filter',
        { kind: 'narrow' },
        'sqon',
        ENFORCEMENT_RULES.validSqon,
      ],
      [
        'a narrowing with a null filter',
        { kind: 'narrow', sqon: null },
        'sqon',
        ENFORCEMENT_RULES.validSqon,
      ],
      [
        'a narrowing carrying a reason',
        { kind: 'narrow', reason: 'no-grants', sqon: groupedSqon },
        '(root)',
        ENFORCEMENT_RULES.armMembers,
      ],
    ] as const) {
      test(`refuses ${description}, since each arm is a strict object`, () => {
        const result = validateEnforcement(value);

        assertRefusedFor(result, position, rule);
      });
    }
  });

  suite("a narrowing's filter", () => {
    for (const [description, sqon] of [
      [
        'a value list holding an object',
        {
          content: { fieldName: 'study_id', value: [{ id: 'HEART_STUDY' }] },
          op: 'in',
        },
      ],
      [
        'a value list holding null',
        { content: { fieldName: 'study_id', value: [null] }, op: 'in' },
      ],
      [
        'an operator SQON does not define',
        {
          content: { fieldName: 'study_id', value: ['HEART_STUDY'] },
          op: 'matches',
        },
      ],
      [
        'a between holding three values',
        {
          content: { fieldName: 'donor.age', value: [1, 2, 3] },
          op: 'between',
        },
      ],
      [
        'a combination under an unknown operator',
        { content: [inClause('study_id', ['HEART_STUDY'])], op: 'xor' },
      ],
      ['a group entry that is null', nestedSecond(null)],
      ['a group entry that is a string', nestedSecond('study_id')],
      ['a group entry that is a number', nestedSecond(42)],
      [
        'a group entry that is a list',
        nestedSecond([inClause('study_id', ['HEART_STUDY'])]),
      ],
      [
        'a group whose content is a clause body rather than a list',
        nestedSecond({
          content: { fieldName: 'study_id', value: ['HEART_STUDY'] },
          op: 'and',
        }),
      ],
      [
        'a group whose content is a string',
        nestedSecond({ content: 'study_id', op: 'and' }),
      ],
      [
        'a clause with an empty field name',
        nestedSecond({ content: { fieldName: '', value: ['A'] }, op: 'in' }),
      ],
      [
        'a clause using the key field in place of fieldName',
        nestedSecond({
          content: { field: 'study_id', value: ['A'] },
          op: 'in',
        }),
      ],
      [
        'a clause naming no field at all',
        nestedSecond({ content: { value: ['A'] }, op: 'in' }),
      ],
      [
        'a clause whose field name is not a string',
        nestedSecond({ content: { fieldName: 42, value: ['A'] }, op: 'in' }),
      ],
      [
        'a wildcard with an empty list of field names',
        nestedSecond({
          content: { fieldNames: [], value: 'A*' },
          op: 'wildcard',
        }),
      ],
      [
        'an all with an empty value list',
        nestedSecond({
          content: { fieldName: 'data_category', value: [] },
          op: 'all',
        }),
      ],
      [
        'a filter nested past any usable depth',
        nestedDeeperThan(10_000, inClause('study_id', ['HEART_STUDY'])),
      ],
    ] as const) {
      test(`refuses ${description}, which is not a valid SQON`, () => {
        const result = validateEnforcement(narrow(sqon));

        assertRefusedFor(result, 'sqon', ENFORCEMENT_RULES.validSqon);
      });
    }

    test('refuses a group whose content has a hole, which is not a valid SQON', () => {
      const content = [
        inClause('study_id', ['HEART_STUDY']),
        ,
        inClause('data_category', ['controlled']),
      ];

      const result = validateEnforcement(narrow({ content, op: 'or' }));

      assert.equal(Object.hasOwn(content, 1), false);
      assertRefusedFor(result, 'sqon', ENFORCEMENT_RULES.validSqon);
    });

    for (const operator of ['and', 'or', 'not']) {
      test(`refuses an empty ${operator} as the whole filter, since an empty group matches every document`, () => {
        const sqon = { content: [], op: operator };

        const result = validateEnforcement(narrow(sqon));

        assertRefusedFor(result, 'sqon', ENFORCEMENT_RULES.combinationNotEmpty);
      });

      test(`refuses an empty ${operator} nested inside the filter`, () => {
        const sqon = nestedSecond({ content: [], op: operator });

        const result = validateEnforcement(narrow(sqon));

        assertRefusedFor(
          result,
          'sqon.content[1]',
          ENFORCEMENT_RULES.combinationNotEmpty,
        );
      });
    }

    test('refuses an empty group nested two levels down', () => {
      const sqon = nestedSecond(nestedSecond({ content: [], op: 'or' }));

      const result = validateEnforcement(narrow(sqon));

      assertRefusedFor(
        result,
        'sqon.content[1].content[1]',
        ENFORCEMENT_RULES.combinationNotEmpty,
      );
    });

    for (const operator of ['not-in', 'some-not-in', '!=', '!==']) {
      for (const value of [['controlled'], []]) {
        test(`refuses an exclusion written ${operator} with ${value.length === 0 ? 'an empty' : 'a non-empty'} value list, since the bridge never emits one`, () => {
          const sqon = nestedSecond({
            content: { fieldName: 'data_category', value },
            op: operator,
          });

          const result = validateEnforcement(narrow(sqon));

          assertRefusedFor(
            result,
            'sqon.content[1]',
            ENFORCEMENT_RULES.exclusion,
          );
        });
      }
    }

    test('refuses an exclusion that is the whole filter', () => {
      const sqon = {
        content: { fieldName: 'data_category', value: ['controlled'] },
        op: 'not-in',
      };

      const result = validateEnforcement(narrow(sqon));

      assertRefusedFor(result, 'sqon', ENFORCEMENT_RULES.exclusion);
    });

    test('refuses an exclusion inside a not, which still excludes', () => {
      const sqon = nestedSecond({
        content: [
          {
            content: { fieldName: 'data_category', value: ['controlled'] },
            op: 'not-in',
          },
        ],
        op: 'not',
      });

      const result = validateEnforcement(narrow(sqon));

      assertRefusedFor(
        result,
        'sqon.content[1].content[0]',
        ENFORCEMENT_RULES.exclusion,
      );
    });

    for (const operator of ['in', '=', '==', '===']) {
      test(`refuses an in written ${operator} with an empty value list as the whole filter, since matching nothing is a deny`, () => {
        const sqon = {
          content: { fieldName: 'study_id', value: [] },
          op: operator,
        };

        const result = validateEnforcement(narrow(sqon));

        assertRefusedFor(result, 'sqon', ENFORCEMENT_RULES.inNotEmpty);
      });

      test(`refuses an in written ${operator} with an empty value list nested in the filter`, () => {
        const sqon = nestedSecond({
          content: { fieldName: 'data_category', value: [] },
          op: operator,
        });

        const result = validateEnforcement(narrow(sqon));

        assertRefusedFor(
          result,
          'sqon.content[1]',
          ENFORCEMENT_RULES.inNotEmpty,
        );
      });

      test(`refuses a not around an empty in written ${operator}, which would allow every document`, () => {
        const sqon = nestedSecond({
          content: [
            {
              content: { fieldName: 'data_category', value: [] },
              op: operator,
            },
          ],
          op: 'not',
        });

        const result = validateEnforcement(narrow(sqon));

        assertRefusedFor(
          result,
          'sqon.content[1].content[0]',
          ENFORCEMENT_RULES.inNotEmpty,
        );
      });
    }

    for (const [operator, value] of [
      ['gt', []],
      ['gte', ''],
      ['lt', ['']],
      ['lte', []],
      ['between', ['', '']],
      ['>', []],
      ['<=', ''],
    ] as const) {
      test(`refuses a ${operator} range of ${JSON.stringify(value)}, which holds no usable bound`, () => {
        const sqon = nestedSecond({
          content: { fieldName: 'donor.age', value },
          op: operator,
        });

        const result = validateEnforcement(narrow(sqon));

        assertRefusedFor(
          result,
          'sqon.content[1]',
          ENFORCEMENT_RULES.rangeBound,
        );
      });
    }

    for (const [description, operator, value] of [
      ['a between with one unusable bound', 'between', ['', 5]],
      ['a gt listing an unusable bound beside a usable one', 'gt', [5, '']],
    ] as const) {
      test(`refuses ${description}`, () => {
        const sqon = nestedSecond({
          content: { fieldName: 'donor.age', value },
          op: operator,
        });

        const result = validateEnforcement(narrow(sqon));

        assertRefusedFor(
          result,
          'sqon.content[1]',
          ENFORCEMENT_RULES.rangeBound,
        );
      });
    }

    for (const [description, value, operators] of [
      ['a * pattern', ['*'], ['in', '=', 'all']],
      [
        'a * pattern beside literal values',
        ['HEART_STUDY', 'LUNG*'],
        ['in', '=', 'all'],
      ],
      ['a saved-set reference', ['set_id:a1b2'], ['in', '=', 'all']],
      ['the missing-field marker', ['__missing__'], ['in', '=', 'all']],
      ['a single * pattern written without a list', '*', ['in', '=']],
    ] as const) {
      for (const operator of operators) {
        test(`refuses ${description} in an ${operator} clause, since a filter lists literal values`, () => {
          const sqon = nestedSecond({
            content: { fieldName: 'study_id', value },
            op: operator,
          });

          const result = validateEnforcement(narrow(sqon));

          assertRefusedFor(
            result,
            'sqon.content[1]',
            ENFORCEMENT_RULES.literalValues,
          );
        });
      }
    }

    test('refuses a special value in an in clause that is the whole filter', () => {
      const sqon = inClause('study_id', ['set_id:a1b2']);

      const result = validateEnforcement(narrow(sqon));

      assertRefusedFor(result, 'sqon', ENFORCEMENT_RULES.literalValues);
    });

    for (const operator of ['wildcard', 'filter']) {
      test(`refuses a wildcard pattern written ${operator}, since a filter matches values as listed`, () => {
        const sqon = nestedSecond({
          content: { fieldNames: ['study_id'], value: 'HEART' },
          op: operator,
        });

        const result = validateEnforcement(narrow(sqon));

        assertRefusedFor(result, 'sqon.content[1]', ENFORCEMENT_RULES.pattern);
      });
    }

    for (const [description, node, position] of [
      [
        'a clause carrying a null pivot',
        nestedSecond({
          ...inClause('data_category', ['controlled']),
          pivot: null,
        }),
        'sqon.content[1]',
      ],
      [
        'a clause carrying a pivot member set to undefined',
        nestedSecond({
          ...inClause('data_category', ['controlled']),
          pivot: undefined,
        }),
        'sqon.content[1]',
      ],
      [
        'a group carrying a pivot path',
        { ...groupedSqon, pivot: 'donors' },
        'sqon',
      ],
      [
        'a group carrying a null pivot',
        { ...groupedSqon, pivot: null },
        'sqon',
      ],
    ] as const) {
      test(`refuses ${description}`, () => {
        const result = validateEnforcement(narrow(node));

        assertRefusedFor(result, position, ENFORCEMENT_RULES.pivot);
      });
    }

    for (const [description, node, position, rule] of [
      [
        'a clause carrying a member other than op and content',
        nestedSecond({ ...inClause('study_id', ['A']), grants: ['all'] }),
        'sqon.content[1]',
        ENFORCEMENT_RULES.nodeMembers,
      ],
      [
        'a group carrying a member other than op and content',
        { ...groupedSqon, __unflat__: true },
        'sqon',
        ENFORCEMENT_RULES.nodeMembers,
      ],
      [
        'clause content carrying a member other than fieldName and value',
        nestedSecond({
          content: { fieldName: 'study_id', grants: ['all'], value: ['A'] },
          op: 'in',
        }),
        'sqon.content[1]',
        ENFORCEMENT_RULES.clauseMembers,
      ],
      [
        'clause content naming fieldNames beside fieldName',
        nestedSecond({
          content: { fieldName: 'study_id', fieldNames: ['x'], value: ['A'] },
          op: 'in',
        }),
        'sqon.content[1]',
        ENFORCEMENT_RULES.clauseMembers,
      ],
    ] as const) {
      test(`refuses ${description}, since a filter carries only what SQON defines for it`, () => {
        const result = validateEnforcement(narrow(node));

        assertRefusedFor(result, position, rule);
      });
    }

    for (const [description, sqon, position] of [
      [
        'a not that is the whole filter',
        { content: [inClause('study_id', ['HEART_STUDY'])], op: 'not' },
        'sqon',
      ],
      [
        'a not inside an or',
        {
          content: [
            inClause('study_id', ['HEART_STUDY']),
            { content: [inClause('study_id', ['HEART_STUDY'])], op: 'not' },
          ],
          op: 'or',
        },
        'sqon.content[1]',
      ],
      [
        'a not inside an and holding no in clause',
        {
          content: [
            { content: { fieldName: 'donor.age', value: 18 }, op: 'gte' },
            { content: [inClause('data_category', ['controlled'])], op: 'not' },
          ],
          op: 'and',
        },
        'sqon.content[1]',
      ],
      [
        'a not directly inside another not',
        nestedSecond({
          content: [
            { content: [inClause('data_category', ['controlled'])], op: 'not' },
          ],
          op: 'not',
        }),
        'sqon.content[1].content[0]',
      ],
    ] as const) {
      test(`refuses ${description}, since a not narrows only beside an in clause`, () => {
        const result = validateEnforcement(narrow(sqon));

        assertRefusedFor(result, position, ENFORCEMENT_RULES.notPlacement);
      });
    }

    test('accepts a not inside an and beside an in clause, as the unmarked clause is', () => {
      const sqon = nestedSecond({
        content: [inClause('data_category', ['controlled'])],
        op: 'not',
      });

      const result = validateEnforcement(narrow(sqon));

      assertAccepted(result);
    });
  });

  suite('the walk on its own', () => {
    for (const [description, sqon, position, rule] of [
      [
        'an entry that is null',
        nestedSecond(null),
        'sqon.content[1]',
        ENFORCEMENT_RULES.entryIsNode,
      ],
      [
        'an entry that is a string',
        nestedSecond('study_id'),
        'sqon.content[1]',
        ENFORCEMENT_RULES.entryIsNode,
      ],
      [
        'a hole in a group',
        {
          content: [inClause('study_id', ['A']), , inClause('study_id', ['B'])],
          op: 'or',
        },
        'sqon.content[1]',
        ENFORCEMENT_RULES.entryIsNode,
      ],
      [
        'combination content that is not a list',
        nestedSecond({
          content: { fieldName: 'study_id', value: ['A'] },
          op: 'and',
        }),
        'sqon.content[1]',
        ENFORCEMENT_RULES.combinationContentIsList,
      ],
      [
        'a clause using the key field',
        nestedSecond({
          content: { field: 'study_id', value: ['A'] },
          op: 'in',
        }),
        'sqon.content[1]',
        ENFORCEMENT_RULES.namesField,
      ],
      [
        'a clause whose content is not a map',
        nestedSecond({ content: 'study_id', op: 'in' }),
        'sqon.content[1]',
        ENFORCEMENT_RULES.namesField,
      ],
      [
        'an all with an empty value list',
        nestedSecond({
          content: { fieldName: 'study_id', value: [] },
          op: 'all',
        }),
        'sqon.content[1]',
        ENFORCEMENT_RULES.allNotEmpty,
      ],
      [
        'an operator SQON does not define',
        nestedSecond({
          content: { fieldName: 'study_id', value: ['A'] },
          op: 'matches',
        }),
        'sqon.content[1]',
        ENFORCEMENT_RULES.operator,
      ],
      [
        'a filter nested past the depth limit',
        nestedDeeperThan(200, inClause('study_id', ['A'])),
        `sqon${'.content[0]'.repeat(129)}`,
        ENFORCEMENT_RULES.depth,
      ],
    ] as const) {
      test(`refuses ${description} without relying on SqonSchema`, () => {
        const result = walkResult(sqon);

        assertRefusedFor(result, position, rule);
      });
    }

    test('accepts a narrowing grouped by category', () => {
      const result = walkResult(groupedSqon);

      assertAccepted(result);
    });
  });

  suite('a rendered record narrowing', () => {
    const missing = (fieldName: string): Record<string, unknown> =>
      inClause(fieldName, ['__missing__']);

    /** A condition holding a not beside no in, as an author may write one. */
    const recentAndShared = {
      content: [
        {
          content: { fieldName: 'collection_date', value: '2020-01-01' },
          op: 'gte',
        },
        { content: [inClause('data_category', ['open'])], op: 'not' },
      ],
      op: 'and',
    };

    const renderedWith = (...members: readonly unknown[]): unknown => ({
      content: [
        inClause('study_id', ['HEART_STUDY']),
        {
          content: [
            {
              content: [
                inClause('study_id', ['HEART_STUDY']),
                { content: members, op: 'or' },
              ],
              op: 'and',
            },
          ],
          op: 'not',
        },
      ],
      op: 'and',
    });

    test('accepts a rendered record narrowing, whose missing clauses and authored nots the walk alone refuses', () => {
      const sqon = renderedWith(
        recentAndShared,
        missing('collection_date'),
        missing('data_category'),
      );

      const results = [walkResult(sqon), validateEnforcement(narrow(sqon))];

      assert.deepEqual(
        results.map((result) => result.success),
        [false, true],
      );
    });

    test("refuses a filter that is not quite a rendered narrowing, reporting the walk's problems", () => {
      const sqon = renderedWith(
        recentAndShared,
        inClause('collection_date', ['__missing__', '2020-01-01']),
        missing('data_category'),
      );

      const result = validateEnforcement(narrow(sqon));

      assertRefusedFor(
        result,
        'sqon.content[1].content[0].content[1].content[1]',
        ENFORCEMENT_RULES.literalValues,
      );
      assert.deepEqual(
        result.success ? [] : result.problems,
        walkProblems(sqon),
      );
    });

    test('refuses a rendered narrowing whose authored condition lists the missing-field marker', () => {
      const sqon = renderedWith(
        inClause('data_category', ['open', '__missing__']),
        missing('data_category'),
      );

      const result = validateEnforcement(narrow(sqon));

      assertRefusedFor(
        result,
        'sqon.content[1].content[0].content[1].content[0]',
        ENFORCEMENT_RULES.literalValues,
      );
    });
  });

  suite('what it returns', () => {
    test('returns a copy, so a later change to the input reaches nothing returned', () => {
      const enforcement = {
        kind: 'narrow',
        sqon: structuredClone(groupedSqon),
      };

      const result = validateEnforcement(enforcement);
      enforcement.sqon.op = 'and';

      assert.deepEqual(result.success && result.enforcement, {
        kind: 'narrow',
        sqon: groupedSqon,
      });
    });

    test('returns no member a filter node inherits', () => {
      const inherited = Object.assign(Object.create(null), { pivot: 'donors' });
      const sqon = Object.assign(Object.create(inherited), groupedSqon);

      const result = validateEnforcement(narrow(sqon));
      const returned: unknown = result.success && result.enforcement;

      assertAccepted(result);
      assert.equal(
        'pivot' in Object(Reflect.get(Object(returned), 'sqon')),
        false,
      );
    });

    test('refuses a result holding a getter that throws, returning the refusal rather than throwing', () => {
      const enforcement = Object.defineProperty({ kind: 'narrow' }, 'sqon', {
        enumerable: true,
        get: (): never => {
          throw new Error('unreadable');
        },
      });

      const result = validateEnforcement(enforcement);

      assertRefusedFor(result, '(root)', READ_RULE);
    });
  });

  suite('what problems carry', () => {
    const MARKED_FIELD = `${LEAK_MARKER}_field`;

    /** The words fixed by the contract, carried unmarked by a leak input. */
    const CONTRACT_WORDS: ReadonlySet<string> = new Set([
      'all',
      'allow',
      'and',
      'content',
      'deny',
      'field',
      'fieldName',
      'fieldNames',
      'gt',
      'in',
      'kind',
      'narrow',
      'not',
      'not-in',
      'op',
      'or',
      'pivot',
      'reason',
      'sqon',
      'value',
      'wildcard',
    ]);

    const markedClause = (
      operator: string,
      value: unknown,
    ): Record<string, unknown> => ({
      content: { fieldName: MARKED_FIELD, value },
      op: operator,
    });

    /** A valid `and` holding a marked `in`, then `node` as its second entry. */
    const markedNested = (node: unknown): Record<string, unknown> => ({
      content: [markedClause('in', [`${LEAK_MARKER}_value`]), node],
      op: 'and',
    });

    const leakCases: readonly (LeakCase & { walkOnly?: true })[] = [
      {
        description: 'a result that is not a map',
        input: [`${LEAK_MARKER}_result`],
        position: '(root)',
        rule: ENFORCEMENT_RULES.isMap,
      },
      {
        description: 'an unknown kind',
        input: { kind: `${LEAK_MARKER}_kind` },
        position: 'kind',
        rule: ENFORCEMENT_RULES.kind,
      },
      {
        description: 'an unknown member on an allow',
        input: { kind: 'allow', [`${LEAK_MARKER}_member`]: LEAK_MARKER },
        position: '(root)',
        rule: ENFORCEMENT_RULES.armMembers,
      },
      {
        description: 'an unknown deny reason',
        input: { kind: 'deny', reason: `${LEAK_MARKER}_reason` },
        position: 'reason',
        rule: ENFORCEMENT_RULES.denyReason,
      },
      {
        description: 'a value list holding an object',
        input: narrow(
          markedClause('in', [{ [LEAK_MARKER]: `${LEAK_MARKER}_value` }]),
        ),
        position: 'sqon',
        rule: ENFORCEMENT_RULES.validSqon,
      },
      {
        description: 'an empty group',
        input: narrow(markedNested({ content: [], op: 'or' })),
        position: 'sqon.content[1]',
        rule: ENFORCEMENT_RULES.combinationNotEmpty,
      },
      {
        description: 'an exclusion',
        input: narrow(
          markedNested(markedClause('not-in', [`${LEAK_MARKER}_value`])),
        ),
        position: 'sqon.content[1]',
        rule: ENFORCEMENT_RULES.exclusion,
      },
      {
        description: 'an empty in',
        input: narrow(markedNested(markedClause('in', []))),
        position: 'sqon.content[1]',
        rule: ENFORCEMENT_RULES.inNotEmpty,
      },
      {
        description: 'a special value',
        input: narrow(markedNested(markedClause('in', [`${LEAK_MARKER}*`]))),
        position: 'sqon.content[1]',
        rule: ENFORCEMENT_RULES.literalValues,
      },
      {
        description: 'a wildcard pattern',
        input: narrow(
          markedNested({
            content: {
              fieldNames: [MARKED_FIELD],
              value: `${LEAK_MARKER}_pattern`,
            },
            op: 'wildcard',
          }),
        ),
        position: 'sqon.content[1]',
        rule: ENFORCEMENT_RULES.pattern,
      },
      {
        description: 'a range with no usable bound',
        input: narrow(markedNested(markedClause('gt', []))),
        position: 'sqon.content[1]',
        rule: ENFORCEMENT_RULES.rangeBound,
      },
      {
        description: 'a pivot path',
        input: narrow(
          markedNested({
            ...markedClause('in', [`${LEAK_MARKER}_value`]),
            pivot: `${LEAK_MARKER}_pivot`,
          }),
        ),
        position: 'sqon.content[1]',
        rule: ENFORCEMENT_RULES.pivot,
      },
      {
        description: 'an unknown member on a filter node',
        input: narrow(
          markedNested({
            ...markedClause('in', [`${LEAK_MARKER}_value`]),
            [`${LEAK_MARKER}_member`]: `${LEAK_MARKER}_passenger`,
          }),
        ),
        position: 'sqon.content[1]',
        rule: ENFORCEMENT_RULES.nodeMembers,
      },
      {
        description: 'an unknown member in clause content',
        input: narrow(
          markedNested({
            content: {
              fieldName: MARKED_FIELD,
              value: [`${LEAK_MARKER}_value`],
              [`${LEAK_MARKER}_member`]: `${LEAK_MARKER}_passenger`,
            },
            op: 'in',
          }),
        ),
        position: 'sqon.content[1]',
        rule: ENFORCEMENT_RULES.clauseMembers,
      },
      {
        description: 'a not that is the whole filter',
        input: narrow({
          content: [markedClause('in', [`${LEAK_MARKER}_value`])],
          op: 'not',
        }),
        position: 'sqon',
        rule: ENFORCEMENT_RULES.notPlacement,
      },
      {
        description: 'an empty all, reached by the walk alone',
        input: markedNested(markedClause('all', [])),
        position: 'sqon.content[1]',
        rule: ENFORCEMENT_RULES.allNotEmpty,
        walkOnly: true,
      },
      {
        description:
          'combination content that is not a list, reached by the walk alone',
        input: markedNested({
          content: { fieldName: MARKED_FIELD, value: [`${LEAK_MARKER}_value`] },
          op: 'and',
        }),
        position: 'sqon.content[1]',
        rule: ENFORCEMENT_RULES.combinationContentIsList,
        walkOnly: true,
      },
      {
        description: 'an entry that is not a node, reached by the walk alone',
        input: markedNested(`${LEAK_MARKER}_entry`),
        position: 'sqon.content[1]',
        rule: ENFORCEMENT_RULES.entryIsNode,
        walkOnly: true,
      },
      {
        description: 'an unknown operator, reached by the walk alone',
        input: markedNested(
          markedClause(`${LEAK_MARKER}_op`, [`${LEAK_MARKER}_value`]),
        ),
        position: 'sqon.content[1]',
        rule: ENFORCEMENT_RULES.operator,
        walkOnly: true,
      },
      {
        description: 'a clause using the key field, reached by the walk alone',
        input: markedNested({
          content: { field: MARKED_FIELD, value: [`${LEAK_MARKER}_value`] },
          op: 'in',
        }),
        position: 'sqon.content[1]',
        rule: ENFORCEMENT_RULES.namesField,
        walkOnly: true,
      },
      {
        description: 'nesting past the depth limit, reached by the walk alone',
        input: nestedDeeperThan(
          200,
          markedClause('in', [`${LEAK_MARKER}_value`, LEAK_NUMBER]),
        ),
        position: `sqon${'.content[0]'.repeat(129)}`,
        rule: ENFORCEMENT_RULES.depth,
        walkOnly: true,
      },
    ];

    for (const { description, input, position, rule, walkOnly } of leakCases) {
      test(`names no content of the input in the problems for ${description}`, () => {
        assertInputMarked(input, CONTRACT_WORDS);

        const result = walkOnly
          ? walkResult(input)
          : validateEnforcement(input);

        assertRefusedFor(result, position, rule);
        assertCarriesNoInput(result);
      });
    }

    test('names no content of an error thrown by a getter while the result is read', () => {
      const enforcement = Object.defineProperty({ kind: 'deny' }, 'reason', {
        enumerable: true,
        get: (): never => {
          throw new Error(`${LEAK_MARKER}_thrown`);
        },
      });

      const result = validateEnforcement(enforcement);

      assertRefusedFor(result, '(root)', READ_RULE);
      assertCarriesNoInput(result);
    });

    test('breaks every rule held by the validator, between the inputs above', () => {
      const cases = leakCases;

      assertEveryRuleBroken(cases, ENFORCEMENT_RULES);
    });
  });
});
