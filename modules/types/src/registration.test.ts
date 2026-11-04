import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
  type CategoryCondition,
  CONDITION_RULES,
} from './categoryCondition.js';
import { READ_RULE } from './problems.js';
import {
  type RecordKeyRegistration,
  REGISTRATION_RULES,
  validateRegistration,
} from './registration.js';
import {
  assertAccepted,
  assertCarriesNoInput,
  assertEveryRuleBroken,
  assertInputMarked,
  assertRefusedFor,
  LEAK_MARKER,
  type LeakCase,
  throughJson,
} from './testSupport.js';

const inClause = (
  fieldName: string,
  values: readonly string[],
): CategoryCondition => ({
  content: { fieldName, value: [...values] },
  op: 'in',
});

const recordRegistration = (): RecordKeyRegistration => ({
  categories: {
    global: {
      'global.community-governed': inClause('data_category', [
        'community-governed',
      ]),
      'global.controlled': inClause('data_category', ['controlled']),
    },
  },
  kind: 'record',
  resourceFieldName: 'study_id',
});

const withMembers = (members: Record<string, unknown>): unknown => ({
  ...recordRegistration(),
  ...members,
});

const withCategories = (categories: unknown): unknown =>
  withMembers({ categories });

/** A record key whose `categories.resource` is `resource`, beside the global categories. */
const withResourceCategories = (
  resource: unknown,
  members: Record<string, unknown> = {},
): unknown =>
  withMembers({
    categories: { ...recordRegistration().categories, resource },
    ...members,
  });

