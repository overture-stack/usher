import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
  checkSqonDepth,
  SQON_MAX_DEPTH,
  type SqonNode,
  SqonSchema,
} from '@overture-stack/sqon';

import {
  CONDITION_RULES,
  RENDERED_WRAPPING_NODES,
  validateCategoryCondition,
} from './categoryCondition.js';
import { validateEnforcement } from './enforcement.js';
import { validatePayload } from './payload.js';
import { deepFreeze, listEntries } from './plainData.js';
import { READ_RULE } from './problems.js';
import {
  canonicalRecordNarrowing,
  type HeldResource,
  RECORD_NARROWING_RULES,
  type RecordNarrowingDescription,
} from './recordNarrowing.js';
import {
  type ParsedRecordNarrowing,
  parseRecordNarrowing,
} from './renderedNarrowing.js';
import { type EvaluatedRecord, matchesSqon } from './sqonEvaluator.js';
import {
  assertAccepted,
  assertCarriesNoInput,
  assertEveryRuleBroken,
  assertInputMarked,
  assertRefusedFor,
  bypassTypes,
  contractErrorFrom,
  LEAK_MARKER,
  LEAK_NUMBER,
} from './testSupport.js';

const RESOURCE_FIELD = 'study_id';
const HEART = 'HEART_STUDY';
const LUNG = 'LUNG_COHORT';
const REEF = 'REEF_ARCHIVE';
const VOID = 'VOID_INDEX';

type Node = Record<string, unknown>;

const inClause = (fieldName: string, value: readonly unknown[]): Node => ({
  content: { fieldName, value },
  op: 'in',
});

const atLeast = (fieldName: string, value: unknown): Node => ({
  content: { fieldName, value },
  op: 'gte',
});

const combination = (op: string, ...content: readonly unknown[]): Node => ({
  content,
  op,
});

const not = (child: unknown): Node => combination('not', child);
const and = (...members: readonly unknown[]): Node =>
  combination('and', ...members);
const or = (...members: readonly unknown[]): Node =>
  combination('or', ...members);
const missing = (fieldName: string): Node =>
  inClause(fieldName, ['__missing__']);
const onResourceField = (...resources: readonly string[]): Node =>
  inClause(RESOURCE_FIELD, resources);

const CONTROLLED = inClause('data_category', ['controlled']);
const ADULT = atLeast('donor_age', 18);
const PILOT = inClause('cohort', ['pilot']);
const LATE_PILOT = and(inClause('cohort', ['late']), atLeast('donor_age', 65));

const held = (
  resource: string,
  heldCategories: readonly string[],
  unmarkedHeld: boolean,
  resourceCategories: Readonly<Record<string, unknown>> = {},
): HeldResource =>
  bypassTypes<HeldResource>({
    heldCategories,
    resource,
    resourceCategories,
    unmarkedHeld,
  });

const describedAs = (
  globalCategories: Readonly<Record<string, unknown>>,
  heldResources: readonly HeldResource[],
  knownResources: readonly string[],
): RecordNarrowingDescription =>
  bypassTypes<RecordNarrowingDescription>({
    globalCategories,
    heldResources,
    knownResources,
    resourceFieldName: RESOURCE_FIELD,
  });

/** Two globals, a resource category, a resource lacking unmarked, and a known resource not held. */
const fullDescription = describedAs(
  { 'global.adult': ADULT, 'global.controlled': CONTROLLED },
  [
    held(HEART, ['global.controlled'], false, { 'resource.pilot': PILOT }),
    held(LUNG, ['global.adult', 'global.controlled'], true),
  ],
  [HEART, LUNG, REEF],
);

const fullRendering = and(
  onResourceField(HEART, LUNG),
  not(onResourceField(REEF)),
  not(and(onResourceField(HEART), or(ADULT, missing('donor_age')))),
  not(and(onResourceField(HEART), or(PILOT, missing('cohort')))),
  not(
    and(
      onResourceField(HEART),
      not(
        or(
          ADULT,
          CONTROLLED,
          missing('data_category'),
          missing('donor_age'),
          and(or(not(onResourceField(HEART)), PILOT, missing('cohort'))),
        ),
      ),
    ),
  ),
);

/** Every held resource holds every category it can carry and its unmarked records, and is all that is known. */
const everythingHeld = describedAs(
  { 'global.controlled': CONTROLLED },
  [
    held(HEART, ['global.controlled', 'resource.pilot'], true, {
      'resource.pilot': PILOT,
    }),
  ],
  [HEART],
);

/** Two resources defining the same resource category name with different conditions, holding neither, lacking unmarked. */
const sharedResourceCategory = describedAs(
  { 'global.controlled': CONTROLLED },
  [
    held(LUNG, ['global.controlled'], false, { 'resource.pilot': LATE_PILOT }),
    held(HEART, ['global.controlled'], false, { 'resource.pilot': PILOT }),
  ],
  [LUNG, HEART],
);

