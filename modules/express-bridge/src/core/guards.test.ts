import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suite, test } from 'node:test';

import {
  type CategoryCondition,
  type CategoryPermissions,
  type Enforcement,
  type PermissionsPayload,
  parseRecordNarrowing,
  type RecordKeyRegistration,
  type ResourcePermissions,
  validatePayload,
  validateRegistration,
} from '@overture-stack/usher-types';

import { filterClauseCount, guardedNarrowing, guardEventOf } from './guards.js';
import { type CompiledRecordKey, compileKey, renderKey } from './rendering.js';

type Filter = Extract<Enforcement, { kind: 'narrow' }>['sqon'];

/** A path to a member or list entry of a filter, for a tampering test to change. */
type Path = readonly (number | string)[];

const corpus = JSON.parse(
  readFileSync(
    new URL(
      '../../../../.dev/design/conformance/principals.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { principals: readonly { case: string; payload: unknown }[] };

const HEART = 'HEART_STUDY';
const LUNG = 'LUNG_COHORT';
const OTHER = 'OTHER_STUDY';
const REEF = 'REEF_ARCHIVE';
const SEALED = 'SEALED_ARCHIVE';

/** Far above any count rendered here, so only the rendering guard can deny. */
const NO_LIMIT = 1_000_000;

const RENDERING_MISMATCH: Enforcement = {
  kind: 'deny',
  reason: 'rendering-mismatch',
};

const FILTER_LIMIT: Enforcement = { kind: 'deny', reason: 'filter-limit' };

const VIEW: CategoryPermissions = { record: ['view'] };

const inCondition = (
  fieldName: string,
  value: readonly string[],
): CategoryCondition => ({
  content: { fieldName, value: [...value] },
  op: 'in',
});

const COMMUNITY_GOVERNED = inCondition('data_category', ['community-governed']);
const CONTROLLED = inCondition('data_category', ['controlled']);
const PILOT = inCondition('cohort', ['pilot']);

/** Types a hand-built filter as a narrowing's filter. */
const filterOf = (value: unknown): Filter => value as Filter;

const clause = (op: string, fieldName: string, value: unknown): unknown => ({
  content: { fieldName, value },
  op,
});

const group = (op: string, ...content: readonly unknown[]): unknown => ({
  content,
  op,
});

const missing = (fieldName: string): unknown =>
  clause('in', fieldName, ['__missing__']);

/** The studies served by every payload here, two of them held by none. */
const SERVED: readonly string[] = [HEART, LUNG, OTHER, REEF, SEALED];

/**
 * Case 5's payload with `permissions`, `ownCategories` and `servedResources` in place of its own,
 * validated.
 */
const payloadWith = (
  permissions: Readonly<Record<string, ResourcePermissions>>,
  ownCategories: Readonly<Record<string, readonly string[]>> = {},
  servedResources: readonly string[] = SERVED,
): PermissionsPayload => {
  const base = corpus.principals.find((principal) => principal.case === '05');
  const result = validatePayload({
    ...(base?.payload as object),
    permissions,
    resourceCategories: Object.fromEntries(
      Object.keys(permissions).map((resource) => [
        resource,
        ownCategories[resource] ?? [],
      ]),
    ),
    servedResources,
  });

  if (result.success) {
    return result.payload;
  }

  return assert.fail(
    `the test's payload is refused: ${JSON.stringify(result.problems)}`,
  );
};

/** The catalogue rendered by the tampering rows. */
const registration: RecordKeyRegistration = {
  categories: {
    global: {
      'global.community-governed': COMMUNITY_GOVERNED,
      'global.controlled': CONTROLLED,
    },
    resource: { [HEART]: { 'resource.pilot': PILOT } },
  },
  kind: 'record',
  resourceFieldName: 'study_id',
  resources: [HEART, LUNG, OTHER, REEF, SEALED],
};

/** The registration as `register` holds it. */
const compiled = ((): CompiledRecordKey => {
  const validated = validateRegistration(registration);
  const key = validated.success
    ? compileKey(validated.registration)
    : undefined;

  if (key?.kind === 'record') {
    return key;
  }

  return assert.fail('the test registration is refused');
})();

/**
 * Grants rendering three held resources, a complement of two, two exclusions and the unmarked
 * clause.
 */
const PERMISSIONS: Readonly<Record<string, ResourcePermissions>> = {
  [HEART]: { 'resource.pilot': VIEW },
  [LUNG]: { 'global.unmarked': VIEW },
  [REEF]: { 'global.controlled': VIEW, 'global.unmarked': VIEW },
};

const payload = payloadWith(PERMISSIONS, { [HEART]: ['resource.pilot'] });

const narrowingFor = (rendered: PermissionsPayload): Filter => {
  const { enforcement } = renderKey(rendered, compiled, NO_LIMIT);

  if (enforcement.kind === 'narrow') {
    return enforcement.sqon;
  }

  return assert.fail(
    `expected a narrowing, got ${JSON.stringify(enforcement)}`,
  );
};

const valueAt = (value: unknown, path: Path): unknown =>
  path.reduce<unknown>(
    (node, step) => (node as Readonly<Record<number | string, unknown>>)[step],
    value,
  );

const replacedAt = (
  value: unknown,
  path: Path,
  replacement: unknown,
): unknown => {
  const [step, ...rest] = path;

  if (step === undefined) {
    return replacement;
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      index === step ? replacedAt(entry, rest, replacement) : entry,
    );
  }

  const record = value as Readonly<Record<number | string, unknown>>;

  return { ...record, [step]: replacedAt(record[step], rest, replacement) };
};

const removedAt = (value: unknown, listPath: Path, index: number): unknown =>
  replacedAt(
    value,
    listPath,
    (valueAt(value, listPath) as readonly unknown[]).filter(
      (_entry, position) => position !== index,
    ),
  );

/** A path written with dots, each numeric step an index into a list. */
const pathOf = (dotted: string): Path =>
  dotted.split('.').map((step) => (/^\d+$/u.test(step) ? Number(step) : step));

const MEMBERS = pathOf('content');
const HELD_VALUES = pathOf('content.0.content.value');
const COMPLEMENT_VALUES = pathOf('content.1.content.0.content.value');
const FIRST_EXCLUSION_LACKING = pathOf(
  'content.2.content.0.content.0.content.value',
);
const FIRST_EXCLUSION_TEST = pathOf('content.2.content.0.content.1.content');
const UNMARKED_LACKING = pathOf('content.4.content.0.content.0.content.value');

/** The scenario's narrowing, changed by `change` as a fault in the rendering could change it. */
const tampered = (change: (narrowing: unknown) => unknown): Filter =>
  filterOf(change(narrowingFor(payload)));

const guarded = (
  narrowing: Filter,
  filterClauseLimit = NO_LIMIT,
): Enforcement =>
  guardedNarrowing({
    filterClauseLimit,
    key: compiled,
    narrowing,
    payload,
  });

suite('filterClauseCount', () => {
  test('weighs an in as one clause, whatever the number of values it lists', () => {
    const counts = [
      clause('in', 'study_id', [HEART]),
      clause('in', 'study_id', [HEART, LUNG, REEF]),
    ].map((leaf) => filterClauseCount(filterOf(leaf)));

    assert.deepEqual(counts, [1, 1]);
  });

  test('weighs an in on __missing__ as two clauses', () => {
    const count = filterClauseCount(filterOf(missing('data_category')));

    assert.equal(count, 2);
  });

  for (const [op, value] of [
    ['between', [18, 65]],
    ['gt', 18],
    ['gte', 18],
    ['lt', 65],
    ['lte', 65],
  ] as const) {
    test(`weighs a ${op} as two clauses`, () => {
      const count = filterClauseCount(filterOf(clause(op, 'donor_age', value)));

      assert.equal(count, 2);
    });
  }

  test("reads an operator through SQON's aliases, weighing it as the operator it stands for", () => {
    const counts = [
      clause('=', 'cohort', ['pilot']),
      clause('>=', 'donor_age', 18),
      clause('<', 'donor_age', 65),
    ].map((leaf) => filterClauseCount(filterOf(leaf)));

    assert.deepEqual(counts, [1, 2, 2]);
  });

  test('adds one clause for each not', () => {
    const leaf = clause('in', 'cohort', ['pilot']);

    const counts = [group('not', leaf), group('not', group('not', leaf))].map(
      (node) => filterClauseCount(filterOf(node)),
    );

    assert.deepEqual(counts, [2, 3]);
  });

  test('adds nothing for an and or an or', () => {
    const leaf = clause('in', 'cohort', ['pilot']);

    const counts = [
      group('and', leaf),
      group('or', leaf, leaf),
      group('and', group('or', leaf)),
    ].map((node) => filterClauseCount(filterOf(node)));

    assert.deepEqual(counts, [1, 2, 1]);
  });

  test('weighs an operator outside its table past any limit, so the clause guard denies it', () => {
    const counts = [
      clause('not-in', 'cohort', ['pilot']),
      group(
        'and',
        clause('in', 'cohort', ['pilot']),
        clause('all', 'tag', ['a']),
      ),
    ].map((node) => filterClauseCount(filterOf(node)));

    assert.deepEqual(counts, [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    ]);
  });

  test('counts a hand-built filter as the sum of its weights', () => {
    const filter = group(
      'and',
      clause('in', 'study_id', [HEART, LUNG]),
      group('not', clause('in', 'study_id', [OTHER])),
      group(
        'not',
        group(
          'and',
          clause('in', 'study_id', [HEART]),
          group(
            'or',
            clause('in', 'data_category', ['controlled']),
            missing('data_category'),
          ),
        ),
      ),
      group(
        'or',
        clause('gte', 'donor_age', 18),
        clause('between', 'collection_date', ['2020-01-01', '2021-01-01']),
      ),
      group(
        'not',
        group(
          'or',
          clause('<', 'donor_age', 65),
          clause('=', 'cohort', ['pilot']),
        ),
      ),
    );

    const count = filterClauseCount(filterOf(filter));

    // in 1; not 1 + in 1; not 1 + in 1 + in 1 + missing 2; gte 2 + between 2; not 1 + lt 2 + in 1
    assert.equal(count, 1 + 2 + 5 + 4 + 4);
  });

  test('counts the per-category form as its weights add up, for several resources and categories', () => {
    const count = filterClauseCount(narrowingFor(payload));

    // The held test 1; the complement, not 1 + in 1; each of two exclusions, not 1 + in 1 + its
    // condition 1 + its missing clause 2; the unmarked clause, not 1 + in 1 + not 1, both global
    // conditions 2 and their one missing clause 2, and HEART_STUDY's own test, not 1 + in 1 + its
    // condition 1 + its missing clause 2.
    assert.equal(count, 1 + 2 + 2 * 5 + (3 + 4 + 5));
  });

  test('counts the same for more held resources holding the same categories, since the form grows with categories alone', () => {
    const more = payloadWith(
      { ...PERMISSIONS, [OTHER]: { 'global.unmarked': VIEW } },
      { [HEART]: ['resource.pilot'] },
    );

    const counts = [payload, more].map((rendered) =>
      filterClauseCount(narrowingFor(rendered)),
    );

    assert.deepEqual(counts, [25, 25]);
  });
});

suite('guardedNarrowing', () => {
  suite('the rendering guard', () => {
    test('denies a narrowing for a payload listing a global category the key neither defines nor declares absent', () => {
      // Given a payload listing one more global category than the key knows, and the narrowing
      // rendered without that category
      const withUnknownGlobal = validatePayload({
        ...payload,
        globalCategories: [...payload.globalCategories, 'global.embargoed'],
      });
      assert.ok(withUnknownGlobal.success);

      // When the guard checks it, Then the key is denied
      assert.deepEqual(
        guardedNarrowing({
          filterClauseLimit: NO_LIMIT,
          key: compiled,
          narrowing: narrowingFor(payload),
          payload: withUnknownGlobal.payload,
        }),
        RENDERING_MISMATCH,
      );
    });

    test('serves the narrowing as rendered: held, complement, two exclusions and the unmarked clause', () => {
      const narrowing = narrowingFor(payload);

      assert.deepEqual(
        [
          valueAt(narrowing, HELD_VALUES),
          valueAt(narrowing, COMPLEMENT_VALUES),
          valueAt(narrowing, FIRST_EXCLUSION_LACKING),
          valueAt(narrowing, FIRST_EXCLUSION_TEST),
          valueAt(narrowing, UNMARKED_LACKING),
          (valueAt(narrowing, MEMBERS) as readonly unknown[]).length,
        ],
        [
          [HEART, LUNG, REEF],
          [OTHER, SEALED],
          [HEART, LUNG, REEF],
          [COMMUNITY_GOVERNED, missing('data_category')],
          [HEART],
          5,
        ],
      );
      assert.deepEqual(guarded(narrowing), { kind: 'narrow', sqon: narrowing });
    });

    test('denies with rendering-mismatch a rendered narrowing with one exclusion removed', () => {
      const narrowing = tampered((filter) => removedAt(filter, MEMBERS, 2));

      assert.deepEqual(guarded(narrowing), RENDERING_MISMATCH);
    });

    test('denies with rendering-mismatch a lacking list shortened by one resource', () => {
      const narrowing = tampered((filter) =>
        replacedAt(filter, FIRST_EXCLUSION_LACKING, [HEART, LUNG]),
      );

      assert.deepEqual(guarded(narrowing), RENDERING_MISMATCH);
    });

    test('denies with rendering-mismatch a complement missing a value', () => {
      const narrowing = tampered((filter) =>
        replacedAt(filter, COMPLEMENT_VALUES, [OTHER]),
      );

      assert.deepEqual(guarded(narrowing), RENDERING_MISMATCH);
    });

    test("denies with rendering-mismatch a narrowing whose complement leaves out a study the payload serves, reading the complement from the payload's servedResources", () => {
      // Given a payload serving one study more than the one the narrowing was rendered for
      const servingMore = payloadWith(
        PERMISSIONS,
        { [HEART]: ['resource.pilot'] },
        [...SERVED, 'EXTRA_STUDY'],
      );

      // When the guard checks that narrowing against it
      const enforcement = guardedNarrowing({
        filterClauseLimit: NO_LIMIT,
        key: compiled,
        narrowing: narrowingFor(payload),
        payload: servingMore,
      });

      // Then its complement differs from the payload's
      assert.deepEqual(enforcement, RENDERING_MISMATCH);
    });

    test('denies with rendering-mismatch a complement leaving out a study the key lists and the payload does not serve, since the key knows its own list', () => {
      // Given a payload not serving SEALED_ARCHIVE, which the key lists
      const servingLess = payloadWith(
        PERMISSIONS,
        { [HEART]: ['resource.pilot'] },
        SERVED.filter((resource) => resource !== SEALED),
      );
      const rendered = narrowingFor(servingLess);

      // When the guard checks the narrowing rendered for it, and that narrowing with SEALED_ARCHIVE
      // dropped from its complement
      const results = [
        rendered,
        filterOf(replacedAt(rendered, COMPLEMENT_VALUES, [OTHER])),
      ].map((narrowing) =>
        guardedNarrowing({
          filterClauseLimit: NO_LIMIT,
          key: compiled,
          narrowing,
          payload: servingLess,
        }),
      );

      // Then SEALED_ARCHIVE stays in the complement, and only the narrowing keeping it is served
      assert.deepEqual(valueAt(rendered, COMPLEMENT_VALUES), [OTHER, SEALED]);
      assert.deepEqual(results, [
        { kind: 'narrow', sqon: rendered },
        RENDERING_MISMATCH,
      ]);
    });

    test('denies with rendering-mismatch an extra held resource', () => {
      const narrowing = tampered((filter) =>
        replacedAt(filter, HELD_VALUES, [HEART, LUNG, 'EXTRA_STUDY', REEF]),
      );

      assert.deepEqual(guarded(narrowing), RENDERING_MISMATCH);
    });

    test('denies with rendering-mismatch a narrowing with the unmarked clause dropped', () => {
      const narrowing = tampered((filter) => removedAt(filter, MEMBERS, 4));

      assert.deepEqual(guarded(narrowing), RENDERING_MISMATCH);
    });

    test('denies with rendering-mismatch an excluded condition altered', () => {
      const narrowing = tampered((filter) =>
        replacedAt(
          filter,
          [...FIRST_EXCLUSION_TEST, 0, 'content', 'value'],
          ['open'],
        ),
      );

      assert.deepEqual(guarded(narrowing), RENDERING_MISMATCH);
    });

    test('denies with rendering-mismatch a narrowing with a missing clause dropped, which the parse refuses', () => {
      const narrowing = tampered((filter) =>
        removedAt(filter, FIRST_EXCLUSION_TEST, 1),
      );

      assert.equal(parseRecordNarrowing(narrowing).success, false);
      assert.deepEqual(guarded(narrowing), RENDERING_MISMATCH);
    });

    test('computes what a narrowing must say from the payload and registration alone, importing nothing from the rendering it checks', () => {
      const source = readFileSync(
        new URL('./guards.ts', import.meta.url),
        'utf8',
      );

      const specifiers = Array.from(
        source.matchAll(
          /\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/gu,
        ),
        ([, from, dynamic]) => from ?? dynamic ?? '',
      );
      const named = Array.from(
        source.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}/gu),
        ([, names]) => names ?? '',
      ).flatMap((names) =>
        names.split(',').map((name) => name.replace(/^\s*type\s+/u, '').trim()),
      );

      assert.ok(
        specifiers.includes('@overture-stack/usher-types'),
        'the scan reads the imports',
      );
      assert.deepEqual(
        specifiers.filter((specifier) => specifier.includes('rendering')),
        [],
      );
      assert.deepEqual(
        named.filter((name) => name === 'canonicalRecordNarrowing'),
        [],
      );
    });
  });

  suite('the clause guard', () => {
    test('serves a narrowing whose count exactly meets the limit', () => {
      const narrowing = narrowingFor(payload);

      assert.equal(filterClauseCount(narrowing), 25);
      assert.deepEqual(guarded(narrowing, 25), {
        kind: 'narrow',
        sqon: narrowing,
      });
    });

    test('denies with filter-limit a narrowing whose count passes the limit by one', () => {
      const narrowing = narrowingFor(payload);

      assert.deepEqual(guarded(narrowing, 24), FILTER_LIMIT);
    });

    test('runs only once the rendering guard passes, so a mismatch is never reported as a limit', () => {
      const narrowing = tampered((filter) => removedAt(filter, MEMBERS, 2));

      assert.deepEqual(guarded(narrowing, 1), RENDERING_MISMATCH);
    });
  });
});

suite('guardEventOf', () => {
  test('names a rendering mismatch catalogue.renderingMismatch, carrying the catalogue alone', () => {
    const event = guardEventOf('files', RENDERING_MISMATCH, 1_024);

    assert.deepEqual(event, {
      data: { catalogue: 'files' },
      name: 'catalogue.renderingMismatch',
    });
  });

  test('names a filter limit catalogue.filterLimit, carrying the catalogue and the configured limit', () => {
    const event = guardEventOf('files', FILTER_LIMIT, 1_024);

    assert.deepEqual(event, {
      data: { catalogue: 'files', filterClauseLimit: 1_024 },
      name: 'catalogue.filterLimit',
    });
  });

  test('names no event for any other result', () => {
    const results: readonly Enforcement[] = [
      { kind: 'allow' },
      { kind: 'deny', reason: 'no-grants' },
      { kind: 'deny', reason: 'unknown-resource' },
      { kind: 'deny', reason: 'unmapped-category' },
      { kind: 'narrow', sqon: narrowingFor(payload) },
    ];

    const events = results.map((enforcement) =>
      guardEventOf('files', enforcement, 1_024),
    );

    assert.deepEqual(events, [
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});
