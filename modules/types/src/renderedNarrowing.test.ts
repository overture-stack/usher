import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { READ_RULE } from './problems.js';
import {
  type ParsedRecordNarrowing,
  parseRecordNarrowing,
  RENDERED_NARROWING_RULES,
} from './renderedNarrowing.js';
import {
  assertAccepted,
  assertCarriesNoInput,
  assertEveryRuleBroken,
  assertInputMarked,
  assertRefusedFor,
  LEAK_MARKER,
  LEAK_NUMBER,
} from './testSupport.js';

const RESOURCE_FIELD = 'study_id';
const HEART = 'HEART_STUDY';
const LUNG = 'LUNG_COHORT';
const REEF = 'REEF_ARCHIVE';
const VOID = 'VOID_INDEX';

type Node = Record<string, unknown>;

const inClause = (fieldName: unknown, value: unknown): Node => ({
  content: { fieldName, value },
  op: 'in',
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
const missing = (fieldName: unknown): Node =>
  inClause(fieldName, ['__missing__']);
const onResourceField = (...resources: readonly unknown[]): Node =>
  inClause(RESOURCE_FIELD, resources);

const CONTROLLED = inClause('data_category', ['controlled']);
const ADULT: Node = {
  content: { fieldName: 'donor_age', value: 18 },
  op: 'gte',
};
const PILOT = inClause('cohort', ['pilot']);

/** A condition reading two fields and holding a not beside no in, which `walkProblems` refuses. */
const RECENT_AND_SHARED = and(
  { content: { fieldName: 'collection_date', value: '2020-01-01' }, op: 'gte' },
  not(inClause('data_category', ['open'])),
);

const complementOf = (...resources: readonly unknown[]): Node =>
  not(onResourceField(...resources));

const exclusionOf = (
  lacking: readonly unknown[],
  ...members: readonly unknown[]
): Node => not(and(onResourceField(...lacking), or(...members)));

const unmarkedOf = (
  lacking: readonly unknown[],
  ...members: readonly unknown[]
): Node => not(and(onResourceField(...lacking), not(or(...members))));

const scopedOf = (resource: unknown, ...members: readonly unknown[]): Node =>
  or(not(onResourceField(resource)), ...members);

const narrowingOf = (...members: readonly unknown[]): Node =>
  and(onResourceField(HEART, LUNG), ...members);

const heartPilotExclusion = exclusionOf([HEART], PILOT, missing('cohort'));

const adultExclusion = exclusionOf([HEART, LUNG], ADULT, missing('donor_age'));

const fullUnmarked = unmarkedOf(
  [HEART, LUNG],
  ADULT,
  CONTROLLED,
  missing('data_category'),
  missing('donor_age'),
  and(not(onResourceField(LUNG)), scopedOf(HEART, PILOT, missing('cohort'))),
);

/** Every kind of member, each in its canonical place. */
const fullNarrowing = narrowingOf(
  complementOf(REEF, VOID),
  adultExclusion,
  heartPilotExclusion,
  fullUnmarked,
);

const narrowingWithMember = (member: unknown): Node =>
  narrowingOf(complementOf(REEF), member);

/** The accepted parse of `sqon`, failing the test when it is refused. */
const parsed = (sqon: unknown): ParsedRecordNarrowing => {
  const result = parseRecordNarrowing(sqon);

  if (result.success) {
    return result.narrowing;
  }

  return assert.fail(`expected acceptance; found ${JSON.stringify(result)}`);
};

suite('parseRecordNarrowing', () => {
  suite('what it returns', () => {
    test('returns the held resources, the complement, each exclusion and the unmarked clause the filter states', () => {
      const sqon = fullNarrowing;

      const narrowing = parsed(sqon);

      assert.deepEqual(narrowing, {
        complement: [REEF, VOID],
        exclusions: [
          { condition: ADULT, lacking: [HEART, LUNG] },
          { condition: PILOT, lacking: [HEART] },
        ],
        held: [HEART, LUNG],
        resourceFieldName: RESOURCE_FIELD,
        unmarked: {
          globalConditions: [ADULT, CONTROLLED],
          lacking: [HEART, LUNG],
          scopedConditions: [{ condition: PILOT, resource: HEART }],
        },
      });
    });

    test('returns an empty complement, no exclusion and no unmarked clause for the held test alone', () => {
      const sqon = and(onResourceField(HEART));

      const narrowing = parsed(sqon);

      assert.deepEqual(narrowing, {
        complement: [],
        exclusions: [],
        held: [HEART],
        resourceFieldName: RESOURCE_FIELD,
      });
    });

    test('returns the unmarked clause holding only global conditions when every lacking resource uses global categories alone', () => {
      const sqon = narrowingOf(
        unmarkedOf([LUNG], CONTROLLED, missing('data_category')),
      );

      const narrowing = parsed(sqon);

      assert.deepEqual(narrowing.unmarked, {
        globalConditions: [CONTROLLED],
        lacking: [LUNG],
        scopedConditions: [],
      });
    });

    test('returns the unmarked clause with no global condition when the catalogue defines none', () => {
      const sqon = narrowingOf(
        unmarkedOf([HEART], and(scopedOf(HEART, PILOT, missing('cohort')))),
      );

      const narrowing = parsed(sqon);

      assert.deepEqual(narrowing.unmarked, {
        globalConditions: [],
        lacking: [HEART],
        scopedConditions: [{ condition: PILOT, resource: HEART }],
      });
    });

    test('returns each scoped condition beside the resource it is scoped to', () => {
      const sqon = narrowingOf(
        unmarkedOf(
          [HEART, LUNG],
          and(
            scopedOf(LUNG, PILOT, missing('cohort')),
            scopedOf(
              HEART,
              CONTROLLED,
              PILOT,
              missing('cohort'),
              missing('data_category'),
            ),
          ),
        ),
      );

      const narrowing = parsed(sqon);

      assert.deepEqual(narrowing.unmarked?.scopedConditions, [
        { condition: PILOT, resource: LUNG },
        { condition: CONTROLLED, resource: HEART },
        { condition: PILOT, resource: HEART },
      ]);
    });

    test('holds each authored condition as given, aliases and nots beside no in included', () => {
      const aliased: Node = {
        content: { fieldName: 'data_category', value: ['controlled'] },
        op: '=',
      };
      const sqon = narrowingOf(
        exclusionOf(
          [HEART],
          RECENT_AND_SHARED,
          missing('collection_date'),
          missing('data_category'),
        ),
        exclusionOf([LUNG], aliased, missing('data_category')),
      );

      const narrowing = parsed(sqon);

      assert.deepEqual(
        narrowing.exclusions.map(({ condition }) => condition),
        [RECENT_AND_SHARED, aliased],
      );
    });

    test('checks structure and not order, so lists, exclusions and or members may come in any order', () => {
      const sqon = narrowingOf(
        complementOf(VOID, REEF),
        heartPilotExclusion,
        exclusionOf([LUNG, HEART], missing('donor_age'), ADULT),
        unmarkedOf(
          [LUNG, HEART],
          and(
            scopedOf(HEART, missing('cohort'), PILOT),
            not(onResourceField(LUNG)),
          ),
          missing('donor_age'),
          CONTROLLED,
          missing('data_category'),
          ADULT,
        ),
      );

      const narrowing = parsed(sqon);

      assert.deepEqual(narrowing, {
        complement: [VOID, REEF],
        exclusions: [
          { condition: PILOT, lacking: [HEART] },
          { condition: ADULT, lacking: [LUNG, HEART] },
        ],
        held: [HEART, LUNG],
        resourceFieldName: RESOURCE_FIELD,
        unmarked: {
          globalConditions: [CONTROLLED, ADULT],
          lacking: [LUNG, HEART],
          scopedConditions: [{ condition: PILOT, resource: HEART }],
        },
      });
    });

    test('returns a copy, so a later change to the filter reaches nothing returned', () => {
      const condition = {
        content: { fieldName: 'donor_age', value: 18 },
        op: 'gte',
      };
      const sqon = narrowingOf(
        exclusionOf([HEART], condition, missing('donor_age')),
      );

      const result = parseRecordNarrowing(sqon);
      condition.op = 'lte';

      assert.deepEqual(result.success && result.narrowing.exclusions, [
        { condition: ADULT, lacking: [HEART] },
      ]);
    });
  });

  suite('the grammar', () => {
    /** One rule, broken by a refused filter beside an accepted one that differs only where it breaks. */
    interface RuleCase {
      accepted: unknown;
      accepts: string;
      position: string;
      refused: unknown;
      refuses: string;
      rule: string;
    }

    const cases: readonly RuleCase[] = [
      {
        accepted: and(onResourceField(HEART)),
        accepts: 'an and holding the held test alone',
        position: 'sqon',
        refused: or(onResourceField(HEART)),
        refuses: 'an or in place of the root and',
        rule: RENDERED_NARROWING_RULES.root,
      },
      {
        accepted: and(onResourceField(HEART)),
        accepts: 'an and holding the held test',
        position: 'sqon',
        refused: and(),
        refuses: 'an and holding nothing',
        rule: RENDERED_NARROWING_RULES.root,
      },
      {
        accepted: and(onResourceField(HEART)),
        accepts: 'an and whose content is a list',
        position: 'sqon',
        refused: { content: onResourceField(HEART), op: 'and' },
        refuses: 'an and whose content is not a list',
        rule: RENDERED_NARROWING_RULES.root,
      },
      {
        accepted: and(onResourceField(HEART)),
        accepts: 'a root that is a map',
        position: 'sqon',
        refused: [and(onResourceField(HEART))],
        refuses: 'a root that is a list',
        rule: RENDERED_NARROWING_RULES.root,
      },
      {
        accepted: and(onResourceField(HEART)),
        accepts: 'a root carrying only op and content',
        position: 'sqon',
        refused: { ...and(onResourceField(HEART)), pivot: null },
        refuses: 'a root carrying a pivot',
        rule: RENDERED_NARROWING_RULES.structuralNode,
      },
      {
        accepted: narrowingOf(adultExclusion),
        accepts: "an exclusion's and carrying only op and content",
        position: 'sqon.content[1]',
        refused: narrowingOf(
          not({
            ...and(onResourceField(HEART), or(ADULT, missing('donor_age'))),
            pivot: 'donors',
          }),
        ),
        refuses: "an exclusion's and carrying a pivot",
        rule: RENDERED_NARROWING_RULES.structuralNode,
      },
      {
        accepted: and(onResourceField(HEART)),
        accepts: 'a held test carrying only fieldName and value',
        position: 'sqon.content[0]',
        refused: and({
          content: { fieldName: RESOURCE_FIELD, kind: 'held', value: [HEART] },
          op: 'in',
        }),
        refuses: 'a held test carrying a member other than fieldName and value',
        rule: RENDERED_NARROWING_RULES.structuralNode,
      },
      {
        accepted: and(onResourceField(HEART)),
        accepts: 'a held test listing one resource',
        position: 'sqon.content[0]',
        refused: and(onResourceField()),
        refuses: 'a held test listing no resource',
        rule: RENDERED_NARROWING_RULES.heldTest,
      },
      {
        accepted: and(onResourceField(HEART, LUNG)),
        accepts: 'a held test naming two resources',
        position: 'sqon.content[0]',
        refused: and(onResourceField(HEART, HEART)),
        refuses: 'a held test naming a resource twice',
        rule: RENDERED_NARROWING_RULES.heldTest,
      },
      {
        accepted: and(onResourceField(HEART)),
        accepts: 'a held test naming a literal resource',
        position: 'sqon.content[0]',
        refused: and(onResourceField('HEART*')),
        refuses: 'a held test naming a resource holding a marker',
        rule: RENDERED_NARROWING_RULES.heldTest,
      },
      {
        accepted: and(onResourceField(HEART)),
        accepts: 'a held test naming a string resource',
        position: 'sqon.content[0]',
        refused: and(onResourceField(42)),
        refuses: 'a held test naming a number',
        rule: RENDERED_NARROWING_RULES.heldTest,
      },
      {
        accepted: and(onResourceField(HEART)),
        accepts: 'a held test on a field name',
        position: 'sqon.content[0]',
        refused: and(inClause('', [HEART])),
        refuses: 'a held test on an empty field name',
        rule: RENDERED_NARROWING_RULES.heldTest,
      },
      {
        accepted: and(onResourceField(HEART)),
        accepts: 'a held test written in',
        position: 'sqon.content[0]',
        refused: and({
          content: { fieldName: RESOURCE_FIELD, value: [HEART] },
          op: '=',
        }),
        refuses: 'a held test written =',
        rule: RENDERED_NARROWING_RULES.heldTest,
      },
      {
        accepted: and(onResourceField(HEART)),
        accepts: 'a held test listing its resources',
        position: 'sqon.content[0]',
        refused: and(inClause(RESOURCE_FIELD, HEART)),
        refuses: 'a held test naming its resource without a list',
        rule: RENDERED_NARROWING_RULES.heldTest,
      },
      {
        accepted: narrowingOf(complementOf(REEF)),
        accepts: 'a not around the complement after the held test',
        position: 'sqon.content[1]',
        refused: narrowingOf(onResourceField(REEF)),
        refuses: 'a bare in after the held test',
        rule: RENDERED_NARROWING_RULES.memberKind,
      },
      {
        accepted: narrowingOf(complementOf(REEF)),
        accepts: 'a not holding one test',
        position: 'sqon.content[1]',
        refused: narrowingOf(
          combination('not', onResourceField(REEF), onResourceField(VOID)),
        ),
        refuses: 'a not holding two tests',
        rule: RENDERED_NARROWING_RULES.memberKind,
      },
      {
        accepted: narrowingOf(complementOf(REEF)),
        accepts: 'a not around an in',
        position: 'sqon.content[1]',
        refused: narrowingOf(not(or(onResourceField(REEF)))),
        refuses: 'a not around an or',
        rule: RENDERED_NARROWING_RULES.memberKind,
      },
      {
        accepted: narrowingOf(adultExclusion),
        accepts: 'a not around an and of two members',
        position: 'sqon.content[1]',
        refused: narrowingOf(
          not(
            and(
              onResourceField(HEART),
              or(ADULT, missing('donor_age')),
              CONTROLLED,
            ),
          ),
        ),
        refuses: 'a not around an and of three members',
        rule: RENDERED_NARROWING_RULES.memberKind,
      },
      {
        accepted: narrowingOf(complementOf(REEF), adultExclusion),
        accepts: 'the complement before an exclusion',
        position: 'sqon.content[2]',
        refused: narrowingOf(adultExclusion, complementOf(REEF)),
        refuses: 'the complement after an exclusion',
        rule: RENDERED_NARROWING_RULES.memberOrder,
      },
      {
        accepted: narrowingOf(complementOf(REEF, VOID)),
        accepts: 'one complement',
        position: 'sqon.content[2]',
        refused: narrowingOf(complementOf(REEF), complementOf(VOID)),
        refuses: 'two complements',
        rule: RENDERED_NARROWING_RULES.memberOrder,
      },
      {
        accepted: narrowingOf(adultExclusion, fullUnmarked),
        accepts: 'an exclusion before the unmarked clause',
        position: 'sqon.content[2]',
        refused: narrowingOf(fullUnmarked, adultExclusion),
        refuses: 'an exclusion after the unmarked clause',
        rule: RENDERED_NARROWING_RULES.memberOrder,
      },
      {
        accepted: narrowingOf(fullUnmarked),
        accepts: 'one unmarked clause',
        position: 'sqon.content[2]',
        refused: narrowingOf(fullUnmarked, fullUnmarked),
        refuses: 'two unmarked clauses',
        rule: RENDERED_NARROWING_RULES.memberOrder,
      },
      {
        accepted: narrowingOf(complementOf(REEF)),
        accepts: 'a complement on the resource field',
        position: 'sqon.content[1]',
        refused: narrowingOf(not(inClause('data_category', [REEF]))),
        refuses: 'a complement on another field',
        rule: RENDERED_NARROWING_RULES.complement,
      },
      {
        accepted: narrowingOf(complementOf(REEF)),
        accepts: 'a complement naming no held resource',
        position: 'sqon.content[1]',
        refused: narrowingOf(complementOf(REEF, LUNG)),
        refuses: 'a complement naming a held resource',
        rule: RENDERED_NARROWING_RULES.complement,
      },
      {
        accepted: narrowingOf(complementOf(REEF)),
        accepts: 'a complement listing a resource',
        position: 'sqon.content[1]',
        refused: narrowingOf(complementOf()),
        refuses: 'a complement listing none',
        rule: RENDERED_NARROWING_RULES.complement,
      },
      {
        accepted: narrowingOf(complementOf(REEF, VOID)),
        accepts: 'a complement naming two resources',
        position: 'sqon.content[1]',
        refused: narrowingOf(complementOf(REEF, REEF)),
        refuses: 'a complement naming a resource twice',
        rule: RENDERED_NARROWING_RULES.complement,
      },
      {
        accepted: narrowingOf(complementOf(REEF)),
        accepts: 'a complement naming a literal resource',
        position: 'sqon.content[1]',
        refused: narrowingOf(complementOf('set_id:reef')),
        refuses: 'a complement naming a saved-set reference',
        rule: RENDERED_NARROWING_RULES.complement,
      },
      {
        accepted: narrowingOf(heartPilotExclusion),
        accepts: "an exclusion's lacking list naming a held resource",
        position: 'sqon.content[1]',
        refused: narrowingOf(exclusionOf([REEF], PILOT, missing('cohort'))),
        refuses: "an exclusion's lacking list naming a resource not held",
        rule: RENDERED_NARROWING_RULES.lackingList,
      },
      {
        accepted: narrowingOf(heartPilotExclusion),
        accepts: "an exclusion's lacking list naming a resource",
        position: 'sqon.content[1]',
        refused: narrowingOf(exclusionOf([], PILOT, missing('cohort'))),
        refuses: "an exclusion's lacking list naming none",
        rule: RENDERED_NARROWING_RULES.lackingList,
      },
      {
        accepted: narrowingOf(adultExclusion),
        accepts: "an exclusion's lacking list naming each resource once",
        position: 'sqon.content[1]',
        refused: narrowingOf(
          exclusionOf([HEART, HEART], ADULT, missing('donor_age')),
        ),
        refuses: "an exclusion's lacking list naming a resource twice",
        rule: RENDERED_NARROWING_RULES.lackingList,
      },
      {
        accepted: narrowingOf(heartPilotExclusion),
        accepts: "an exclusion's lacking list on the resource field",
        position: 'sqon.content[1]',
        refused: narrowingOf(
          not(and(inClause('cohort', [HEART]), or(PILOT, missing('cohort')))),
        ),
        refuses: "an exclusion's lacking list on another field",
        rule: RENDERED_NARROWING_RULES.lackingList,
      },
      {
        accepted: narrowingOf(fullUnmarked),
        accepts: "the unmarked clause's lacking list naming held resources",
        position: 'sqon.content[1]',
        refused: narrowingOf(
          unmarkedOf([REEF], CONTROLLED, missing('data_category')),
        ),
        refuses:
          "the unmarked clause's lacking list naming a resource not held",
        rule: RENDERED_NARROWING_RULES.lackingList,
      },
      {
        accepted: narrowingOf(heartPilotExclusion),
        accepts: "an exclusion's or holding one authored condition",
        position: 'sqon.content[1]',
        refused: narrowingOf(
          exclusionOf(
            [HEART],
            PILOT,
            CONTROLLED,
            missing('cohort'),
            missing('data_category'),
          ),
        ),
        refuses: "an exclusion's or holding two authored conditions",
        rule: RENDERED_NARROWING_RULES.exclusion,
      },
      {
        accepted: narrowingOf(heartPilotExclusion),
        accepts: "an exclusion's or holding its authored condition",
        position: 'sqon.content[1]',
        refused: narrowingOf(exclusionOf([HEART], missing('cohort'))),
        refuses: "an exclusion's or holding missing clauses alone",
        rule: RENDERED_NARROWING_RULES.exclusion,
      },
      {
        accepted: narrowingOf(heartPilotExclusion),
        accepts:
          'an exclusion holding a missing clause for the field its condition reads',
        position: 'sqon.content[1]',
        refused: narrowingOf(exclusionOf([HEART], PILOT)),
        refuses:
          'an exclusion lacking the missing clause for a field its condition reads',
        rule: RENDERED_NARROWING_RULES.exclusion,
      },
      {
        accepted: narrowingOf(heartPilotExclusion),
        accepts:
          'an exclusion holding only the missing clauses its condition needs',
        position: 'sqon.content[1]',
        refused: narrowingOf(
          exclusionOf([HEART], PILOT, missing('cohort'), missing('donor_age')),
        ),
        refuses:
          'an exclusion holding a missing clause for a field its condition does not read',
        rule: RENDERED_NARROWING_RULES.exclusion,
      },
      {
        accepted: narrowingOf(heartPilotExclusion),
        accepts: 'an exclusion holding each missing clause once',
        position: 'sqon.content[1]',
        refused: narrowingOf(
          exclusionOf([HEART], PILOT, missing('cohort'), missing('cohort')),
        ),
        refuses: 'an exclusion holding a missing clause twice',
        rule: RENDERED_NARROWING_RULES.exclusion,
      },
      {
        accepted: narrowingOf(heartPilotExclusion),
        accepts: 'a missing clause on a field the condition reads',
        position: 'sqon.content[1]',
        refused: narrowingOf(
          exclusionOf(
            [HEART],
            PILOT,
            missing('cohort'),
            missing(RESOURCE_FIELD),
          ),
        ),
        refuses: 'a missing clause on the resource field',
        rule: RENDERED_NARROWING_RULES.missingClause,
      },
      {
        accepted: narrowingOf(heartPilotExclusion),
        accepts: 'a missing clause naming its field',
        position: 'sqon.content[1]',
        refused: narrowingOf(
          exclusionOf([HEART], PILOT, missing('cohort'), missing('')),
        ),
        refuses: 'a missing clause on an empty field name',
        rule: RENDERED_NARROWING_RULES.missingClause,
      },
      {
        accepted: narrowingOf(heartPilotExclusion),
        accepts: 'a missing clause carrying only fieldName and value',
        position: 'sqon.content[1]',
        refused: narrowingOf(
          exclusionOf([HEART], PILOT, {
            content: {
              fieldName: 'cohort',
              note: 'none',
              value: ['__missing__'],
            },
            op: 'in',
          }),
        ),
        refuses: 'a missing clause carrying another member',
        rule: RENDERED_NARROWING_RULES.structuralNode,
      },
      {
        accepted: narrowingOf(heartPilotExclusion),
        accepts: 'an authored condition held to the grammar',
        position: 'sqon.content[1]',
        refused: narrowingOf(
          exclusionOf(
            [HEART],
            {
              content: { fieldName: 'cohort', value: ['pilot'] },
              op: 'not-in',
            },
            missing('cohort'),
          ),
        ),
        refuses: 'an authored condition holding an exclusion operator',
        rule: RENDERED_NARROWING_RULES.conditions,
      },
      {
        accepted: narrowingOf(heartPilotExclusion),
        accepts: "an exclusion's authored condition listing literal values",
        position: 'sqon.content[1]',
        refused: narrowingOf(
          exclusionOf(
            [HEART],
            inClause('cohort', ['pilot', '__missing__']),
            missing('cohort'),
          ),
        ),
        refuses:
          "an exclusion's authored condition listing the missing-field marker",
        rule: RENDERED_NARROWING_RULES.conditions,
      },
      {
        accepted: narrowingOf(fullUnmarked),
        accepts: 'a global condition held to the grammar',
        position: 'sqon.content[1]',
        refused: narrowingOf(
          unmarkedOf([LUNG], or(), missing('data_category')),
        ),
        refuses: 'a global condition that is an empty or',
        rule: RENDERED_NARROWING_RULES.conditions,
      },
      {
        accepted: narrowingOf(fullUnmarked),
        accepts: 'a scoped condition held to the grammar',
        position: 'sqon.content[1]',
        refused: narrowingOf(
          unmarkedOf(
            [HEART],
            and(
              scopedOf(HEART, inClause('cohort', ['pil*']), missing('cohort')),
            ),
          ),
        ),
        refuses: 'a scoped condition listing a pattern',
        rule: RENDERED_NARROWING_RULES.conditions,
      },
      {
        accepted: narrowingOf(fullUnmarked),
        accepts: 'a global condition listing literal values',
        position: 'sqon.content[1]',
        refused: narrowingOf(
          unmarkedOf(
            [LUNG],
            inClause('data_category', ['controlled', '__missing__']),
            missing('data_category'),
          ),
        ),
        refuses: 'a global condition listing the missing-field marker',
        rule: RENDERED_NARROWING_RULES.conditions,
      },
      {
        accepted: narrowingOf(fullUnmarked),
        accepts: 'a scoped condition listing literal values',
        position: 'sqon.content[1]',
        refused: narrowingOf(
          unmarkedOf(
            [HEART],
            and(
              scopedOf(
                HEART,
                inClause('cohort', ['pilot', '__missing__']),
                missing('cohort'),
              ),
            ),
          ),
        ),
        refuses: 'a scoped condition listing the missing-field marker',
        rule: RENDERED_NARROWING_RULES.conditions,
      },
      {
        accepted: narrowingOf(heartPilotExclusion),
        accepts: 'an authored condition reading other fields',
        position: 'sqon.content[1]',
        refused: narrowingOf(
          exclusionOf(
            [HEART],
            and(PILOT, onResourceField(LUNG)),
            missing('cohort'),
            missing(RESOURCE_FIELD),
          ),
        ),
        refuses: 'an authored condition reading the resource field',
        rule: RENDERED_NARROWING_RULES.resourceFieldUnread,
      },
      {
        accepted: narrowingOf(fullUnmarked),
        accepts: 'a global condition reading other fields',
        position: 'sqon.content[1]',
        refused: narrowingOf(
          unmarkedOf(
            [LUNG],
            or(CONTROLLED, onResourceField(LUNG)),
            missing('data_category'),
          ),
        ),
        refuses: 'a global condition reading the resource field',
        rule: RENDERED_NARROWING_RULES.resourceFieldUnread,
      },
      {
        accepted: narrowingOf(
          unmarkedOf([LUNG], CONTROLLED, missing('data_category')),
        ),
        accepts: "the unmarked clause's or holding a member",
        position: 'sqon.content[1]',
        refused: narrowingOf(unmarkedOf([LUNG])),
        refuses: "the unmarked clause's or holding none",
        rule: RENDERED_NARROWING_RULES.unmarked,
      },
      {
        accepted: narrowingOf(
          unmarkedOf([LUNG], CONTROLLED, missing('data_category')),
        ),
        accepts: 'the unmarked clause negating an or',
        position: 'sqon.content[1]',
        refused: narrowingOf(not(and(onResourceField(LUNG), not(CONTROLLED)))),
        refuses: 'the unmarked clause negating an in',
        rule: RENDERED_NARROWING_RULES.unmarked,
      },
      {
        accepted: narrowingOf(
          unmarkedOf([LUNG], CONTROLLED, missing('data_category')),
        ),
        accepts:
          'the unmarked clause holding the missing clause for each global field',
        position: 'sqon.content[1]',
        refused: narrowingOf(unmarkedOf([LUNG], CONTROLLED)),
        refuses:
          'the unmarked clause lacking the missing clause for a global field',
        rule: RENDERED_NARROWING_RULES.unmarked,
      },
      {
        accepted: narrowingOf(
          unmarkedOf([LUNG], CONTROLLED, missing('data_category')),
        ),
        accepts:
          'the unmarked clause holding missing clauses for global fields only',
        position: 'sqon.content[1]',
        refused: narrowingOf(
          unmarkedOf(
            [LUNG],
            CONTROLLED,
            missing('data_category'),
            missing('cohort'),
          ),
        ),
        refuses:
          'the unmarked clause holding a missing clause for a field no global condition reads',
        rule: RENDERED_NARROWING_RULES.unmarked,
      },
      {
        accepted: narrowingOf(fullUnmarked),
        accepts: 'one test that every lacking resource is categorized',
        position: 'sqon.content[1]',
        refused: narrowingOf(
          unmarkedOf(
            [HEART],
            and(scopedOf(HEART, PILOT, missing('cohort'))),
            and(scopedOf(HEART, PILOT, missing('cohort'))),
          ),
        ),
        refuses: 'two tests that every lacking resource is categorized',
        rule: RENDERED_NARROWING_RULES.unmarked,
      },
      {
        accepted: narrowingOf(fullUnmarked),
        accepts: 'a categorized test naming every lacking resource once',
        position: 'sqon.content[1]',
        refused: narrowingOf(
          unmarkedOf(
            [HEART, LUNG],
            CONTROLLED,
            missing('data_category'),
            and(scopedOf(HEART, PILOT, missing('cohort'))),
          ),
        ),
        refuses: 'a categorized test leaving a lacking resource out',
        rule: RENDERED_NARROWING_RULES.everyCategorized,
      },
      {
        accepted: narrowingOf(fullUnmarked),
        accepts: 'a categorized test naming only lacking resources',
        position: 'sqon.content[1]',
        refused: narrowingOf(
          unmarkedOf(
            [HEART],
            CONTROLLED,
            missing('data_category'),
            and(
              not(onResourceField(LUNG)),
              scopedOf(HEART, PILOT, missing('cohort')),
            ),
          ),
        ),
        refuses: 'a categorized test naming a resource that is not lacking',
        rule: RENDERED_NARROWING_RULES.everyCategorized,
      },
      {
        accepted: narrowingOf(fullUnmarked),
        accepts: 'a categorized test naming each resource once',
        position: 'sqon.content[1]',
        refused: narrowingOf(
          unmarkedOf(
            [HEART, LUNG],
            CONTROLLED,
            missing('data_category'),
            and(
              not(onResourceField(LUNG, HEART)),
              scopedOf(HEART, PILOT, missing('cohort')),
            ),
          ),
        ),
        refuses: 'a categorized test naming a resource twice',
        rule: RENDERED_NARROWING_RULES.everyCategorized,
      },
      {
        accepted: narrowingOf(fullUnmarked),
        accepts: "a categorized test holding a resource's own test",
        position: 'sqon.content[1]',
        refused: narrowingOf(
          unmarkedOf(
            [LUNG],
            CONTROLLED,
            missing('data_category'),
            and(not(onResourceField(LUNG))),
          ),
        ),
        refuses: "a categorized test holding no resource's own test",
        rule: RENDERED_NARROWING_RULES.everyCategorized,
      },
      {
        accepted: narrowingOf(fullUnmarked),
        accepts:
          'a categorized test holding one test of the resources with no categories of their own',
        position: 'sqon.content[1]',
        refused: narrowingOf(
          unmarkedOf(
            [HEART, LUNG],
            CONTROLLED,
            missing('data_category'),
            and(
              not(onResourceField(LUNG)),
              not(onResourceField(LUNG)),
              scopedOf(HEART, PILOT, missing('cohort')),
            ),
          ),
        ),
        refuses:
          'a categorized test holding two tests of the resources with no categories of their own',
        rule: RENDERED_NARROWING_RULES.everyCategorized,
      },
      {
        accepted: narrowingOf(fullUnmarked),
        accepts: 'a categorized test holding nots and ors only',
        position: 'sqon.content[1]',
        refused: narrowingOf(
          unmarkedOf(
            [HEART, LUNG],
            CONTROLLED,
            missing('data_category'),
            and(
              not(onResourceField(LUNG)),
              scopedOf(HEART, PILOT, missing('cohort')),
              PILOT,
            ),
          ),
        ),
        refuses: 'a categorized test holding an authored condition of its own',
        rule: RENDERED_NARROWING_RULES.everyCategorized,
      },
      {
        accepted: narrowingOf(fullUnmarked),
        accepts: "a resource's own test scoped to one resource",
        position: 'sqon.content[1]',
        refused: narrowingOf(
          unmarkedOf(
            [HEART, LUNG],
            and(
              or(not(onResourceField(HEART, LUNG)), PILOT, missing('cohort')),
            ),
          ),
        ),
        refuses: "a resource's own test scoped to two resources",
        rule: RENDERED_NARROWING_RULES.scopedTest,
      },
      {
        accepted: narrowingOf(fullUnmarked),
        accepts: "a resource's own test holding an authored condition",
        position: 'sqon.content[1]',
        refused: narrowingOf(
          unmarkedOf(
            [HEART, LUNG],
            CONTROLLED,
            missing('data_category'),
            and(not(onResourceField(LUNG)), scopedOf(HEART)),
          ),
        ),
        refuses: "a resource's own test holding no authored condition",
        rule: RENDERED_NARROWING_RULES.scopedTest,
      },
      {
        accepted: narrowingOf(fullUnmarked),
        accepts: "a resource's own test holding one scope",
        position: 'sqon.content[1]',
        refused: narrowingOf(
          unmarkedOf(
            [HEART, LUNG],
            and(
              or(
                not(onResourceField(HEART)),
                not(onResourceField(LUNG)),
                PILOT,
                missing('cohort'),
              ),
            ),
          ),
        ),
        refuses: "a resource's own test holding two scopes",
        rule: RENDERED_NARROWING_RULES.scopedTest,
      },
      {
        accepted: narrowingOf(fullUnmarked),
        accepts:
          "a resource's own test holding the missing clause for each field its conditions read",
        position: 'sqon.content[1]',
        refused: narrowingOf(unmarkedOf([HEART], and(scopedOf(HEART, PILOT)))),
        refuses:
          "a resource's own test lacking the missing clause for a field its condition reads",
        rule: RENDERED_NARROWING_RULES.scopedTest,
      },
      {
        accepted: narrowingOf(fullUnmarked),
        accepts:
          "a resource's own test holding missing clauses for its own fields only",
        position: 'sqon.content[1]',
        refused: narrowingOf(
          unmarkedOf(
            [HEART],
            and(
              scopedOf(HEART, PILOT, missing('cohort'), missing('donor_age')),
            ),
          ),
        ),
        refuses:
          "a resource's own test holding a missing clause for a field none of its conditions reads",
        rule: RENDERED_NARROWING_RULES.scopedTest,
      },
    ];

    for (const {
      accepted,
      accepts,
      position,
      refused,
      refuses,
      rule,
    } of cases) {
      test(`accepts ${accepts}`, () => {
        const result = parseRecordNarrowing(accepted);

        assertAccepted(result);
      });

      test(`refuses ${refuses}`, () => {
        const result = parseRecordNarrowing(refused);

        assertRefusedFor(result, position, rule);
      });
    }

    for (const [description, sqon] of [
      ['null', null],
      ['a number', 42],
      ['a string', 'and'],
      [
        'nesting far past any usable depth in an authored condition',
        narrowingOf(
          exclusionOf(
            [HEART],
            Array.from({ length: 10_000 }).reduce<unknown>(
              (inner) => not(inner),
              PILOT,
            ),
            missing('cohort'),
          ),
        ),
      ],
    ] as const) {
      test(`refuses ${description}, returning the refusal rather than throwing`, () => {
        const result = parseRecordNarrowing(sqon);

        assert.equal(result.success, false);
      });
    }

    test('refuses a filter holding a getter that throws, returning the refusal rather than throwing', () => {
      const sqon = Object.defineProperty({ op: 'and' }, 'content', {
        enumerable: true,
        get: (): never => {
          throw new Error('unreadable');
        },
      });

      const result = parseRecordNarrowing(sqon);

      assertRefusedFor(result, 'sqon', READ_RULE);
    });

    test('reads the filter once, parsing exactly what it checked', () => {
      const reads = { count: 0 };
      const sqon = Object.defineProperty({ op: 'and' }, 'content', {
        enumerable: true,
        get: (): unknown => {
          reads.count += 1;

          return reads.count === 1 ? [onResourceField(HEART)] : [];
        },
      });

      const result = parseRecordNarrowing(sqon);

      assert.equal(reads.count, 1);
      assert.deepEqual(result.success && result.narrowing.held, [HEART]);
    });
  });

  suite('what problems carry', () => {
    /** The words fixed by the contract, carried unmarked by a leak input. */
    const CONTRACT_WORDS: ReadonlySet<string> = new Set([
      '',
      '=',
      '__missing__',
      'and',
      'content',
      'fieldName',
      'gte',
      'in',
      'not',
      'not-in',
      'op',
      'or',
      'pivot',
      'value',
    ]);

    const field = `${LEAK_MARKER}_resource_field`;
    const heldResource = `${LEAK_MARKER}_held`;
    const otherResource = `${LEAK_MARKER}_other`;
    const conditionField = `${LEAK_MARKER}_field`;
    const markedIn = (fieldName: string, ...values: readonly unknown[]): Node =>
      inClause(fieldName, values);
    const markedCondition = markedIn(conditionField, `${LEAK_MARKER}_value`);
    const markedMissing = missing(conditionField);
    const markedLacking = markedIn(field, heldResource);
    const markedExclusion = (...members: readonly unknown[]): Node =>
      not(and(markedLacking, or(...members)));
    const markedUnmarked = (...members: readonly unknown[]): Node =>
      not(and(markedLacking, not(or(...members))));
    const markedScoped = (...members: readonly unknown[]): Node =>
      or(not(markedIn(field, heldResource)), ...members);
    const markedNarrowing = (...members: readonly unknown[]): Node =>
      and(markedIn(field, heldResource), ...members);

    const leakCases: readonly {
      description: string;
      input: unknown;
      position: string;
      rule: string;
    }[] = [
      {
        description: 'a complement naming a held resource',
        input: markedNarrowing(not(markedIn(field, heldResource))),
        position: 'sqon.content[1]',
        rule: RENDERED_NARROWING_RULES.complement,
      },
      {
        description: 'an authored condition outside the grammar',
        input: markedNarrowing(
          markedExclusion(
            {
              content: {
                fieldName: conditionField,
                value: [`${LEAK_MARKER}_value`],
              },
              op: 'not-in',
            },
            markedMissing,
          ),
        ),
        position: 'sqon.content[1]',
        rule: RENDERED_NARROWING_RULES.conditions,
      },
      {
        description: 'a categorized test leaving a lacking resource out',
        input: and(
          markedIn(field, heldResource, otherResource),
          not(
            and(
              markedIn(field, heldResource, otherResource),
              not(or(and(markedScoped(markedCondition, markedMissing)))),
            ),
          ),
        ),
        position: 'sqon.content[1]',
        rule: RENDERED_NARROWING_RULES.everyCategorized,
      },
      {
        description: 'an exclusion holding two authored conditions',
        input: markedNarrowing(
          markedExclusion(
            markedCondition,
            {
              content: { fieldName: conditionField, value: LEAK_NUMBER },
              op: 'gte',
            },
            markedMissing,
          ),
        ),
        position: 'sqon.content[1]',
        rule: RENDERED_NARROWING_RULES.exclusion,
      },
      {
        description: 'a held test naming a resource twice',
        input: and(markedIn(field, heldResource, heldResource)),
        position: 'sqon.content[0]',
        rule: RENDERED_NARROWING_RULES.heldTest,
      },
      {
        description: 'a lacking list naming a resource not held',
        input: markedNarrowing(
          not(
            and(
              markedIn(field, otherResource),
              or(markedCondition, markedMissing),
            ),
          ),
        ),
        position: 'sqon.content[1]',
        rule: RENDERED_NARROWING_RULES.lackingList,
      },
      {
        description: 'a bare in after the held test',
        input: markedNarrowing(markedIn(field, otherResource)),
        position: 'sqon.content[1]',
        rule: RENDERED_NARROWING_RULES.memberKind,
      },
      {
        description: 'two complements',
        input: markedNarrowing(
          not(markedIn(field, otherResource)),
          not(markedIn(field, `${LEAK_MARKER}_third`)),
        ),
        position: 'sqon.content[2]',
        rule: RENDERED_NARROWING_RULES.memberOrder,
      },
      {
        description: 'a missing clause on the resource field',
        input: markedNarrowing(
          markedExclusion(markedCondition, markedMissing, missing(field)),
        ),
        position: 'sqon.content[1]',
        rule: RENDERED_NARROWING_RULES.missingClause,
      },
      {
        description: 'an authored condition reading the resource field',
        input: markedNarrowing(
          markedExclusion(
            and(markedCondition, markedIn(field, otherResource)),
            markedMissing,
            missing(field),
          ),
        ),
        position: 'sqon.content[1]',
        rule: RENDERED_NARROWING_RULES.resourceFieldUnread,
      },
      {
        description: 'a root that is an or',
        input: or(markedIn(field, heldResource)),
        position: 'sqon',
        rule: RENDERED_NARROWING_RULES.root,
      },
      {
        description: "a resource's own test holding no authored condition",
        input: markedNarrowing(markedUnmarked(and(markedScoped()))),
        position: 'sqon.content[1]',
        rule: RENDERED_NARROWING_RULES.scopedTest,
      },
      {
        description: 'a root carrying a pivot',
        input: { ...markedNarrowing(), pivot: `${LEAK_MARKER}_pivot` },
        position: 'sqon',
        rule: RENDERED_NARROWING_RULES.structuralNode,
      },
      {
        description: "the unmarked clause's or holding nothing",
        input: markedNarrowing(markedUnmarked()),
        position: 'sqon.content[1]',
        rule: RENDERED_NARROWING_RULES.unmarked,
      },
    ];

    for (const { description, input, position, rule } of leakCases) {
      test(`names no content of the filter in the problems for ${description}`, () => {
        assertInputMarked(input, CONTRACT_WORDS);

        const result = parseRecordNarrowing(input);

        assertRefusedFor(result, position, rule);
        assertCarriesNoInput(result);
      });
    }

    test('names no content of an error thrown by a getter while the filter is read', () => {
      const sqon = Object.defineProperty({ op: 'and' }, 'content', {
        enumerable: true,
        get: (): never => {
          throw new Error(`${LEAK_MARKER}_thrown`);
        },
      });

      const result = parseRecordNarrowing(sqon);

      assertRefusedFor(result, 'sqon', READ_RULE);
      assertCarriesNoInput(result);
    });

    test('breaks every rule it holds, between the filters above', () => {
      const cases = leakCases;

      assertEveryRuleBroken(cases, RENDERED_NARROWING_RULES);
    });
  });
});