/** The parse of a rendering, computed from its description without the renderer. */
const expectedParse = (
  description: RecordNarrowingDescription,
): ParsedRecordNarrowing => {
  const entries = description.heldResources.toSorted((left, right) =>
    left.resource < right.resource ? -1 : 1,
  );
  const heldNames = entries.map(({ resource }) => resource);
  const globals = Object.entries(description.globalCategories).toSorted(
    ([left], [right]) => (left < right ? -1 : 1),
  );
  const ownOf = (
    entry: HeldResource,
  ): readonly (readonly [string, unknown])[] =>
    Object.entries(entry.resourceCategories).toSorted(([left], [right]) =>
      left < right ? -1 : 1,
    );
  const globalExclusions = globals.flatMap(([name, condition]) => {
    const lacking = entries
      .filter(({ heldCategories }) =>
        heldCategories.every((category) => category !== name),
      )
      .map(({ resource }) => resource);

    return lacking.length > 0
      ? [{ condition, lacking, name, resource: '' }]
      : [];
  });
  const ownExclusions = entries.flatMap((entry) =>
    ownOf(entry)
      .filter(([name]) =>
        entry.heldCategories.every((category) => category !== name),
      )
      .map(([name, condition]) => ({
        condition,
        lacking: [entry.resource],
        name,
        resource: entry.resource,
      })),
  );
  const lackingUnmarked = entries.filter(({ unmarkedHeld }) => !unmarkedHeld);
  const [firstHeld, ...otherHeld] = heldNames;
  const [firstLacking, ...otherLacking] = lackingUnmarked.map(
    ({ resource }) => resource,
  );

  return bypassTypes<ParsedRecordNarrowing>({
    complement: description.knownResources
      .filter((resource) => !heldNames.includes(resource))
      .toSorted(),
    exclusions: [...globalExclusions, ...ownExclusions]
      .toSorted((left, right) =>
        left.name === right.name
          ? left.resource < right.resource
            ? -1
            : 1
          : left.name < right.name
            ? -1
            : 1,
      )
      .map(({ condition, lacking }) => ({ condition, lacking })),
    held: [firstHeld, ...otherHeld],
    resourceFieldName: description.resourceFieldName,
    ...(firstLacking === undefined
      ? {}
      : {
          unmarked: {
            globalConditions: globals.map(([, condition]) => condition),
            lacking: [firstLacking, ...otherLacking],
            scopedConditions: lackingUnmarked.flatMap((entry) =>
              ownOf(entry).map(([, condition]) => ({
                condition,
                resource: entry.resource,
              })),
            ),
          },
        }),
  });
};

const membersOf = (narrowing: SqonNode): readonly unknown[] =>
  listEntries(narrowing.content) ?? [];

const servedBy = (
  description: RecordNarrowingDescription,
  record: EvaluatedRecord,
): boolean => matchesSqon(canonicalRecordNarrowing(description), record);

