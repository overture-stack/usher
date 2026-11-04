import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import fastCheck, { type Arbitrary } from 'fast-check';

import {
  authoredConditionOf,
  describedBy,
  type GeneratedCondition,
  isDataRecord,
  PLAIN_TEXT,
} from './propertySupport.js';
import {
  canonicalRecordNarrowing,
  type RecordNarrowingDescription,
} from './recordNarrowing.js';
import {
  type EvaluatedRecord,
  isMissingField,
  matchesSqon,
} from './sqonEvaluator.js';
import { bypassTypes } from './testSupport.js';

const RESOURCE_FIELD = 'resource_id';

/** The resources a scenario draws from; a record may name one the scenario does not know. */
const RESOURCES = ['R_ALPHA', 'R_BETA', 'R_DELTA', 'R_GAMMA', 'R_OMEGA'];

/** Few fields, so conditions and records meet often. */
const CONDITION_FIELDS = ['f_one', 'f_three', 'f_two'];

const GLOBAL_NAMES = ['global.a', 'global.b', 'global.c'];

/** Own category names shared between resources, so one name can carry two conditions. */
const OWN_NAMES = ['resource.x', 'resource.y'];

/** Names a resource may hold that no condition defines, which must change nothing. */
const UNDEFINED_NAMES = ['global.absent', 'resource.undefined'];

type NamedCondition = readonly [name: string, generated: GeneratedCondition];

/** One held resource as the reference model reads it. */
interface ModelResource {
  /** The category names held on the resource. */
  held: ReadonlySet<string>;
  own: readonly NamedCondition[];
  resource: string;
  unmarkedHeld: boolean;
}

/** A payload and catalogue, as the reference model reads them. */
interface Model {
  globals: readonly NamedCondition[];
  held: readonly ModelResource[];
  known: readonly string[];
}

interface Scenario {
  model: Model;
  records: readonly EvaluatedRecord[];
}

const conditionOf: Arbitrary<GeneratedCondition> = authoredConditionOf(
  PLAIN_TEXT,
  fastCheck.constantFrom(...CONDITION_FIELDS),
);

const namedConditionsOf = (
  names: readonly string[],
): Arbitrary<readonly NamedCondition[]> =>
  fastCheck.tuple(
    ...names.map((name) =>
      conditionOf.map((generated): NamedCondition => [name, generated]),
    ),
  );

/**
 * A held resource, drawn holding its unmarked records whenever it holds no category that applies to
 * it, since a held resource must serve some record.
 */
const heldResourceOf = (
  resource: string,
  globalNames: readonly string[],
): Arbitrary<ModelResource> =>
  fastCheck
    .tuple(
      fastCheck.subarray(OWN_NAMES).chain(namedConditionsOf),
      fastCheck.subarray([...globalNames, ...OWN_NAMES, ...UNDEFINED_NAMES]),
      fastCheck.boolean(),
    )
    .map(([own, heldNames, unmarkedHeld]) => {
      const applicable: ReadonlySet<string> = new Set([
        ...globalNames,
        ...own.map(([name]) => name),
      ]);
      const servesCategorized = heldNames.some((name) => applicable.has(name));

      return {
        held: new Set(heldNames),
        own,
        resource,
        unmarkedHeld: unmarkedHeld || !servesCategorized,
      };
    });

const modelOf: Arbitrary<Model> = fastCheck
  .tuple(
    fastCheck.subarray(RESOURCES, { minLength: 1 }),
    fastCheck.subarray(GLOBAL_NAMES).chain(namedConditionsOf),
  )
  .chain(([known, globals]) =>
    fastCheck
      .subarray(known, { minLength: 1 })
      .chain((heldNames) =>
        fastCheck.tuple(
          ...heldNames.map((resource) =>
            heldResourceOf(
              resource,
              globals.map(([name]) => name),
            ),
          ),
        ),
      )
      .map((held) => ({ globals, held, known })),
  );

/** Every value a condition names, so records can hold values the conditions test. */
const valuesIn = (node: unknown): readonly unknown[] => {
  const content = isDataRecord(node) ? node['content'] : undefined;

  if (Array.isArray(content)) {
    return content.flatMap(valuesIn);
  }

  const value = isDataRecord(content) ? content['value'] : undefined;

  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
};

const conditionsOf = (model: Model): readonly GeneratedCondition[] => [
  ...model.globals.map(([, generated]) => generated),
  ...model.held.flatMap(({ own }) => own.map(([, generated]) => generated)),
];

/** A field's value: absent, null, an empty list, one value or several. */
const fieldValueOf = (pool: Arbitrary<unknown>): Arbitrary<unknown> =>
  fastCheck.oneof(
    fastCheck.constant(undefined),
    fastCheck.constant(null),
    fastCheck.constant([]),
    pool,
    fastCheck.array(pool, { maxLength: 3, minLength: 1 }),
  );

const recordOf = (model: Model): Arbitrary<EvaluatedRecord> => {
  const values = fastCheck.constantFrom(
    ...conditionsOf(model).flatMap(({ condition }) => valuesIn(condition)),
    'unlisted',
    0,
    -1,
    1e9,
    '2020-06-15',
  );

  return fastCheck
    .tuple(
      fieldValueOf(fastCheck.constantFrom(...RESOURCES)),
      ...CONDITION_FIELDS.map(() => fieldValueOf(values)),
    )
    .map(([resourceValue, ...fieldValues]) =>
      Object.fromEntries(
        [
          [RESOURCE_FIELD, resourceValue] as const,
          ...CONDITION_FIELDS.map(
            (fieldName, index) => [fieldName, fieldValues[index]] as const,
          ),
        ].filter(([, value]) => value !== undefined),
      ),
    );
};

