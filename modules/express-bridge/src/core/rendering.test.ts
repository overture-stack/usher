import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suite, test } from 'node:test';

import {
  type CategoryCondition,
  type Enforcement,
  type KeyRegistration,
  type ParsedRecordNarrowing,
  type PermissionsPayload,
  parseRecordNarrowing,
  type RecordKeyRegistration,
  type ResourcePermissions,
  validateEnforcement,
  validatePayload,
  validateRegistration,
} from '@overture-stack/usher-types';

// Read from usher-types' source by path: the evaluator is test-only, so no package exports it.
import { matchesSqon } from '../../../types/src/sqonEvaluator.js';

import { CONFIGURATION_DEFAULTS } from './configuration.js';
import { filterClauseCount, guardedNarrowing } from './guards.js';
import {
  compileKey,
  type KeyRendering,
  renderKey,
  unenforcedEntries,
} from './rendering.js';

const corpus = JSON.parse(
  readFileSync(
    new URL(
      '../../../../.dev/design/conformance/principals.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  principals: readonly {
    case: string;
    configuration?: string;
    payload: unknown;
  }[];
};

const payloadFor = (caseNumber: string): PermissionsPayload => {
  const entry = corpus.principals.find(
    (principal) => principal.case === caseNumber,
  );
  const result = validatePayload(entry?.payload);
  assert.ok(result.success, `case ${caseNumber} is a valid payload`);
  return result.payload;
};

/**
 * `base` with `permissions` in place of its own, its `resourceCategories` and `servedResources`
 * kept consistent with them.
 */
const withPermissions = (
  base: PermissionsPayload,
  permissions: PermissionsPayload['permissions'],
  ownCategories: PermissionsPayload['resourceCategories'] = {},
): PermissionsPayload => ({
  ...base,
  permissions,
  resourceCategories: Object.fromEntries(
    Object.keys(permissions).map((resource) => [
      resource,
      ownCategories[resource] ?? [],
    ]),
  ),
  servedResources: Array.from(
    new Set([...base.servedResources, ...Object.keys(permissions)]),
  ),
});

const HEART = 'HEART_STUDY';
const LUNG = 'LUNG_COHORT';
const REEF = 'REEF_ARCHIVE';
const OTHER = 'OTHER_STUDY';
const VOID = 'VOID_INDEX';
const ALL_THREE = [HEART, LUNG, REEF];

const inCondition = (
  fieldName: string,
  value: readonly string[],
): CategoryCondition => ({
  content: { fieldName, value: [...value] },
  op: 'in',
});

const COMMUNITY_GOVERNED = inCondition('data_category', ['community-governed']);
const CONTROLLED = inCondition('data_category', ['controlled']);
const EMBARGOED = inCondition('embargo_status', ['embargoed']);
const PILOT = inCondition('cohort', ['pilot']);

/** The synthetic catalogue of step 1's fixture rows. */
const catalogue: RecordKeyRegistration = {
  categories: {
    global: {
      'global.community-governed': COMMUNITY_GOVERNED,
      'global.controlled': CONTROLLED,
    },
  },
  kind: 'record',
  resourceFieldName: 'study_id',
};

const withPilot: RecordKeyRegistration = {
  ...catalogue,
  categories: {
    ...catalogue.categories,
    resource: { [HEART]: { 'resource.pilot': PILOT } },
  },
};

const NO_GRANTS: Enforcement = { kind: 'deny', reason: 'no-grants' };

const UNKNOWN_RESOURCE: Enforcement = {
  kind: 'deny',
  reason: 'unknown-resource',
};

const UNMAPPED_CATEGORY: Enforcement = {
  kind: 'deny',
  reason: 'unmapped-category',
};

/** A key's rendering, from its registration validated and compiled as the core holds it. */
const rendered = (
  payload: PermissionsPayload,
  registration: KeyRegistration,
  filterClauseLimit = CONFIGURATION_DEFAULTS.filterClauseLimit,
): KeyRendering => {
  const validated = validateRegistration(registration);

  if (validated.success) {
    return renderKey(
      payload,
      compileKey(validated.registration),
      filterClauseLimit,
    );
  }

  return assert.fail(
    `the test's registration is refused: ${JSON.stringify(validated.problems)}`,
  );
};

/** What a record key's narrowing says, read back through usher-types' structural parse. */
const readBack = (enforcement: Enforcement): ParsedRecordNarrowing => {
  if (enforcement.kind === 'narrow') {
    const parsed = parseRecordNarrowing(enforcement.sqon);

    if (parsed.success) {
      return parsed.narrowing;
    }

    return assert.fail(
      `the narrowing does not read back: ${JSON.stringify(parsed.problems)}`,
    );
  }

  return assert.fail(`expected a narrowing, got ${enforcement.kind}`);
};

const exclusion = (
  condition: CategoryCondition,
  ...lacking: readonly string[]
): { condition: CategoryCondition; lacking: readonly string[] } => ({
  condition,
  lacking,
});

/**
 * The read-back expected of a record key on `study_id`. The complement defaults to VOID_INDEX
 * because every corpus payload of the case table's configuration serves it and none holds it.
 */
const narrowingOf = ({
  complement = [VOID],
  exclusions = [],
  held,
  unmarked,
}: {
  complement?: readonly string[];
  exclusions?: readonly unknown[];
  held: readonly string[];
  unmarked?: unknown;
}): unknown => ({
  complement,
  exclusions,
  held,
  resourceFieldName: 'study_id',
  ...(unmarked === undefined ? {} : { unmarked }),
});

const inLeaf = (fieldName: string, value: readonly string[]): unknown => ({
  content: { fieldName, value },
  op: 'in',
});

/**
 * Record view on one study's unmarked records and on every global category defined by the case
 * table's configuration.
 */
const WHOLLY_VIEWED: ResourcePermissions = {
  'global.community-governed': { record: ['view'] },
  'global.controlled': { record: ['view'] },
  'global.unmarked': { record: ['view'] },
};

/** Every study viewed wholly, since a global category applies to every study whose records match. */
const everyCategoryViewed: PermissionsPayload['permissions'] = {
  [HEART]: WHOLLY_VIEWED,
  [LUNG]: WHOLLY_VIEWED,
  [REEF]: WHOLLY_VIEWED,
};

const UNMARKED_VIEWED: ResourcePermissions = {
  'global.unmarked': { record: ['view'] },
};

suite('renderKey', () => {
  suite("step 1's rows, rendered from the case table", () => {
    test('denies an anonymous principal when the baseline grants nothing (case 1)', () => {
      const rendering = rendered(payloadFor('01'), catalogue);

      assert.deepEqual(rendering, {
        enforcement: NO_GRANTS,
        unknown: [],
        unmapped: [],
      });
    });

    test('narrows an anonymous principal to the unmarked records of every study, excluding each category from all of them (case 2)', () => {
      const rendering = rendered(payloadFor('02'), catalogue);

      assert.deepEqual(
        readBack(rendering.enforcement),
        narrowingOf({
          exclusions: [
            exclusion(COMMUNITY_GOVERNED, ...ALL_THREE),
            exclusion(CONTROLLED, ...ALL_THREE),
          ],
          held: ALL_THREE,
        }),
      );
    });

    test("serves HEART_STUDY's controlled records to a principal holding them, excluding them from the other studies (case 5)", () => {
      const rendering = rendered(payloadFor('05'), catalogue);

      assert.deepEqual(
        readBack(rendering.enforcement),
        narrowingOf({
          exclusions: [
            exclusion(COMMUNITY_GOVERNED, ...ALL_THREE),
            exclusion(CONTROLLED, LUNG, REEF),
          ],
          held: ALL_THREE,
        }),
      );
    });

    test("serves REEF_ARCHIVE's controlled records alone, not its community-governed ones (case 9)", () => {
      const rendering = rendered(payloadFor('09'), catalogue);

      assert.deepEqual(
        readBack(rendering.enforcement),
        narrowingOf({
          exclusions: [
            exclusion(COMMUNITY_GOVERNED, ...ALL_THREE),
            exclusion(CONTROLLED, HEART, LUNG),
          ],
          held: ALL_THREE,
        }),
      );
    });

    test('withholds every HEART_STUDY record when its unmarked records are by grant and unheld (case 19)', () => {
      const rendering = rendered(payloadFor('19'), catalogue);

      assert.deepEqual(
        readBack(rendering.enforcement),
        narrowingOf({
          complement: [HEART, VOID],
          exclusions: [
            exclusion(COMMUNITY_GOVERNED, LUNG, REEF),
            exclusion(CONTROLLED, LUNG, REEF),
          ],
          held: [LUNG, REEF],
        }),
      );
    });

    test('renders no exclusion and no unmarked clause for a principal holding every category on every study', () => {
      const rendering = rendered(
        withPermissions(payloadFor('05'), everyCategoryViewed),
        catalogue,
      );

      assert.deepEqual(
        readBack(rendering.enforcement),
        narrowingOf({ held: ALL_THREE }),
      );
    });

    test('allows a key open by configuration', () => {
      const rendering = rendered(payloadFor('05'), { kind: 'open' });

      assert.deepEqual(rendering, {
        enforcement: { kind: 'allow' },
        unknown: [],
        unmapped: [],
      });
    });
  });

  suite('which grants hold a resource', () => {
    test('counts no entry carrying field, so a study held only through one falls into the complement (case 24)', () => {
      const rendering = rendered(payloadFor('24'), catalogue);

      assert.deepEqual(
        readBack(rendering.enforcement),
        narrowingOf({
          complement: [HEART, VOID],
          exclusions: [
            exclusion(COMMUNITY_GOVERNED, LUNG, REEF),
            exclusion(CONTROLLED, LUNG, REEF),
          ],
          held: [LUNG, REEF],
        }),
      );
    });

    test('counts an entry holding record view beside other entities (case 27)', () => {
      const rendering = rendered(payloadFor('27'), catalogue);

      assert.deepEqual(readBack(rendering.enforcement).held, ALL_THREE);
    });

    test('counts no entry holding artifact actions alone, and denies where it was the only entry', () => {
      const rendering = rendered(
        withPermissions(payloadFor('05'), {
          [LUNG]: { 'global.unmarked': { artifact: ['view'] } },
        }),
        catalogue,
      );

      assert.deepEqual(rendering.enforcement, NO_GRANTS);
    });

    test('counts no entry holding record count alone, and denies where it was the only entry', () => {
      const rendering = rendered(
        withPermissions(payloadFor('05'), {
          [LUNG]: { 'global.unmarked': { record: ['count'] } },
        }),
        catalogue,
      );

      assert.deepEqual(rendering.enforcement, NO_GRANTS);
    });

    test('leaves a study out of the held resources when its grants apply to no category the key defines, so it falls into the complement', () => {
      const rendering = rendered(
        withPermissions(payloadFor('05'), {
          [HEART]: { 'global.community-governed': { record: ['view'] } },
          [LUNG]: UNMARKED_VIEWED,
        }),
        {
          absentCategories: ['global.community-governed'],
          categories: { global: { 'global.controlled': CONTROLLED } },
          kind: 'record',
          resourceFieldName: 'study_id',
        },
      );

      assert.deepEqual(
        readBack(rendering.enforcement),
        narrowingOf({
          complement: [HEART, REEF, VOID],
          exclusions: [exclusion(CONTROLLED, LUNG)],
          held: [LUNG],
        }),
      );
    });
  });

  suite('the global check', () => {
    for (const caseNumber of ['01', '05']) {
      test(`denies the whole key with unmapped-category when the payload lists a global category the key neither defines nor declares absent, whatever is held (case ${caseNumber})`, () => {
        const rendering = rendered(payloadFor(caseNumber), {
          categories: { global: { 'global.controlled': CONTROLLED } },
          kind: 'record',
          resourceFieldName: 'study_id',
        });

        assert.deepEqual(rendering, {
          enforcement: UNMAPPED_CATEGORY,
          unknown: [],
          unmapped: [{ category: 'global.community-governed' }],
        });
      });
    }

    test('renders a key declaring that category absent, with no exclusion for it and no gap', () => {
      const rendering = rendered(payloadFor('05'), {
        absentCategories: ['global.community-governed'],
        categories: { global: { 'global.controlled': CONTROLLED } },
        kind: 'record',
        resourceFieldName: 'study_id',
      });

      assert.deepEqual(rendering.unmapped, []);
      assert.deepEqual(
        readBack(rendering.enforcement),
        narrowingOf({
          exclusions: [exclusion(CONTROLLED, LUNG, REEF)],
          held: ALL_THREE,
        }),
      );
    });

    test('renders only the resource test for a key declaring every global category absent', () => {
      const rendering = rendered(payloadFor('02'), {
        absentCategories: ['global.community-governed', 'global.controlled'],
        categories: { global: {} },
        kind: 'record',
        resourceFieldName: 'study_id',
      });

      assert.deepEqual(rendering, {
        enforcement: {
          kind: 'narrow',
          sqon: {
            content: [
              inLeaf('study_id', ALL_THREE),
              { content: [inLeaf('study_id', [VOID])], op: 'not' },
            ],
            op: 'and',
          },
        },
        unknown: [],
        unmapped: [],
      });
    });

    test('names a global category the key defines and the payload does not list as unknown, and excludes its records everywhere', () => {
      const rendering = rendered(payloadFor('05'), {
        ...catalogue,
        categories: {
          global: {
            ...catalogue.categories.global,
            'global.embargoed': EMBARGOED,
          },
        },
      });

      assert.deepEqual(rendering.unknown, [{ category: 'global.embargoed' }]);
      assert.deepEqual(rendering.unmapped, []);
      assert.deepEqual(readBack(rendering.enforcement).exclusions, [
        exclusion(COMMUNITY_GOVERNED, ...ALL_THREE),
        exclusion(CONTROLLED, LUNG, REEF),
        exclusion(EMBARGOED, ...ALL_THREE),
      ]);
    });
  });

  suite('resource categories', () => {
    test('names a resource category the key defines and the payload does not list for its resource as unknown, and excludes its records there', () => {
      // Given a key defining resource.pilot under HEART_STUDY, and a payload naming HEART_STUDY
      // with no resource category of its own
      const rendering = rendered(payloadFor('05'), withPilot);

      // Then the category is unknown for that resource, and its records are excluded there
      assert.deepEqual(rendering.unknown, [
        { category: 'resource.pilot', resourceId: HEART },
      ]);
      assert.ok(
        readBack(rendering.enforcement).exclusions.some(
          ({ condition, lacking }) =>
            JSON.stringify(condition) === JSON.stringify(PILOT) &&
            JSON.stringify(lacking) === JSON.stringify([HEART]),
        ),
      );
    });

    test('serves the records of a held resource category, excluding only the categories not held', () => {
      const rendering = rendered(
        withPermissions(
          payloadFor('05'),
          {
            [HEART]: {
              'global.unmarked': { record: ['view'] },
              'resource.pilot': { record: ['view'] },
            },
            [LUNG]: UNMARKED_VIEWED,
          },
          { [HEART]: ['resource.pilot'] },
        ),
        withPilot,
      );

      assert.deepEqual(
        readBack(rendering.enforcement),
        narrowingOf({
          complement: [REEF, VOID],
          exclusions: [
            exclusion(COMMUNITY_GOVERNED, HEART, LUNG),
            exclusion(CONTROLLED, HEART, LUNG),
          ],
          held: [HEART, LUNG],
        }),
      );
    });

    test('excludes an unheld resource category from its own resource alone', () => {
      const rendering = rendered(
        withPermissions(
          payloadFor('05'),
          { [HEART]: UNMARKED_VIEWED, [LUNG]: UNMARKED_VIEWED },
          { [HEART]: ['resource.pilot'] },
        ),
        withPilot,
      );

      assert.deepEqual(rendering.unmapped, []);
      assert.deepEqual(readBack(rendering.enforcement).exclusions, [
        exclusion(COMMUNITY_GOVERNED, HEART, LUNG),
        exclusion(CONTROLLED, HEART, LUNG),
        exclusion(PILOT, HEART),
      ]);
    });

    test('serves a resource held only through its own category, its unmarked records withheld unless they carry one of its categories', () => {
      const rendering = rendered(
        withPermissions(
          payloadFor('05'),
          { [HEART]: { 'resource.pilot': { record: ['view'] } } },
          { [HEART]: ['resource.pilot'] },
        ),
        withPilot,
      );

      assert.deepEqual(
        readBack(rendering.enforcement),
        narrowingOf({
          complement: [LUNG, REEF, VOID],
          exclusions: [
            exclusion(COMMUNITY_GOVERNED, HEART),
            exclusion(CONTROLLED, HEART),
          ],
          held: [HEART],
          unmarked: {
            globalConditions: [COMMUNITY_GOVERNED, CONTROLLED],
            lacking: [HEART],
            scopedConditions: [{ condition: PILOT, resource: HEART }],
          },
        }),
      );
    });

    test('withholds a resource offering a resource category the key does not define, leaving it to the complement', () => {
      const rendering = rendered(
        withPermissions(
          payloadFor('05'),
          {
            [HEART]: {
              'global.unmarked': { record: ['view'] },
              'resource.pilot': { record: ['view'] },
            },
            [LUNG]: UNMARKED_VIEWED,
          },
          { [HEART]: ['resource.pilot'] },
        ),
        catalogue,
      );

      assert.deepEqual(rendering.unmapped, [
        { category: 'resource.pilot', resourceId: HEART },
      ]);
      assert.deepEqual(
        readBack(rendering.enforcement),
        narrowingOf({
          complement: [HEART, REEF, VOID],
          exclusions: [
            exclusion(COMMUNITY_GOVERNED, LUNG),
            exclusion(CONTROLLED, LUNG),
          ],
          held: [LUNG],
        }),
      );
    });

    test('denies with no-grants when every resource the key would render is withheld', () => {
      const rendering = rendered(
        withPermissions(
          payloadFor('05'),
          { [HEART]: UNMARKED_VIEWED },
          { [HEART]: ['resource.pilot'] },
        ),
        catalogue,
      );

      assert.deepEqual(rendering, {
        enforcement: NO_GRANTS,
        unknown: [],
        unmapped: [{ category: 'resource.pilot', resourceId: HEART }],
      });
    });

    test('renders the same result whatever categories the payload lists beyond those held, since the lists drive the checks and never the filter', () => {
      const base = payloadFor('02');
      const listingFewer: PermissionsPayload = {
        ...base,
        globalCategories: ['global.controlled'],
      };
      const listingMore = withPermissions(base, base.permissions, {
        [HEART]: ['resource.pilot'],
      });

      assert.deepEqual(
        rendered(listingMore, withPilot).enforcement,
        rendered(listingFewer, withPilot).enforcement,
      );
    });
  });

  suite('the known resources', () => {
    test("takes them from the payload's servedResources for a key with no list, so a served study the principal holds nothing on is in the complement", () => {
      // Given case 5, which holds nothing on VOID_INDEX and names it only in servedResources
      const payload = payloadFor('05');

      // When a key with no resource list renders it
      const rendering = rendered(payload, catalogue);

      // Then VOID_INDEX is known, so a record holding it beside a held study is withheld
      assert.equal(Object.hasOwn(payload.permissions, VOID), false);
      assert.deepEqual(readBack(rendering.enforcement).complement, [VOID]);
    });

    test('renders only the listed studies as held, and leaves a served study the list does not name in the complement', () => {
      const rendering = rendered(payloadFor('05'), {
        ...catalogue,
        resources: [HEART, LUNG],
      });

      assert.deepEqual(
        readBack(rendering.enforcement),
        narrowingOf({
          complement: [REEF, VOID],
          exclusions: [
            exclusion(COMMUNITY_GOVERNED, HEART, LUNG),
            exclusion(CONTROLLED, LUNG),
          ],
          held: [HEART, LUNG],
        }),
      );
    });

    test('puts a study the key lists and the payload does not serve in the complement, since a key knows its own list beside the served resources', () => {
      const rendering = rendered(payloadFor('05'), {
        ...catalogue,
        resources: [...ALL_THREE, OTHER],
      });

      assert.deepEqual(rendering.unknown, []);
      assert.deepEqual(rendering.unmapped, []);
      assert.deepEqual(
        readBack(rendering.enforcement),
        narrowingOf({
          complement: [OTHER, VOID],
          exclusions: [
            exclusion(COMMUNITY_GOVERNED, ...ALL_THREE),
            exclusion(CONTROLLED, LUNG, REEF),
          ],
          held: ALL_THREE,
        }),
      );
    });

    test('withholds a record holding a held study beside one the key lists and the payload does not serve, judged on the narrowing as rendered', () => {
      // Given a key listing HEART_STUDY and OTHER_STUDY, and case 5, which holds HEART_STUDY and
      // does not serve OTHER_STUDY
      const rendering = rendered(payloadFor('05'), {
        ...catalogue,
        resources: [HEART, OTHER],
      });
      const narrowing =
        rendering.enforcement.kind === 'narrow'
          ? rendering.enforcement.sqon
          : assert.fail(
              `expected a narrowing, got ${rendering.enforcement.kind}`,
            );

      // When records holding HEART_STUDY alone or beside another study are judged against it
      const verdicts = [
        [HEART],
        [HEART, OTHER],
        [HEART, VOID],
        [HEART, 'UNKNOWN_STUDY'],
      ].map((studies) =>
        matchesSqon(narrowing, { data_category: 'open', study_id: studies }),
      );

      // Then a study listed by the key or served by the payload withholds it, and a study neither
      // listed nor served does not
      assert.deepEqual(verdicts, [true, false, false, true]);
    });

    test('puts a served study the payload names without record view in the complement', () => {
      const rendering = rendered(
        withPermissions(payloadFor('05'), {
          ...payloadFor('05').permissions,
          [OTHER]: { 'global.unmarked': { record: ['count'] } },
        }),
        catalogue,
      );

      assert.deepEqual(
        readBack(rendering.enforcement),
        narrowingOf({
          complement: [OTHER, VOID],
          exclusions: [
            exclusion(COMMUNITY_GOVERNED, ...ALL_THREE),
            exclusion(CONTROLLED, LUNG, REEF),
          ],
          held: ALL_THREE,
        }),
      );
    });

    test('renders grants held elsewhere as they are, for a key with no list', () => {
      const rendering = rendered(
        withPermissions(payloadFor('05'), { [OTHER]: UNMARKED_VIEWED }),
        catalogue,
      );

      assert.deepEqual(readBack(rendering.enforcement).held, [OTHER]);
    });
  });

  suite('the deny reasons', () => {
    test('denies with no-grants when every grant sits in another key, for a key that registered its resource list', () => {
      const rendering = rendered(payloadFor('05'), {
        ...catalogue,
        resources: [OTHER],
      });

      assert.deepEqual(rendering, {
        enforcement: NO_GRANTS,
        unknown: [],
        unmapped: [],
      });
    });

    test('denies with unknown-resource when the key registers an empty resource list, whatever is held', () => {
      const rendering = rendered(payloadFor('05'), {
        ...catalogue,
        resources: [],
      });

      assert.deepEqual(rendering, {
        enforcement: UNKNOWN_RESOURCE,
        unknown: [],
        unmapped: [],
      });
    });

    test('denies with filter-limit a narrowing past the clause limit it is given, and serves it at that limit', () => {
      const atLimit = rendered(payloadFor('05'), catalogue, 13);
      const pastLimit = rendered(payloadFor('05'), catalogue, 12);

      assert.equal(
        atLimit.enforcement.kind === 'narrow' &&
          filterClauseCount(atLimit.enforcement.sqon),
        13,
      );
      assert.deepEqual(pastLimit, {
        enforcement: { kind: 'deny', reason: 'filter-limit' },
        unknown: [],
        unmapped: [],
      });
    });
  });

  suite('the conformance corpus', () => {
    /** The resources and global categories of each configuration named by the corpus. */
    const CONFIGURATIONS = {
      default: {
        globals: {
          'global.community-governed': COMMUNITY_GOVERNED,
          'global.controlled': CONTROLLED,
        },
        resources: ALL_THREE,
      },
      'signed-in rule': {
        globals: { 'global.controlled': CONTROLLED },
        resources: [HEART, 'MEMBERS_ARCHIVE', 'OPEN_ATLAS', 'SEALED_ARCHIVE'],
      },
    } as const;

    const registrationsFor = (
      configuration: string | undefined,
    ): readonly KeyRegistration[] => {
      const { globals, resources } =
        configuration === 'signed-in rule'
          ? CONFIGURATIONS['signed-in rule']
          : CONFIGURATIONS.default;

      return [
        {
          categories: { global: globals },
          kind: 'record',
          resourceFieldName: 'study_id',
        },
        {
          categories: { global: globals },
          kind: 'record',
          resourceFieldName: 'study_id',
          resources,
        },
        { kind: 'open' },
      ];
    };

    test('renders every payload, for each kind of key matching its configuration, to a result the validator accepts and no gap', () => {
      for (const principal of corpus.principals) {
        for (const registration of registrationsFor(principal.configuration)) {
          const rendering = rendered(payloadFor(principal.case), registration);
          const label = `case ${principal.case}, ${registration.kind} key`;

          assert.equal(
            validateEnforcement(rendering.enforcement).success,
            true,
            label,
          );
          assert.deepEqual(
            [rendering.unknown, rendering.unmapped],
            [[], []],
            label,
          );
        }
      }
    });

    test('renders every record key narrowing past the rendering guard, so no corpus payload is denied for a mismatch', () => {
      const results = corpus.principals.flatMap((principal) =>
        registrationsFor(principal.configuration).flatMap((registration) => {
          const validated = validateRegistration(registration);
          const key = validated.success
            ? compileKey(validated.registration)
            : undefined;
          const payload = payloadFor(principal.case);

          return key?.kind === 'record'
            ? [
                {
                  enforcement: renderKey(
                    payload,
                    key,
                    CONFIGURATION_DEFAULTS.filterClauseLimit,
                  ).enforcement,
                  key,
                  payload,
                },
              ]
            : [];
        }),
      );
      const narrowings = results.flatMap(({ enforcement, key, payload }) =>
        enforcement.kind === 'narrow'
          ? [{ key, narrowing: enforcement.sqon, payload }]
          : [],
      );

      const denialReasons = results.flatMap(({ enforcement }) =>
        enforcement.kind === 'deny' ? [enforcement.reason] : [],
      );

      assert.deepEqual([...new Set(denialReasons)], ['no-grants']);
      assert.ok(
        narrowings.some(
          ({ narrowing }) =>
            readBack({ kind: 'narrow', sqon: narrowing }).exclusions.length > 0,
        ),
        'the corpus renders narrowings holding exclusions',
      );
      for (const { key, narrowing, payload } of narrowings) {
        assert.deepEqual(
          guardedNarrowing({
            filterClauseLimit: CONFIGURATION_DEFAULTS.filterClauseLimit,
            key,
            narrowing,
            payload,
          }),
          { kind: 'narrow', sqon: narrowing },
        );
      }
    });

    test('renders every record key narrowing in the form that reads back', () => {
      const readBacks = corpus.principals.flatMap((principal) =>
        registrationsFor(principal.configuration)
          .filter((registration) => registration.kind === 'record')
          .map(
            (registration) =>
              rendered(payloadFor(principal.case), registration).enforcement,
          )
          .filter((enforcement) => enforcement.kind === 'narrow')
          .map(readBack),
      );

      assert.ok(readBacks.length > 0);
    });
  });
});

suite('compileKey', () => {
  test('compiles each category once, as its condition with its keys sorted', () => {
    const latePilot: CategoryCondition = JSON.parse(
      '{"op":"and","content":[{"op":"in","content":{"value":["late"],"fieldName":"cohort"}},{"op":"gte","content":{"value":65,"fieldName":"donor_age"}}]}',
    );
    const compiled = compileKey({
      ...catalogue,
      categories: {
        global: { 'global.controlled': CONTROLLED },
        resource: { [HEART]: { 'resource.late-pilot': latePilot } },
      },
    });

    const compiledPilot =
      compiled.kind === 'record'
        ? compiled.compiledCategories.resource[HEART]?.['resource.late-pilot']
        : undefined;

    assert.equal(
      JSON.stringify(compiledPilot?.condition),
      '{"content":[{"content":{"fieldName":"cohort","value":["late"]},"op":"in"},{"content":{"fieldName":"donor_age","value":65},"op":"gte"}],"op":"and"}',
    );
  });

  test('compiles the global categories of a key into that key alone', () => {
    const first = compileKey(catalogue);
    const second = compileKey({
      ...catalogue,
      categories: {
        global: { 'global.controlled': EMBARGOED },
      },
    });

    const controlledOf = (key: typeof first): unknown =>
      key.kind === 'record'
        ? key.compiledCategories.global['global.controlled']
        : undefined;

    assert.deepEqual(controlledOf(first), { condition: CONTROLLED });
    assert.deepEqual(controlledOf(second), { condition: EMBARGOED });
  });

  test('keeps an open registration as it is', () => {
    assert.deepEqual(compileKey({ kind: 'open' }), { kind: 'open' });
  });
});

suite('unenforcedEntries', () => {
  test('records an entry carrying field, once', () => {
    const entries = unenforcedEntries(payloadFor('24'));

    assert.deepEqual(entries, [
      {
        category: 'global.unmarked',
        entry: 'fieldPartition',
        resourceId: HEART,
      },
    ]);
  });

  test('records an entry carrying field on a resource category as a field partition', () => {
    const entries = unenforcedEntries(
      withPermissions(
        payloadFor('05'),
        {
          [HEART]: {
            'global.unmarked': { record: ['view'] },
            'resource.pilot': {
              field: { 'global.basic': ['view'] },
              record: ['view'],
            },
          },
        },
        { [HEART]: ['resource.pilot'] },
      ),
    );

    assert.deepEqual(entries, [
      {
        category: 'resource.pilot',
        entry: 'fieldPartition',
        resourceId: HEART,
      },
    ]);
  });

  test('records nothing for a resource category entry, which is enforced', () => {
    const entries = unenforcedEntries(
      withPermissions(
        payloadFor('05'),
        {
          [HEART]: {
            'global.unmarked': { record: ['view'] },
            'resource.pilot': { record: ['count'] },
          },
        },
        { [HEART]: ['resource.pilot'] },
      ),
    );

    assert.deepEqual(entries, []);
  });

  test('records nothing for a payload whose every entry is enforced', () => {
    assert.deepEqual(unenforcedEntries(payloadFor('05')), []);
  });
});