suite('canonicalRecordNarrowing', () => {
  suite('the form', () => {
    test('renders the held test, the complement, each exclusion and the unmarked clause, in that order', () => {
      const description = fullDescription;

      const narrowing = canonicalRecordNarrowing(description);

      assert.deepEqual(narrowing, fullRendering);
    });

    test('renders the held test alone when every held resource holds all it can carry and every known resource is held', () => {
      const description = everythingHeld;

      const narrowing = canonicalRecordNarrowing(description);

      assert.deepEqual(narrowing, and(onResourceField(HEART)));
    });

    test('renders the complement over the known resources not held, sorted, only when there are some', () => {
      const withComplement = describedAs(
        everythingHeld.globalCategories,
        everythingHeld.heldResources,
        [VOID, HEART, REEF],
      );

      const narrowings = [
        canonicalRecordNarrowing(withComplement),
        canonicalRecordNarrowing(everythingHeld),
      ];

      assert.deepEqual(narrowings, [
        and(onResourceField(HEART), not(onResourceField(REEF, VOID))),
        and(onResourceField(HEART)),
      ]);
    });

    test('renders no exclusion for a global category held on every held resource', () => {
      const description = describedAs(
        { 'global.controlled': CONTROLLED },
        [
          held(HEART, ['global.controlled'], true),
          held(LUNG, ['global.controlled'], true),
        ],
        [HEART, LUNG],
      );

      const narrowing = canonicalRecordNarrowing(description);

      assert.deepEqual(narrowing, and(onResourceField(HEART, LUNG)));
    });

    test('renders one exclusion for a global category, naming every held resource lacking it, sorted', () => {
      const description = describedAs(
        { 'global.adult': ADULT, 'global.controlled': CONTROLLED },
        [
          held(REEF, ['global.adult'], true),
          held(LUNG, ['global.controlled'], true),
          held(HEART, ['global.controlled'], true),
        ],
        [HEART, LUNG, REEF],
      );

      const narrowing = canonicalRecordNarrowing(description);

      assert.deepEqual(
        narrowing,
        and(
          onResourceField(HEART, LUNG, REEF),
          not(
            and(onResourceField(HEART, LUNG), or(ADULT, missing('donor_age'))),
          ),
          not(
            and(
              onResourceField(REEF),
              or(CONTROLLED, missing('data_category')),
            ),
          ),
        ),
      );
    });

    test('renders one exclusion for each resource defining a category name it does not hold, ordered by resource', () => {
      const description = sharedResourceCategory;

      const narrowing = canonicalRecordNarrowing(description);
      const [, ...members] = membersOf(narrowing);

      assert.deepEqual(members.slice(0, 2), [
        not(and(onResourceField(HEART), or(PILOT, missing('cohort')))),
        not(
          and(
            onResourceField(LUNG),
            or(LATE_PILOT, missing('cohort'), missing('donor_age')),
          ),
        ),
      ]);
    });

    test('renders a test of each lacking resource defining categories, scoped to that resource, in the unmarked clause', () => {
      const description = sharedResourceCategory;

      const narrowing = canonicalRecordNarrowing(description);
      const members = membersOf(narrowing);

      assert.deepEqual(
        members.at(-1),
        not(
          and(
            onResourceField(HEART, LUNG),
            not(
              or(
                CONTROLLED,
                missing('data_category'),
                and(
                  or(not(onResourceField(HEART)), PILOT, missing('cohort')),
                  or(
                    not(onResourceField(LUNG)),
                    LATE_PILOT,
                    missing('cohort'),
                    missing('donor_age'),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    });

    test('renders the lacking resources defining no category of their own as one test in the unmarked clause', () => {
      const description = describedAs(
        { 'global.controlled': CONTROLLED },
        [
          held(VOID, ['global.controlled'], false),
          held(HEART, ['resource.pilot'], false, { 'resource.pilot': PILOT }),
          held(LUNG, ['global.controlled'], false),
        ],
        [HEART, LUNG, VOID],
      );

      const narrowing = canonicalRecordNarrowing(description);
      const members = membersOf(narrowing);

      assert.deepEqual(
        members.at(-1),
        not(
          and(
            onResourceField(HEART, LUNG, VOID),
            not(
              or(
                CONTROLLED,
                missing('data_category'),
                and(
                  not(onResourceField(LUNG, VOID)),
                  or(not(onResourceField(HEART)), PILOT, missing('cohort')),
                ),
              ),
            ),
          ),
        ),
      );
    });

    test('renders the unmarked clause from the global conditions when every lacking resource uses global categories alone', () => {
      const description = describedAs(
        { 'global.controlled': CONTROLLED },
        [held(LUNG, ['global.controlled'], false)],
        [LUNG],
      );

      const narrowing = canonicalRecordNarrowing(description);

      assert.deepEqual(
        narrowing,
        and(
          onResourceField(LUNG),
          not(
            and(
              onResourceField(LUNG),
              not(or(CONTROLLED, missing('data_category'))),
            ),
          ),
        ),
      );
    });

    test('renders the unmarked clause with no global condition when the catalogue defines none', () => {
      const description = describedAs(
        {},
        [held(HEART, ['resource.pilot'], false, { 'resource.pilot': PILOT })],
        [HEART],
      );

      const narrowing = canonicalRecordNarrowing(description);

      assert.deepEqual(
        narrowing,
        and(
          onResourceField(HEART),
          not(
            and(
              onResourceField(HEART),
              not(
                or(
                  and(
                    or(not(onResourceField(HEART)), PILOT, missing('cohort')),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    });

    test('renders no unmarked clause when every held resource holds its unmarked records', () => {
      const description = describedAs(
        { 'global.controlled': CONTROLLED },
        [held(HEART, [], true), held(LUNG, [], true)],
        [HEART, LUNG],
      );

      const narrowing = canonicalRecordNarrowing(description);

      assert.deepEqual(
        narrowing,
        and(
          onResourceField(HEART, LUNG),
          not(
            and(
              onResourceField(HEART, LUNG),
              or(CONTROLLED, missing('data_category')),
            ),
          ),
        ),
      );
    });

    test('renders one missing clause for each field a condition reads, once each and sorted', () => {
      const condition = or(
        atLeast('donor_age', 65),
        and(inClause('cohort', ['late']), atLeast('donor_age', 18)),
      );
      const description = describedAs(
        { 'global.senior': condition },
        [held(HEART, [], true)],
        [HEART],
      );

      const narrowing = canonicalRecordNarrowing(description);

      assert.deepEqual(
        narrowing,
        and(
          onResourceField(HEART),
          not(
            and(
              onResourceField(HEART),
              or(condition, missing('cohort'), missing('donor_age')),
            ),
          ),
        ),
      );
    });

    test('renders one missing clause for each field the global conditions read between them in the unmarked clause', () => {
      const description = describedAs(
        {
          'global.controlled': CONTROLLED,
          'global.restricted': inClause('data_category', ['restricted']),
        },
        [held(HEART, ['global.controlled', 'global.restricted'], false)],
        [HEART],
      );

      const narrowing = canonicalRecordNarrowing(description);

      assert.deepEqual(
        narrowing,
        and(
          onResourceField(HEART),
          not(
            and(
              onResourceField(HEART),
              not(
                or(
                  CONTROLLED,
                  inClause('data_category', ['restricted']),
                  missing('data_category'),
                ),
              ),
            ),
          ),
        ),
      );
    });

    test('gives byte-identical output for equal descriptions, whatever the order of entries, lists and condition keys', () => {
      const reordered = bypassTypes<RecordNarrowingDescription>({
        knownResources: [REEF, LUNG, HEART],
        resourceFieldName: RESOURCE_FIELD,
        heldResources: [
          {
            unmarkedHeld: true,
            resourceCategories: {},
            resource: LUNG,
            heldCategories: ['global.controlled', 'global.adult'],
          },
          {
            resourceCategories: {
              'resource.pilot': {
                op: 'in',
                content: { value: ['pilot'], fieldName: 'cohort' },
              },
            },
            unmarkedHeld: false,
            heldCategories: ['global.controlled'],
            resource: HEART,
          },
        ],
        globalCategories: {
          'global.controlled': {
            op: 'in',
            content: { value: ['controlled'], fieldName: 'data_category' },
          },
          'global.adult': {
            op: 'gte',
            content: { value: 18, fieldName: 'donor_age' },
          },
        },
      });

      const narrowings = [
        JSON.stringify(canonicalRecordNarrowing(reordered)),
        JSON.stringify(canonicalRecordNarrowing(fullDescription)),
      ];

      assert.equal(narrowings[0], narrowings[1]);
    });

    test('renders zero for a bound written as negative zero, so the two spellings give one filter', () => {
      const negative = describedAs(
        { 'global.positive': atLeast('balance', -0) },
        [held(HEART, [], true)],
        [HEART],
      );
      const positive = describedAs(
        { 'global.positive': atLeast('balance', 0) },
        [held(HEART, [], true)],
        [HEART],
      );

      const narrowings = [
        canonicalRecordNarrowing(negative),
        canonicalRecordNarrowing(positive),
      ];

      assert.deepEqual(narrowings[0], narrowings[1]);
    });

    for (const [name, description] of [
      ['every kind of member', fullDescription],
      ['a resource category name defined twice', sharedResourceCategory],
      ['the held test alone', everythingHeld],
    ] as const) {
      test(`reads back, through parseRecordNarrowing, exactly what the description says, for ${name}`, () => {
        const narrowing = canonicalRecordNarrowing(description);

        const result = parseRecordNarrowing(narrowing);

        assert.deepEqual(
          result.success ? result.narrowing : result.problems,
          expectedParse(description),
        );
      });

      test(`produces a filter SqonSchema and the enforcement validator accept, for ${name}`, () => {
        const narrowing = canonicalRecordNarrowing(description);

        const results = [
          SqonSchema.safeParse(narrowing).success,
          validateEnforcement({ kind: 'narrow', sqon: narrowing }).success,
        ];

        assert.deepEqual(results, [true, true]);
      });

      test(`leaves its input unchanged, so a deeply frozen description renders, for ${name}`, () => {
        const frozen = deepFreeze(structuredClone(description));

        canonicalRecordNarrowing(frozen);

        assert.deepEqual(frozen, description);
      });
    }

    test('reads its description once, rendering exactly what it checked', () => {
      const reads = { count: 0 };
      const description = Object.defineProperty(
        {
          globalCategories: everythingHeld.globalCategories,
          knownResources: [HEART],
          resourceFieldName: RESOURCE_FIELD,
        },
        'heldResources',
        {
          enumerable: true,
          get: (): unknown => {
            reads.count += 1;

            return reads.count === 1 ? everythingHeld.heldResources : [];
          },
        },
      );

      const narrowing = canonicalRecordNarrowing(
        bypassTypes<RecordNarrowingDescription>(description),
      );

      assert.equal(reads.count, 1);
      assert.deepEqual(narrowing, canonicalRecordNarrowing(everythingHeld));
    });
  });

  suite('what it serves', () => {
    test('withholds a record missing a field an excluded category reads, and serves its neighbour holding the field', () => {
      const description = describedAs(
        { 'global.adult': ADULT, 'global.controlled': CONTROLLED },
        [held(HEART, ['global.controlled'], true)],
        [HEART],
      );

      const verdicts = [
        servedBy(description, { data_category: 'controlled', study_id: HEART }),
        servedBy(description, {
          data_category: 'controlled',
          donor_age: 12,
          study_id: HEART,
        }),
      ];

      assert.deepEqual(verdicts, [false, true]);
    });

    test('serves an unmarked record only where unmarked is held', () => {
      const description = describedAs(
        { 'global.controlled': CONTROLLED },
        [
          held(HEART, ['global.controlled'], false),
          held(LUNG, ['global.controlled'], true),
        ],
        [HEART, LUNG],
      );

      const verdicts = [
        servedBy(description, { data_category: 'open', study_id: HEART }),
        servedBy(description, { data_category: 'open', study_id: LUNG }),
        servedBy(description, { data_category: 'controlled', study_id: HEART }),
      ];

      assert.deepEqual(verdicts, [false, true, true]);
    });

    test("withholds an uncategorized record of a resource lacking unmarked that matches another lacking resource's own category", () => {
      const description = describedAs(
        { 'global.controlled': CONTROLLED },
        [
          held(HEART, ['resource.pilot'], false, { 'resource.pilot': PILOT }),
          held(LUNG, ['global.controlled'], false),
        ],
        [HEART, LUNG],
      );

      const verdicts = [
        servedBy(description, {
          cohort: 'pilot',
          data_category: 'open',
          study_id: LUNG,
        }),
        servedBy(description, {
          cohort: 'pilot',
          data_category: 'open',
          study_id: HEART,
        }),
      ];

      assert.deepEqual(verdicts, [false, true]);
    });

    test('withholds a record of two held resources carrying a category held on one only, and serves it once held on both', () => {
      const heldOnOne = describedAs(
        { 'global.controlled': CONTROLLED },
        [held(HEART, ['global.controlled'], true), held(LUNG, [], true)],
        [HEART, LUNG],
      );
      const heldOnBoth = describedAs(
        { 'global.controlled': CONTROLLED },
        [
          held(HEART, ['global.controlled'], true),
          held(LUNG, ['global.controlled'], true),
        ],
        [HEART, LUNG],
      );
      const record = { data_category: 'controlled', study_id: [HEART, LUNG] };

      const verdicts = [
        servedBy(heldOnOne, record),
        servedBy(heldOnBoth, record),
      ];

      assert.deepEqual(verdicts, [false, true]);
    });

    test('withholds a record of a held resource and a resource known but not held', () => {
      const description = describedAs(
        { 'global.controlled': CONTROLLED },
        [held(HEART, ['global.controlled'], true)],
        [HEART, REEF],
      );

      const verdicts = [
        servedBy(description, {
          data_category: 'open',
          study_id: [HEART, REEF],
        }),
        servedBy(description, {
          data_category: 'open',
          study_id: [HEART, VOID],
        }),
      ];

      assert.deepEqual(verdicts, [false, true]);
    });

    test("withholds a record of a held resource beside one the payload serves and the principal holds nothing on, the known resources being the payload's servedResources, as for a key with no list", () => {
      // Given a payload holding HEART_STUDY's unmarked records and serving REEF_ARCHIVE beside it,
      // with nothing held there, so REEF_ARCHIVE is named nowhere but servedResources
      const validated = validatePayload({
        payloadVersion: 1,
        sub: 'subject-id',
        iss: 'https://usher.example.org',
        aud: 'arranger-prod',
        iat: 1767225600,
        exp: 1767225900,
        generatedAt: 1767225600,
        permissions: { [HEART]: { 'global.unmarked': { record: ['view'] } } },
        globalCategories: ['global.controlled'],
        resourceCategories: { [HEART]: [] },
        servedResources: [HEART, REEF],
      });
      assert.ok(validated.success);
      const description = describedAs(
        { 'global.controlled': CONTROLLED },
        [held(HEART, [], true)],
        validated.payload.servedResources,
      );

      // When records holding HEART_STUDY alone or beside another resource are judged
      const verdicts = [
        servedBy(description, { data_category: 'open', study_id: HEART }),
        servedBy(description, {
          data_category: 'open',
          study_id: [HEART, REEF],
        }),
        servedBy(description, {
          data_category: 'open',
          study_id: [HEART, VOID],
        }),
      ];

      // Then the record is served alone and beside VOID_INDEX, which the payload does not serve, and
      // withheld beside REEF_ARCHIVE
      assert.deepEqual(verdicts, [true, false, true]);
    });

    test("withholds a record of two resources lacking unmarked that carries only one resource's own category, and serves it once it carries a category of each", () => {
      const description = describedAs(
        { 'global.controlled': CONTROLLED },
        [
          held(HEART, ['resource.pilot'], false, { 'resource.pilot': PILOT }),
          held(LUNG, ['resource.late'], false, { 'resource.late': LATE_PILOT }),
        ],
        [HEART, LUNG],
      );

      const verdicts = [
        servedBy(description, {
          cohort: 'pilot',
          data_category: 'open',
          donor_age: 30,
          study_id: [HEART, LUNG],
        }),
        servedBy(description, {
          cohort: ['pilot', 'late'],
          data_category: 'open',
          donor_age: 70,
          study_id: [HEART, LUNG],
        }),
      ];

      assert.deepEqual(verdicts, [false, true]);
    });
  });

  suite('the depth of an authored condition', () => {
    /** `levels` nots around a range on one field, whose bound is the deepest JSON level it reaches. */
    const negatedRange = (levels: number): Node =>
      Array.from({ length: levels }).reduce<Node>(
        (inner) => not(inner),
        atLeast('donor_age', 18),
      );

    const authoredLimit = SQON_MAX_DEPTH - 2 * RENDERED_WRAPPING_NODES;
    const deepestLevels = (authoredLimit - 2) / 2;

    const lackingUnmarkedWith = (
      condition: unknown,
    ): RecordNarrowingDescription =>
      describedAs(
        {},
        [held(HEART, ['resource.deep'], false, { 'resource.deep': condition })],
        [HEART],
      );

    test('renders the deepest condition the grammar accepts, as a resource category of a resource lacking unmarked, into a filter SqonSchema accepts', () => {
      const condition = negatedRange(deepestLevels);

      const narrowing = canonicalRecordNarrowing(
        lackingUnmarkedWith(condition),
      );

      assertAccepted(validateCategoryCondition(condition));
      assert.equal(SqonSchema.safeParse(narrowing).success, true);
      assert.equal(checkSqonDepth(narrowing, SQON_MAX_DEPTH - 1), false);
    });

    test('refuses a condition one level deeper, by the grammar', () => {
      const condition = negatedRange(deepestLevels + 1);

      const error = contractErrorFrom(
        () => canonicalRecordNarrowing(lackingUnmarkedWith(condition)),
        RECORD_NARROWING_RULES.conditions,
      );

      assertRefusedFor(
        validateCategoryCondition(condition),
        'condition',
        CONDITION_RULES.depth,
      );
      assert.deepEqual(error.problems, []);
    });
  });

  suite('what it refuses to render', () => {
    /** One rule, broken by a refused description beside an accepted one that differs only where it breaks. */
    interface RuleCase {
      accepted: unknown;
      accepts: string;
      refused: unknown;
      refuses: string;
      rule: string;
    }

    const withMembers = (
      members: Readonly<Record<string, unknown>>,
    ): unknown => ({
      ...fullDescription,
      ...members,
    });

    const withHeart = (members: Readonly<Record<string, unknown>>): unknown =>
      withMembers({
        heldResources: [
          { ...fullDescription.heldResources[0], ...members },
          fullDescription.heldResources[1],
        ],
      });

    const withoutHeartMember = (member: string): unknown =>
      withMembers({
        heldResources: [
          Object.fromEntries(
            Object.entries(fullDescription.heldResources[0] ?? {}).filter(
              ([key]) => key !== member,
            ),
          ),
          fullDescription.heldResources[1],
        ],
      });

    const cases: readonly RuleCase[] = [
      {
        accepted: fullDescription,
        accepts: 'a description that is a map',
        refused: [fullDescription],
        refuses: 'a description that is a list',
        rule: RECORD_NARROWING_RULES.descriptionIsMap,
      },
      {
        accepted: fullDescription,
        accepts: 'a description carrying its four members',
        refused: withMembers({ catalogueId: 'files' }),
        refuses: 'a description carrying a fifth member',
        rule: RECORD_NARROWING_RULES.descriptionMembers,
      },
      {
        accepted: fullDescription,
        accepts: 'a resource field name',
        refused: withMembers({ resourceFieldName: '' }),
        refuses: 'an empty resource field name',
        rule: RECORD_NARROWING_RULES.resourceFieldName,
      },
      {
        accepted: withMembers({
          globalCategories: { 'global.controlled': CONTROLLED },
        }),
        accepts: 'a concrete global category',
        refused: withMembers({
          globalCategories: { 'global.unmarked': CONTROLLED },
        }),
        refuses: 'global.unmarked defined as a global category',
        rule: RECORD_NARROWING_RULES.globalCategories,
      },
      {
        accepted: withMembers({
          globalCategories: { 'global.controlled': CONTROLLED },
        }),
        accepts: 'a global category named global.',
        refused: withMembers({
          globalCategories: { 'resource.controlled': CONTROLLED },
        }),
        refuses: 'a resource category among the global ones',
        rule: RECORD_NARROWING_RULES.globalCategories,
      },
      {
        accepted: withMembers({
          globalCategories: {},
          heldResources: [
            {
              ...fullDescription.heldResources[0],
              heldCategories: ['resource.pilot'],
            },
            fullDescription.heldResources[1],
          ],
        }),
        accepts: 'global categories as an empty map',
        refused: withMembers({
          globalCategories: [],
          heldResources: [
            {
              ...fullDescription.heldResources[0],
              heldCategories: ['resource.pilot'],
            },
            fullDescription.heldResources[1],
          ],
        }),
        refuses: 'global categories as a list',
        rule: RECORD_NARROWING_RULES.globalCategories,
      },
      {
        accepted: fullDescription,
        accepts: 'a held resource list holding entries',
        refused: withMembers({ heldResources: [] }),
        refuses: 'an empty held resource list',
        rule: RECORD_NARROWING_RULES.heldResources,
      },
      {
        accepted: fullDescription,
        accepts: 'held resources as a list',
        refused: withMembers({
          heldResources: fullDescription.heldResources[0],
        }),
        refuses: 'held resources as a map',
        rule: RECORD_NARROWING_RULES.heldResources,
      },
      {
        accepted: withHeart({ unmarkedHeld: false }),
        accepts: 'a held resource saying whether its unmarked records are held',
        refused: withoutHeartMember('unmarkedHeld'),
        refuses: 'a held resource without unmarkedHeld',
        rule: RECORD_NARROWING_RULES.heldEntryMembers,
      },
      {
        accepted: withHeart({ unmarkedHeld: false }),
        accepts: 'a held resource whose unmarkedHeld is false',
        refused: withHeart({ unmarkedHeld: undefined }),
        refuses: 'a held resource whose unmarkedHeld is present as undefined',
        rule: RECORD_NARROWING_RULES.heldEntryMembers,
      },
      {
        accepted: fullDescription,
        accepts: 'a held resource carrying its four members',
        refused: withHeart({ unmarkedHled: true }),
        refuses: 'a held resource carrying a mistyped member',
        rule: RECORD_NARROWING_RULES.heldEntryMembers,
      },
      {
        accepted: fullDescription,
        accepts: 'a held resource that is a map',
        refused: withMembers({ heldResources: [HEART] }),
        refuses: 'a held resource that is a string',
        rule: RECORD_NARROWING_RULES.heldEntryMembers,
      },
      {
        accepted: fullDescription,
        accepts: 'a held resource named by a literal identifier',
        refused: withHeart({ resource: 'HEART*' }),
        refuses: 'a held resource named by a pattern',
        rule: RECORD_NARROWING_RULES.heldResource,
      },
      {
        accepted: fullDescription,
        accepts: 'a held resource named by a non-empty identifier',
        refused: withHeart({ resource: '' }),
        refuses: 'a held resource named by the empty string',
        rule: RECORD_NARROWING_RULES.heldResource,
      },
      {
        accepted: fullDescription,
        accepts: 'a held resource named other than __proto__',
        refused: withHeart({ resource: '__proto__' }),
        refuses: 'a held resource named __proto__',
        rule: RECORD_NARROWING_RULES.heldResource,
      },
      {
        accepted: fullDescription,
        accepts: 'two held resources',
        refused: withMembers({
          heldResources: [
            fullDescription.heldResources[0],
            fullDescription.heldResources[0],
          ],
        }),
        refuses: 'one resource held twice',
        rule: RECORD_NARROWING_RULES.heldResourcesDistinct,
      },
      {
        accepted: withHeart({ heldCategories: ['global.controlled'] }),
        accepts: 'held categories naming concrete categories',
        refused: withHeart({
          heldCategories: ['global.controlled', 'global.unmarked'],
        }),
        refuses: 'held categories naming global.unmarked',
        rule: RECORD_NARROWING_RULES.heldCategories,
      },
      {
        accepted: withHeart({ heldCategories: ['global.controlled'] }),
        accepts: 'held categories naming each category once',
        refused: withHeart({
          heldCategories: ['global.controlled', 'global.controlled'],
        }),
        refuses: 'held categories naming a category twice',
        rule: RECORD_NARROWING_RULES.heldCategories,
      },
      {
        accepted: withHeart({ heldCategories: ['global.controlled'] }),
        accepts: 'held categories naming categories by scope',
        refused: withHeart({ heldCategories: ['controlled'] }),
        refuses: 'held categories naming a category without its scope',
        rule: RECORD_NARROWING_RULES.heldCategories,
      },
      {
        accepted: withHeart({ heldCategories: ['global.controlled'] }),
        accepts: 'held categories as a list',
        refused: withHeart({ heldCategories: 'global.controlled' }),
        refuses: 'held categories as a string',
        rule: RECORD_NARROWING_RULES.heldCategories,
      },
      {
        accepted: withHeart({
          resourceCategories: { 'resource.pilot': PILOT },
        }),
        accepts: 'a resource category named resource.',
        refused: withHeart({
          resourceCategories: { 'resource.unmarked': PILOT },
        }),
        refuses: 'resource.unmarked defined as a resource category',
        rule: RECORD_NARROWING_RULES.resourceCategories,
      },
      {
        accepted: withHeart({
          resourceCategories: { 'resource.pilot': PILOT },
        }),
        accepts: "a resource's own category named resource.",
        refused: withHeart({ resourceCategories: { 'global.pilot': PILOT } }),
        refuses: "a global category among a resource's own",
        rule: RECORD_NARROWING_RULES.resourceCategories,
      },
      {
        accepted: withHeart({ resourceCategories: {} }),
        accepts: "a resource's own categories as an empty map",
        refused: withHeart({ resourceCategories: [] }),
        refuses: "a resource's own categories as a list",
        rule: RECORD_NARROWING_RULES.resourceCategories,
      },
      {
        accepted: withHeart({ unmarkedHeld: true }),
        accepts: 'unmarkedHeld as a boolean',
        refused: withHeart({ unmarkedHeld: 'true' }),
        refuses: 'unmarkedHeld as a string',
        rule: RECORD_NARROWING_RULES.unmarkedHeld,
      },
      {
        accepted: withHeart({
          heldCategories: ['global.controlled'],
          unmarkedHeld: false,
        }),
        accepts:
          'a resource lacking unmarked that holds a global category defined here',
        refused: withHeart({
          heldCategories: ['global.embargoed'],
          unmarkedHeld: false,
        }),
        refuses:
          'a resource lacking unmarked that holds only a global category not defined here',
        rule: RECORD_NARROWING_RULES.servesRecords,
      },
      {
        accepted: withHeart({
          heldCategories: ['resource.pilot'],
          unmarkedHeld: false,
        }),
        accepts: 'a resource lacking unmarked that holds a category of its own',
        refused: withHeart({
          heldCategories: ['resource.other'],
          unmarkedHeld: false,
        }),
        refuses:
          'a resource lacking unmarked that holds only a resource category it does not define',
        rule: RECORD_NARROWING_RULES.servesRecords,
      },
      {
        accepted: withHeart({ heldCategories: [], unmarkedHeld: true }),
        accepts: 'a resource holding its unmarked records and no category',
        refused: withHeart({ heldCategories: [], unmarkedHeld: false }),
        refuses:
          'a resource holding neither its unmarked records nor any category',
        rule: RECORD_NARROWING_RULES.servesRecords,
      },
      {
        accepted: fullDescription,
        accepts: 'known resources as a list',
        refused: withMembers({ knownResources: HEART }),
        refuses: 'known resources as a string',
        rule: RECORD_NARROWING_RULES.knownResources,
      },
      {
        accepted: fullDescription,
        accepts: 'known resources named once each',
        refused: withMembers({ knownResources: [HEART, LUNG, LUNG] }),
        refuses: 'a known resource named twice',
        rule: RECORD_NARROWING_RULES.knownResources,
      },
      {
        accepted: fullDescription,
        accepts: 'known resources named by literal identifiers',
        refused: withMembers({ knownResources: [HEART, LUNG, 'set_id:reef'] }),
        refuses: 'a known resource holding a saved-set reference',
        rule: RECORD_NARROWING_RULES.knownResources,
      },
      {
        accepted: fullDescription,
        accepts: 'known resources including every held resource',
        refused: withMembers({ knownResources: [HEART, REEF] }),
        refuses: 'known resources leaving a held resource out',
        rule: RECORD_NARROWING_RULES.knownIncludesHeld,
      },
      {
        accepted: withMembers({
          globalCategories: { 'global.controlled': CONTROLLED },
        }),
        accepts: 'a global condition held to the grammar',
        refused: withMembers({
          globalCategories: {
            'global.controlled': {
              content: { fieldName: 'data_category', value: ['open'] },
              op: 'not-in',
            },
          },
        }),
        refuses: 'a global condition holding an exclusion operator',
        rule: RECORD_NARROWING_RULES.conditions,
      },
      {
        accepted: withHeart({
          resourceCategories: { 'resource.pilot': PILOT },
        }),
        accepts: "a resource's own condition held to the grammar",
        refused: withHeart({
          resourceCategories: {
            'resource.pilot': inClause('cohort', ['__missing__']),
          },
        }),
        refuses: "a resource's own condition listing the missing-field marker",
        rule: RECORD_NARROWING_RULES.conditions,
      },
      {
        accepted: withMembers({
          globalCategories: { 'global.controlled': CONTROLLED },
        }),
        accepts: 'a global condition reading another field',
        refused: withMembers({
          globalCategories: {
            'global.controlled': inClause(RESOURCE_FIELD, [HEART]),
          },
        }),
        refuses: 'a global condition reading the resource field',
        rule: RECORD_NARROWING_RULES.resourceFieldUnread,
      },
      {
        accepted: withHeart({
          resourceCategories: { 'resource.pilot': PILOT },
        }),
        accepts: "a resource's own condition reading another field",
        refused: withHeart({
          resourceCategories: {
            'resource.pilot': and(PILOT, onResourceField(HEART)),
          },
        }),
        refuses: "a resource's own condition reading the resource field",
        rule: RECORD_NARROWING_RULES.resourceFieldUnread,
      },
    ];

    for (const { accepted, accepts, refused, refuses, rule } of cases) {
      test(`renders ${accepts}`, () => {
        const narrowing = canonicalRecordNarrowing(
          bypassTypes<RecordNarrowingDescription>(accepted),
        );

        assert.equal(narrowing.op, 'and');
      });

      test(`throws for ${refuses}`, () => {
        const given = bypassTypes<RecordNarrowingDescription>(refused);

        const error = contractErrorFrom(
          () => canonicalRecordNarrowing(given),
          rule,
        );

        assert.deepEqual(error.problems, []);
      });
    }

    test('throws for a description that cannot be read, passing on nothing it threw', () => {
      const description = Object.defineProperty({}, 'heldResources', {
        enumerable: true,
        get: (): never => {
          throw new Error(`${LEAK_MARKER}_thrown`);
        },
      });

      const error = contractErrorFrom(
        () =>
          canonicalRecordNarrowing(
            bypassTypes<RecordNarrowingDescription>(description),
          ),
        READ_RULE,
      );

      assertCarriesNoInput(error);
    });
  });

  suite('what it throws carries', () => {
    /** The words fixed by the contract, carried unmarked by a leak input. */
    const CONTRACT_WORDS: ReadonlySet<string> = new Set([
      '',
      'content',
      'fieldName',
      'globalCategories',
      'gte',
      'heldCategories',
      'heldResources',
      'in',
      'knownResources',
      'not-in',
      'op',
      'resource',
      'resourceCategories',
      'resourceFieldName',
      'unmarkedHeld',
      'value',
    ]);

    const markedResource = `${LEAK_MARKER}_resource`;
    const markedGlobal = `global.${LEAK_MARKER}_global`;
    const markedOwn = `resource.${LEAK_MARKER}_own`;
    const markedCondition = {
      content: {
        fieldName: `${LEAK_MARKER}_field`,
        value: [`${LEAK_MARKER}_value`],
      },
      op: 'in',
    };

    const markedEntry = (
      members: Readonly<Record<string, unknown>> = {},
    ): Record<string, unknown> => ({
      heldCategories: [markedGlobal],
      resource: markedResource,
      resourceCategories: { [markedOwn]: markedCondition },
      unmarkedHeld: false,
      ...members,
    });

    /** A renderable description in which every identifier and value carries the marker. */
    const markedDescription = (
      members: Readonly<Record<string, unknown>> = {},
    ): Record<string, unknown> => ({
      globalCategories: {
        [markedGlobal]: {
          content: { fieldName: `${LEAK_MARKER}_age`, value: LEAK_NUMBER },
          op: 'gte',
        },
      },
      heldResources: [markedEntry()],
      knownResources: [markedResource, `${LEAK_MARKER}_known`],
      resourceFieldName: `${LEAK_MARKER}_resource_field`,
      ...members,
    });

    const leakCases: readonly {
      description: string;
      input: unknown;
      rule: string;
    }[] = [
      {
        description: 'a condition outside the grammar',
        input: markedDescription({
          globalCategories: {
            [markedGlobal]: { ...markedCondition, op: 'not-in' },
          },
        }),
        rule: RECORD_NARROWING_RULES.conditions,
      },
      {
        description: 'a description that is not a map',
        input: [markedDescription()],
        rule: RECORD_NARROWING_RULES.descriptionIsMap,
      },
      {
        description: 'a description carrying a member it does not define',
        input: markedDescription({
          [`${LEAK_MARKER}_member`]: `${LEAK_MARKER}_passenger`,
        }),
        rule: RECORD_NARROWING_RULES.descriptionMembers,
      },
      {
        description: 'a global category named outside its scope',
        input: markedDescription({
          globalCategories: { [`${LEAK_MARKER}_bare`]: markedCondition },
        }),
        rule: RECORD_NARROWING_RULES.globalCategories,
      },
      {
        description: 'held categories naming a category twice',
        input: markedDescription({
          heldResources: [
            markedEntry({ heldCategories: [markedGlobal, markedGlobal] }),
          ],
        }),
        rule: RECORD_NARROWING_RULES.heldCategories,
      },
      {
        description: 'a held resource carrying a mistyped member',
        input: markedDescription({
          heldResources: [markedEntry({ [`${LEAK_MARKER}_member`]: true })],
        }),
        rule: RECORD_NARROWING_RULES.heldEntryMembers,
      },
      {
        description: 'a held resource named by a pattern',
        input: markedDescription({
          heldResources: [markedEntry({ resource: `${LEAK_MARKER}*` })],
        }),
        rule: RECORD_NARROWING_RULES.heldResource,
      },
      {
        description: 'no held resource',
        input: markedDescription({ heldResources: [] }),
        rule: RECORD_NARROWING_RULES.heldResources,
      },
      {
        description: 'one resource held twice',
        input: markedDescription({
          heldResources: [markedEntry(), markedEntry()],
        }),
        rule: RECORD_NARROWING_RULES.heldResourcesDistinct,
      },
      {
        description: 'a known list leaving a held resource out',
        input: markedDescription({ knownResources: [`${LEAK_MARKER}_known`] }),
        rule: RECORD_NARROWING_RULES.knownIncludesHeld,
      },
      {
        description: 'a known resource named twice',
        input: markedDescription({
          knownResources: [markedResource, markedResource],
        }),
        rule: RECORD_NARROWING_RULES.knownResources,
      },
      {
        description: "a resource's own category named outside its scope",
        input: markedDescription({
          heldResources: [
            markedEntry({
              resourceCategories: { [`${LEAK_MARKER}_bare`]: markedCondition },
            }),
          ],
        }),
        rule: RECORD_NARROWING_RULES.resourceCategories,
      },
      {
        description: 'an empty resource field name',
        input: markedDescription({ resourceFieldName: '' }),
        rule: RECORD_NARROWING_RULES.resourceFieldName,
      },
      {
        description: 'a condition reading the resource field',
        input: markedDescription({
          globalCategories: {
            [markedGlobal]: {
              content: {
                fieldName: `${LEAK_MARKER}_resource_field`,
                value: [markedResource],
              },
              op: 'in',
            },
          },
        }),
        rule: RECORD_NARROWING_RULES.resourceFieldUnread,
      },
      {
        description: 'a held resource serving no record',
        input: markedDescription({
          heldResources: [
            markedEntry({ heldCategories: [`global.${LEAK_MARKER}_absent`] }),
          ],
        }),
        rule: RECORD_NARROWING_RULES.servesRecords,
      },
      {
        description: 'unmarkedHeld that is no boolean',
        input: markedDescription({
          heldResources: [markedEntry({ unmarkedHeld: `${LEAK_MARKER}_yes` })],
        }),
        rule: RECORD_NARROWING_RULES.unmarkedHeld,
      },
    ];

    test('starts from a marked description that renders', () => {
      const description = markedDescription();

      const narrowing = canonicalRecordNarrowing(
        bypassTypes<RecordNarrowingDescription>(description),
      );

      assertInputMarked(description, CONTRACT_WORDS);
      assert.equal(narrowing.op, 'and');
    });

    for (const { description, input, rule } of leakCases) {
      test(`names no content of the description in what it throws for ${description}`, () => {
        assertInputMarked(input, CONTRACT_WORDS);

        const error = contractErrorFrom(
          () =>
            canonicalRecordNarrowing(
              bypassTypes<RecordNarrowingDescription>(input),
            ),
          rule,
        );

        assertCarriesNoInput(error);
      });
    }

    test('breaks every rule it holds, between the descriptions above', () => {
      const cases = leakCases;

      assertEveryRuleBroken(cases, RECORD_NARROWING_RULES);
    });
  });
});