const scenarioOf: Arbitrary<Scenario> = modelOf.chain((model) =>
  fastCheck
    .array(recordOf(model), { maxLength: 40, minLength: 1 })
    .map((records) => describedBy({ model, records })),
);

const descriptionOf = (model: Model): RecordNarrowingDescription =>
  bypassTypes<RecordNarrowingDescription>({
    globalCategories: Object.fromEntries(
      model.globals.map(([name, { condition }]) => [name, condition]),
    ),
    heldResources: model.held.map(({ held, own, resource, unmarkedHeld }) => ({
      heldCategories: Array.from(held),
      resource,
      resourceCategories: Object.fromEntries(
        own.map(([name, { condition }]) => [name, condition]),
      ),
      unmarkedHeld,
    })),
    knownResources: model.known,
    resourceFieldName: RESOURCE_FIELD,
  });

/** The resource values a record holds: none when its field is absent, null or an empty list. */
const resourceValuesOf = (record: EvaluatedRecord): readonly unknown[] => {
  const value = Object.hasOwn(record, RESOURCE_FIELD)
    ? record[RESOURCE_FIELD]
    : undefined;

  return value === undefined || value === null
    ? []
    : Array.isArray(value)
      ? value
      : [value];
};

/**
 * The reference model, written without the renderer: a record is visible when its resource values
 * name a held resource and miss every known resource not held; when every global category it
 * carries is held on each held resource it names; when every own category of a held resource it
 * names that it carries is held there; and when, for each held resource it names whose unmarked
 * records are not held, it carries a global category or one of that resource's own. A record
 * carries a category when it matches the condition or lacks any field the condition reads.
 */
const isVisible = (model: Model, record: EvaluatedRecord): boolean => {
  const values = resourceValuesOf(record);
  const heldByName: ReadonlyMap<unknown, ModelResource> = new Map(
    model.held.map((resource) => [resource.resource, resource]),
  );
  const known: ReadonlySet<unknown> = new Set(model.known);
  const heldValues = values.flatMap((value) => {
    const resource = heldByName.get(value);

    return resource ? [resource] : [];
  });
  const carries = ({ condition, fieldNames }: GeneratedCondition): boolean =>
    matchesSqon(condition, record) ||
    fieldNames.some((fieldName) => isMissingField(record, fieldName));
  const carriesGlobal = model.globals.some(([, generated]) =>
    carries(generated),
  );

  return (
    heldValues.length > 0 &&
    values.every((value) => !known.has(value) || heldByName.has(value)) &&
    model.globals.every(
      ([name, generated]) =>
        !carries(generated) || heldValues.every(({ held }) => held.has(name)),
    ) &&
    heldValues.every(({ held, own }) =>
      own.every(([name, generated]) => !carries(generated) || held.has(name)),
    ) &&
    heldValues.every(
      ({ own, unmarkedHeld }) =>
        unmarkedHeld ||
        carriesGlobal ||
        own.some(([, generated]) => carries(generated)),
    )
  );
};

const holdsSeveralLacking = (model: Model, record: EvaluatedRecord): boolean =>
  resourceValuesOf(record).filter((value) =>
    model.held.some(
      ({ resource, unmarkedHeld }) => resource === value && !unmarkedHeld,
    ),
  ).length > 1;

suite('canonicalRecordNarrowing, over generated values', () => {
  suite('the properties', () => {
    test('serves exactly the records the reference model shows, multi-valued, missing and unknown resource values included', () => {
      fastCheck.assert(
        fastCheck.property(scenarioOf, ({ model, records }) => {
          const narrowing = canonicalRecordNarrowing(descriptionOf(model));

          const served = records.map((record) =>
            matchesSqon(narrowing, record),
          );

          assert.deepEqual(
            served,
            records.map((record) => isVisible(model, record)),
          );
        }),
        { numRuns: 400 },
      );
    });

    test('renders byte-identical filters for one description given in any order', () => {
      fastCheck.assert(
        fastCheck.property(
          modelOf.chain((model) =>
            fastCheck
              .tuple(
                fastCheck.shuffledSubarray([...model.held], {
                  minLength: model.held.length,
                }),
                fastCheck.shuffledSubarray([...model.known], {
                  minLength: model.known.length,
                }),
              )
              .map(([held, known]) =>
                describedBy({ model, reordered: { ...model, held, known } }),
              ),
          ),
          ({ model, reordered }) => {
            const narrowings = [model, reordered].map((given) =>
              JSON.stringify(canonicalRecordNarrowing(descriptionOf(given))),
            );

            assert.equal(narrowings[0], narrowings[1]);
          },
        ),
        { numRuns: 200 },
      );
    });

    test('draws records served and withheld, among them records naming several resources lacking unmarked', () => {
      const scenarios = fastCheck.sample(scenarioOf, { numRuns: 300, seed: 7 });

      const verdicts = scenarios.flatMap(({ model, records }) =>
        records.map((record) => ({
          severalLacking: holdsSeveralLacking(model, record),
          visible: isVisible(model, record),
        })),
      );

      assert.deepEqual(
        [
          verdicts.some(({ visible }) => visible),
          verdicts.some(({ visible }) => !visible),
          verdicts.some(
            ({ severalLacking, visible }) => severalLacking && visible,
          ),
          verdicts.some(
            ({ severalLacking, visible }) => severalLacking && !visible,
          ),
        ],
        [true, true, true, true],
      );
    });
  });
});