suite('validateRegistration', () => {
  suite('a record key', () => {
    test('accepts a record key defining its global categories as conditions, and returns it unchanged', () => {
      const registration = recordRegistration();

      const result = validateRegistration(registration);

      assert.deepEqual(result, { registration, success: true });
    });

    test('accepts a record key defining no category, whose global map is empty', () => {
      const registration = withCategories({ global: {} });

      const result = validateRegistration(registration);

      assertAccepted(result);
    });

    test('accepts two categories defined by the same condition, since a record carries every category it matches', () => {
      const registration = withCategories({
        global: {
          'global.community-governed': inClause('data_category', [
            'restricted',
          ]),
          'global.controlled': inClause('data_category', ['restricted']),
        },
      });

      const result = validateRegistration(registration);

      assertAccepted(result);
    });

    test('accepts categories whose conditions overlap and read several fields', () => {
      const registration = withCategories({
        global: {
          'global.controlled': {
            content: [
              inClause('data_category', ['controlled', 'restricted']),
              {
                content: [inClause('consent_codes', ['GRU'])],
                op: 'not',
              },
            ],
            op: 'or',
          },
          'global.embargoed': {
            content: [
              {
                content: { fieldName: 'release_date', value: '2027-01-01' },
                op: 'gte',
              },
              {
                content: { fieldName: 'donor_age', value: [0, 17] },
                op: 'between',
              },
            ],
            op: 'or',
          },
        },
      });

      const result = validateRegistration(registration);

      assertAccepted(result);
    });

    test('accepts resource categories under their resource, with the resource listed', () => {
      const registration = withResourceCategories(
        {
          HEART_STUDY: {
            'resource.pilot': inClause('cohort', ['pilot']),
            'resource.withdrawn': inClause('consent_status', ['withdrawn']),
          },
        },
        { resources: ['HEART_STUDY', 'LUNG_COHORT'] },
      );

      const result = validateRegistration(registration);

      assertAccepted(result);
    });

    test('accepts resource categories when no resource list is given', () => {
      const registration = withResourceCategories({
        HEART_STUDY: { 'resource.pilot': inClause('cohort', ['pilot']) },
      });

      const result = validateRegistration(registration);

      assertAccepted(result);
    });

    test('accepts a resource whose own categories are an empty map, which defines none', () => {
      const registration = withResourceCategories({ HEART_STUDY: {} });

      const result = validateRegistration(registration);

      assertAccepted(result);
    });

    test('accepts an empty map of resource categories', () => {
      const registration = withResourceCategories({});

      const result = validateRegistration(registration);

      assertAccepted(result);
    });

    test('accepts global categories declared absent beside the ones defined', () => {
      const registration = withMembers({
        absentCategories: ['global.embargoed', 'global.indigenous-governed'],
      });

      const result = validateRegistration(registration);

      assertAccepted(result);
    });

    test('accepts global categories declared absent on a key defining none', () => {
      const registration = withMembers({
        absentCategories: ['global.controlled'],
        categories: { global: {} },
      });

      const result = validateRegistration(registration);

      assertAccepted(result);
    });

    test('accepts a record key with a resource list', () => {
      const registration = withMembers({
        resources: ['HEART_STUDY', 'LUNG_COHORT'],
      });

      const result = validateRegistration(registration);

      assertAccepted(result);
    });

    test('accepts a record key registering an empty resource list, which then denies rather than stopping startup', () => {
      const registration = withMembers({ resources: [] });

      const result = validateRegistration(registration);

      assertAccepted(result);
    });

    test('refuses a member a record key does not define', () => {
      const result = validateRegistration(
        withMembers({ provenanceFieldName: 'provenance' }),
      );

      assertRefusedFor(result, '(root)', REGISTRATION_RULES.members);
    });

    for (const members of [
      { categoryFieldName: 'data_category' },
      { categoryValues: { 'global.controlled': 'controlled' } },
    ]) {
      test(`refuses ${Object.keys(members).join()}, which categories replace`, () => {
        const result = validateRegistration(withMembers(members));

        assertRefusedFor(result, '(root)', REGISTRATION_RULES.members);
      });
    }

    for (const [member, input, rule] of [
      ['resources', withMembers({ resources: undefined }), 'resources'],
      [
        'absentCategories',
        withMembers({ absentCategories: undefined }),
        'absentCategories',
      ],
      [
        'categories.resource',
        withResourceCategories(undefined),
        'resourceIsMap',
      ],
    ] as const) {
      test(`refuses ${member} given as undefined`, () => {
        const result = validateRegistration(input);

        assertRefusedFor(result, member, REGISTRATION_RULES[rule]);
      });
    }

    for (const resourceFieldName of [
      '',
      undefined,
      ['study_id'],
      { toString: 42 },
    ]) {
      test(`refuses a resource field name of ${JSON.stringify(resourceFieldName)}`, () => {
        const result = validateRegistration(withMembers({ resourceFieldName }));

        assertRefusedFor(
          result,
          'resourceFieldName',
          REGISTRATION_RULES.resourceFieldName,
        );
      });
    }

    for (const [description, categories] of [
      ['missing', undefined],
      ['null', null],
      ['a list', [{ global: {} }]],
      ['a string', 'data_category'],
    ] as const) {
      test(`refuses categories that are ${description}`, () => {
        const result = validateRegistration(withCategories(categories));

        assertRefusedFor(
          result,
          'categories',
          REGISTRATION_RULES.categoriesIsMap,
        );
      });
    }

    test('refuses categories carrying a member other than global and resource', () => {
      const result = validateRegistration(
        withCategories({ field: {}, global: {} }),
      );

      assertRefusedFor(
        result,
        'categories',
        REGISTRATION_RULES.categoriesMembers,
      );
    });

    for (const [description, categories] of [
      ['missing', {}],
      ['missing beside resource categories', { resource: { HEART_STUDY: {} } }],
      ['a list', { global: [inClause('data_category', ['controlled'])] }],
      ['null', { global: null }],
    ] as const) {
      test(`refuses a global map that is ${description}`, () => {
        const result = validateRegistration(withCategories(categories));

        assertRefusedFor(
          result,
          'categories.global',
          REGISTRATION_RULES.globalIsMap,
        );
      });
    }

    for (const [category, position] of [
      ['controlled', 'categories.global.controlled'],
      ['resource.pilot', 'categories.global["resource.pilot"]'],
      ['global.', 'categories.global["global."]'],
      ['global.data.controlled', 'categories.global["global.data.controlled"]'],
      ['global.unmarked', 'categories.global["global.unmarked"]'],
    ] as const) {
      test(`refuses defining ${category} in the global map, which is no concrete global category name`, () => {
        const result = validateRegistration(
          withCategories({
            global: { [category]: inClause('data_category', ['controlled']) },
          }),
        );

        assertRefusedFor(result, position, REGISTRATION_RULES.globalCategory);
      });
    }

    test('refuses a global category named __proto__, as JSON can carry it', () => {
      const registration = throughJson(
        withCategories({
          global: {
            ['__proto__']: inClause('data_category', ['controlled']),
          },
        }),
      );

      const result = validateRegistration(registration);

      assertRefusedFor(
        result,
        'categories.global.__proto__',
        REGISTRATION_RULES.globalCategory,
      );
    });

    for (const [description, condition, position, rule] of [
      [
        'a value in place of a condition, as category values were written',
        'controlled',
        'categories.global["global.controlled"]',
        CONDITION_RULES.validSqon,
      ],
      [
        'an exclusion',
        {
          content: { fieldName: 'data_category', value: ['open'] },
          op: 'not-in',
        },
        'categories.global["global.controlled"]',
        CONDITION_RULES.exclusion,
      ],
      [
        'an empty group nested in an and',
        {
          content: [
            inClause('data_category', ['controlled']),
            { content: [], op: 'or' },
          ],
          op: 'and',
        },
        'categories.global["global.controlled"].content[1]',
        CONDITION_RULES.groupNotEmpty,
      ],
    ] as const) {
      test(`refuses a global category defined by ${description}, positioned under the category`, () => {
        const result = validateRegistration(
          withCategories({ global: { 'global.controlled': condition } }),
        );

        assertRefusedFor(result, position, rule);
      });
    }

    for (const [description, resource] of [
      ['a list', [{ HEART_STUDY: {} }]],
      ['null', null],
    ] as const) {
      test(`refuses resource categories that are ${description}`, () => {
        const result = validateRegistration(withResourceCategories(resource));

        assertRefusedFor(
          result,
          'categories.resource',
          REGISTRATION_RULES.resourceIsMap,
        );
      });
    }

    for (const [resource, position] of [
      ['', 'categories.resource[""]'],
      ['HEART*', 'categories.resource["HEART*"]'],
      ['set_id:HEART', 'categories.resource["set_id:HEART"]'],
      ['__missing__', 'categories.resource.__missing__'],
    ] as const) {
      test(`refuses resource categories under ${JSON.stringify(resource)}, which is no usable resource identifier`, () => {
        const result = validateRegistration(
          withResourceCategories({
            [resource]: { 'resource.pilot': inClause('cohort', ['pilot']) },
          }),
        );

        assertRefusedFor(
          result,
          position,
          REGISTRATION_RULES.resourceIdentifier,
        );
      });
    }

    test('refuses resource categories under __proto__, as JSON can carry it', () => {
      const registration = throughJson(
        withResourceCategories({
          ['__proto__']: { 'resource.pilot': inClause('cohort', ['pilot']) },
        }),
      );

      const result = validateRegistration(registration);

      assertRefusedFor(
        result,
        'categories.resource.__proto__',
        REGISTRATION_RULES.resourceIdentifier,
      );
    });

    test("refuses a resource's own categories that are not a map", () => {
      const result = validateRegistration(
        withResourceCategories({
          HEART_STUDY: [inClause('cohort', ['pilot'])],
        }),
      );

      assertRefusedFor(
        result,
        'categories.resource.HEART_STUDY',
        REGISTRATION_RULES.resourceEntryIsMap,
      );
    });

    for (const [description, registration, position] of [
      [
        'a global category testing the resource field',
        withCategories({
          global: {
            'global.controlled': inClause('study_id', ['HEART_STUDY']),
          },
        }),
        'categories.global["global.controlled"]',
      ],
      [
        'a global category reading the resource field deep inside a not',
        withCategories({
          global: {
            'global.controlled': {
              content: [
                {
                  content: [
                    inClause('data_category', ['controlled']),
                    {
                      content: [inClause('study_id', ['HEART_STUDY'])],
                      op: 'not',
                    },
                  ],
                  op: 'and',
                },
              ],
              op: 'not',
            },
          },
        }),
        'categories.global["global.controlled"]',
      ],
      [
        "a resource's own category testing the resource field",
        withResourceCategories({
          HEART_STUDY: {
            'resource.pilot': inClause('study_id', ['HEART_STUDY']),
          },
        }),
        'categories.resource.HEART_STUDY["resource.pilot"]',
      ],
    ] as const) {
      test(`refuses ${description}, since a record belongs to its resource by that field alone`, () => {
        assertRefusedFor(
          validateRegistration(registration),
          position,
          REGISTRATION_RULES.resourceFieldUnread,
        );
      });
    }

    test('refuses a condition written directly under its resource, with no category name', () => {
      const result = validateRegistration(
        withResourceCategories({ HEART_STUDY: inClause('cohort', ['pilot']) }),
      );

      assertRefusedFor(
        result,
        'categories.resource.HEART_STUDY.op',
        REGISTRATION_RULES.resourceCategory,
      );
    });

    for (const [category, position] of [
      [
        'global.controlled',
        'categories.resource.HEART_STUDY["global.controlled"]',
      ],
      ['pilot', 'categories.resource.HEART_STUDY.pilot'],
      ['resource.', 'categories.resource.HEART_STUDY["resource."]'],
      [
        'resource.unmarked',
        'categories.resource.HEART_STUDY["resource.unmarked"]',
      ],
    ] as const) {
      test(`refuses defining ${category} under a resource, which is no resource category name`, () => {
        const result = validateRegistration(
          withResourceCategories({
            HEART_STUDY: { [category]: inClause('cohort', ['pilot']) },
          }),
        );

        assertRefusedFor(result, position, REGISTRATION_RULES.resourceCategory);
      });
    }

    for (const [description, condition, position, rule] of [
      [
        'an all',
        {
          content: { fieldName: 'consent_codes', value: ['GRU', 'NPU'] },
          op: 'all',
        },
        'categories.resource.HEART_STUDY["resource.pilot"]',
        CONDITION_RULES.all,
      ],
      [
        'a not holding a marker value',
        { content: [inClause('cohort', ['set_id:a1b2'])], op: 'not' },
        'categories.resource.HEART_STUDY["resource.pilot"].content[0]',
        CONDITION_RULES.literalValues,
      ],
    ] as const) {
      test(`refuses a resource category defined by ${description}, positioned under the resource and the category`, () => {
        const result = validateRegistration(
          withResourceCategories({
            HEART_STUDY: { 'resource.pilot': condition },
          }),
        );

        assertRefusedFor(result, position, rule);
      });
    }

    for (const resources of [['LUNG_COHORT'], []]) {
      test(`refuses resource categories for a resource missing from a resource list of ${JSON.stringify(resources)}`, () => {
        const result = validateRegistration(
          withResourceCategories(
            {
              HEART_STUDY: { 'resource.pilot': inClause('cohort', ['pilot']) },
            },
            { resources },
          ),
        );

        assertRefusedFor(
          result,
          'categories.resource.HEART_STUDY',
          REGISTRATION_RULES.resourceListed,
        );
      });
    }

    for (const [description, absentCategories] of [
      ['a single name rather than a list', 'global.embargoed'],
      ['a name outside the category form', ['embargoed']],
      ['a repeated name', ['global.embargoed', 'global.embargoed']],
      ['the unmarked category', ['global.unmarked']],
      ['a resource category', ['resource.pilot']],
    ] as const) {
      test(`refuses absent categories holding ${description}`, () => {
        const result = validateRegistration(withMembers({ absentCategories }));

        assertRefusedFor(
          result,
          'absentCategories',
          REGISTRATION_RULES.absentCategories,
        );
      });
    }

    test('refuses a category both declared absent and defined', () => {
      const result = validateRegistration(
        withMembers({ absentCategories: ['global.controlled'] }),
      );

      assertRefusedFor(
        result,
        'absentCategories',
        REGISTRATION_RULES.absentNotDefined,
      );
    });

    test('refuses a resource list that repeats a resource or holds an unusable identifier', () => {
      for (const resources of [
        ['HEART_STUDY', 'HEART_STUDY'],
        ['HEART_STUDY', ''],
        ['__proto__'],
        'HEART_STUDY',
      ]) {
        const result = validateRegistration(withMembers({ resources }));

        assertRefusedFor(result, 'resources', REGISTRATION_RULES.resources);
      }
    });

    test('refuses a resource that Arranger would read as an instruction in a filter', () => {
      for (const resources of [['HEART*'], ['set_id:HEART'], ['__missing__']]) {
        const result = validateRegistration(withMembers({ resources }));

        assertRefusedFor(result, 'resources', REGISTRATION_RULES.resources);
      }
    });
  });

  suite('an artifact key', () => {
    for (const [description, registration] of [
      ['alone', { kind: 'artifact' }],
      [
        'naming a field and a resource list',
        {
          kind: 'artifact',
          provenanceFieldName: 'provenance',
          resources: ['HEART_STUDY'],
        },
      ],
      [
        "carrying a record key's members as well",
        { ...recordRegistration(), kind: 'artifact' },
      ],
    ] as const) {
      test(`refuses an artifact key ${description} at its kind, with the artifact rule as its only problem`, () => {
        const result = validateRegistration(registration);

        assert.deepEqual(result, {
          problems: [
            { position: 'kind', rule: REGISTRATION_RULES.artifactKind },
          ],
          success: false,
        });
      });
    }
  });

  suite('a key open by configuration', () => {
    test('accepts a key open by configuration', () => {
      const registration = { kind: 'open' };

      const result = validateRegistration(registration);

      assert.deepEqual(result, { registration, success: true });
    });

    test('refuses a member beside kind on a key open by configuration', () => {
      const result = validateRegistration({
        kind: 'open',
        resourceFieldName: 'study_id',
      });

      assertRefusedFor(result, '(root)', REGISTRATION_RULES.members);
    });
  });

  suite('every kind', () => {
    for (const value of ['a key', null, [{ kind: 'open' }]]) {
      test(`refuses ${JSON.stringify(value)}, which is not a map, returning the refusal rather than throwing`, () => {
        const result = validateRegistration(value);

        assertRefusedFor(result, '(root)', REGISTRATION_RULES.isMap);
      });
    }

    for (const kind of ['archive', 'constructor', undefined]) {
      test(`refuses a kind of ${JSON.stringify(kind)}, which it does not know`, () => {
        const result = validateRegistration(withMembers({ kind }));

        assertRefusedFor(result, 'kind', REGISTRATION_RULES.kind);
      });
    }

    test('refuses a registration holding a getter that throws, returning the refusal rather than throwing', () => {
      const registration = Object.defineProperty(
        { kind: 'record', resourceFieldName: 'study_id' },
        'categories',
        {
          enumerable: true,
          get: (): never => {
            throw new Error('unreadable');
          },
        },
      );

      const result = validateRegistration(registration);

      assertRefusedFor(result, '(root)', READ_RULE);
    });

    test('returns a copy, so a later change to a condition in the input reaches nothing returned', () => {
      const condition = {
        content: { fieldName: 'data_category', value: ['controlled'] },
        op: 'in',
      };
      const registration = withCategories({
        global: { 'global.controlled': condition },
      });

      const result = validateRegistration(registration);
      condition.op = 'not-in';

      assert.deepEqual(result.success && result.registration, {
        categories: {
          global: {
            'global.controlled': inClause('data_category', ['controlled']),
          },
        },
        kind: 'record',
        resourceFieldName: 'study_id',
      });
    });
  });

  suite('the keys a problem names', () => {
    test('names the global category whose condition breaks the grammar, among several defined', () => {
      const registration = withCategories({
        global: {
          'global.community-governed': inClause('data_category', [
            'community-governed',
          ]),
          'global.controlled': {
            content: [
              inClause('data_category', ['controlled']),
              { content: [], op: 'or' },
            ],
            op: 'and',
          },
        },
      });

      const result = validateRegistration(registration);

      assert.deepEqual(result.success ? [] : result.problems, [
        {
          position: 'categories.global["global.controlled"].content[1]',
          rule: CONDITION_RULES.groupNotEmpty,
        },
      ]);
    });

    test('names the resource and the category whose condition breaks the grammar, among resources defining the same categories', () => {
      const registration = withResourceCategories({
        HEART_STUDY: {
          'resource.consented': inClause('consent_status', ['consented']),
          'resource.pilot': inClause('cohort', ['pilot']),
        },
        LUNG_COHORT: {
          'resource.consented': {
            content: [inClause('consent_status', ['set_id:a1b2'])],
            op: 'not',
          },
          'resource.pilot': inClause('cohort', ['pilot']),
        },
      });

      const result = validateRegistration(registration);

      assert.deepEqual(result.success ? [] : result.problems, [
        {
          position:
            'categories.resource.LUNG_COHORT["resource.consented"].content[0]',
          rule: CONDITION_RULES.literalValues,
        },
      ]);
    });

    test('escapes a quote and a newline in a key it names, so the position stays on one line and names no other key', () => {
      const registration = withCategories({
        global: {
          'global.controlled"]\nforged': {
            content: { fieldName: 'data_category', value: ['open'] },
            op: 'not-in',
          },
        },
      });

      const result = validateRegistration(registration);
      const positions = result.success
        ? []
        : result.problems.map(({ position }) => position);

      assert.deepEqual(positions, [
        'categories.global["global.controlled\\"]\\nforged"]',
      ]);
      assert.equal(
        positions.some((position) => /[\n\r]/u.test(position)),
        false,
      );
    });

    for (const [description, character, position] of [
      ['DEL', '\u007f', 'categories.global["global.before\\u007fafter"]'],
      [
        'the C1 control NEL',
        '\u0085',
        'categories.global["global.before\\u0085after"]',
      ],
      [
        'the last C1 control U+009F',
        '\u009f',
        'categories.global["global.before\\u009fafter"]',
      ],
      [
        'the line separator U+2028',
        '\u2028',
        'categories.global["global.before\\u2028after"]',
      ],
      [
        'the paragraph separator U+2029',
        '\u2029',
        'categories.global["global.before\\u2029after"]',
      ],
    ] as const) {
      test(`escapes ${description} in a key it names, so it cannot break a line in a log`, () => {
        const registration = withCategories({
          global: {
            [`global.before${character}after`]: {
              content: { fieldName: 'data_category', value: ['open'] },
              op: 'not-in',
            },
          },
        });

        const result = validateRegistration(registration);
        const positions = result.success
          ? []
          : result.problems.map((problem) => problem.position);

        assert.deepEqual(positions, [position]);
        assert.equal(
          positions.some((rendered) => rendered.includes(character)),
          false,
        );
      });
    }
  });

  suite('what problems carry', () => {
    const MARKED_FIELD = `${LEAK_MARKER}_field`;
    const MARKED_GLOBAL = `global.${LEAK_MARKER}`;
    const MARKED_RESOURCE = `${LEAK_MARKER}_resource`;
    const MARKED_RESOURCE_FIELD = `${LEAK_MARKER}_resourceField`;

    /** The words fixed by the contract, carried unmarked by a leak input. */
    const CONTRACT_WORDS: ReadonlySet<string> = new Set([
      'absentCategories',
      'artifact',
      'categories',
      'content',
      'fieldName',
      'global',
      'in',
      'kind',
      'not-in',
      'op',
      'open',
      'record',
      'resource',
      'resourceFieldName',
      'resources',
      'value',
    ]);

    /**
     * The category names and resource identifiers a leak input may carry unmarked, as keys only: a
     * problem found under such a key names it, since it comes from configuration.
     */
    const CONFIGURED_KEYS: ReadonlySet<string> = new Set([
      'global.controlled',
      'HEART*',
      'HEART_STUDY',
      'resource.pilot',
    ]);

    const markedCondition = (value: string): Record<string, unknown> => ({
      content: { fieldName: MARKED_FIELD, value: [value] },
      op: 'in',
    });

    const markedRecord = (members: Record<string, unknown>): unknown => ({
      categories: {
        global: { [MARKED_GLOBAL]: markedCondition(`${LEAK_MARKER}_value`) },
      },
      kind: 'record',
      resourceFieldName: MARKED_RESOURCE_FIELD,
      ...members,
    });

    const markedResourceCategories = (resource: unknown): unknown =>
      markedRecord({
        categories: {
          global: { [MARKED_GLOBAL]: markedCondition(`${LEAK_MARKER}_value`) },
          resource,
        },
      });

    const leakCases: readonly LeakCase[] = [
      {
        description: 'a condition reading the resource field',
        input: markedRecord({
          categories: {
            global: {
              'global.controlled': markedCondition(`${LEAK_MARKER}_value`),
            },
          },
          resourceFieldName: MARKED_FIELD,
        }),
        position: 'categories.global["global.controlled"]',
        rule: REGISTRATION_RULES.resourceFieldUnread,
      },
      {
        description: 'absent categories outside the category form',
        input: markedRecord({ absentCategories: [`${LEAK_MARKER}_absent`] }),
        position: 'absentCategories',
        rule: REGISTRATION_RULES.absentCategories,
      },
      {
        description: 'a category both declared absent and defined',
        input: markedRecord({ absentCategories: [MARKED_GLOBAL] }),
        position: 'absentCategories',
        rule: REGISTRATION_RULES.absentNotDefined,
      },
      {
        description: 'an artifact key',
        input: {
          kind: 'artifact',
          resources: [`${LEAK_MARKER}*`, `${LEAK_MARKER}*`],
          [`${LEAK_MARKER}_member`]: `${LEAK_MARKER}_field`,
        },
        position: 'kind',
        rule: REGISTRATION_RULES.artifactKind,
      },
      {
        description: 'categories that are not a map',
        input: markedRecord({ categories: [`${LEAK_MARKER}_categories`] }),
        position: 'categories',
        rule: REGISTRATION_RULES.categoriesIsMap,
      },
      {
        description: 'an unknown member of categories',
        input: markedRecord({
          categories: {
            global: {},
            [`${LEAK_MARKER}_member`]: `${LEAK_MARKER}_passenger`,
          },
        }),
        position: 'categories',
        rule: REGISTRATION_RULES.categoriesMembers,
      },
      {
        description: 'a global category outside the global form',
        input: markedRecord({
          categories: {
            global: {
              'resource.pilot': markedCondition(`${LEAK_MARKER}_value`),
            },
          },
        }),
        position: 'categories.global["resource.pilot"]',
        rule: REGISTRATION_RULES.globalCategory,
      },
      {
        description: 'a global map that is not a map',
        input: markedRecord({
          categories: { global: [`${LEAK_MARKER}_global`] },
        }),
        position: 'categories.global',
        rule: REGISTRATION_RULES.globalIsMap,
      },
      {
        description: 'a global condition holding an exclusion',
        input: markedRecord({
          categories: {
            global: {
              'global.controlled': {
                content: {
                  fieldName: MARKED_FIELD,
                  value: [`${LEAK_MARKER}_value`],
                },
                op: 'not-in',
              },
            },
          },
        }),
        position: 'categories.global["global.controlled"]',
        rule: CONDITION_RULES.exclusion,
      },
      {
        description: 'a registration that is not a map',
        input: [`${LEAK_MARKER}_registration`],
        position: '(root)',
        rule: REGISTRATION_RULES.isMap,
      },
      {
        description: 'an unknown kind',
        input: { kind: `${LEAK_MARKER}_kind` },
        position: 'kind',
        rule: REGISTRATION_RULES.kind,
      },
      {
        description: 'an unknown member of a record key',
        input: markedRecord({
          [`${LEAK_MARKER}_member`]: `${LEAK_MARKER}_passenger`,
        }),
        position: '(root)',
        rule: REGISTRATION_RULES.members,
      },
      {
        description: 'a resource category outside the resource form',
        input: markedResourceCategories({
          HEART_STUDY: {
            'global.controlled': markedCondition(`${LEAK_MARKER}_value`),
          },
        }),
        position: 'categories.resource.HEART_STUDY["global.controlled"]',
        rule: REGISTRATION_RULES.resourceCategory,
      },
      {
        description: "a resource's own categories that are not a map",
        input: markedResourceCategories({
          HEART_STUDY: [`${LEAK_MARKER}_categories`],
        }),
        position: 'categories.resource.HEART_STUDY',
        rule: REGISTRATION_RULES.resourceEntryIsMap,
      },
      {
        description: 'a resource field name that is not a string',
        input: markedRecord({
          categories: {
            global: {
              'global.controlled': markedCondition(`${LEAK_MARKER}_value`),
            },
          },
          resourceFieldName: [MARKED_FIELD],
        }),
        position: 'resourceFieldName',
        rule: REGISTRATION_RULES.resourceFieldName,
      },
      {
        description: 'resource categories under a resource holding a marker',
        input: markedResourceCategories({
          'HEART*': {
            'resource.pilot': markedCondition(`${LEAK_MARKER}_value`),
          },
        }),
        position: 'categories.resource["HEART*"]',
        rule: REGISTRATION_RULES.resourceIdentifier,
      },
      {
        description: 'resource categories that are not a map',
        input: markedResourceCategories([`${LEAK_MARKER}_resource`]),
        position: 'categories.resource',
        rule: REGISTRATION_RULES.resourceIsMap,
      },
      {
        description: 'resource categories for a resource left out of the list',
        input: markedRecord({
          categories: {
            global: {},
            resource: {
              HEART_STUDY: {
                'resource.pilot': markedCondition(`${LEAK_MARKER}_value`),
              },
            },
          },
          resources: [`${LEAK_MARKER}_other`],
        }),
        position: 'categories.resource.HEART_STUDY',
        rule: REGISTRATION_RULES.resourceListed,
      },
      {
        description: 'a resource list repeating a resource',
        input: markedRecord({ resources: [MARKED_RESOURCE, MARKED_RESOURCE] }),
        position: 'resources',
        rule: REGISTRATION_RULES.resources,
      },
    ];

    for (const { description, input, position, rule } of leakCases) {
      test(`names only category and resource keys from the input in the problems for ${description}`, () => {
        assertInputMarked(input, CONTRACT_WORDS, CONFIGURED_KEYS);

        const result = validateRegistration(input);

        assertRefusedFor(result, position, rule);
        assertCarriesNoInput(result);
      });
    }

    test('names no field name or value in a registration breaking many rules at once', () => {
      const input = markedRecord({
        absentCategories: [MARKED_GLOBAL, MARKED_GLOBAL],
        categories: {
          global: {
            'global.controlled': markedCondition(`${LEAK_MARKER}*`),
            [MARKED_GLOBAL]: markedCondition(`${LEAK_MARKER}_value`),
            'resource.pilot': `${LEAK_MARKER}_value`,
          },
          resource: {
            'HEART*': {
              'resource.pilot': markedCondition(`set_id:${LEAK_MARKER}`),
            },
          },
        },
        resourceFieldName: '',
        resources: [MARKED_RESOURCE, MARKED_RESOURCE],
      });

      const result = validateRegistration(input);

      assert.equal(result.success, false);
      assertCarriesNoInput(result);
    });

    test('breaks every rule held by the validator, between the inputs above', () => {
      const cases = leakCases;

      assertEveryRuleBroken(cases, REGISTRATION_RULES);
    });
  });
});
