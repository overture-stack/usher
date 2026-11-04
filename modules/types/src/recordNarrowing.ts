import { type SqonNode, SqonSchema } from '@overture-stack/sqon';

import {
  type CategoryCondition,
  categoryConditionProblems,
  fieldNamesReadBy,
  normalizedCondition,
} from './categoryCondition.js';
import { validateEnforcement } from './enforcement.js';
import {
  type CategoryName,
  isCategoryName,
  isConcreteGlobalCategory,
  isResourceCategory,
  type NonEmpty,
  type ResourceIdentifier,
} from './payload.js';
import {
  hasOnlyMembers,
  isNonEmptyString,
  isPlainRecord,
  listEntries,
  ownEntries,
  ownMember,
  type PlainEntries,
  plainSnapshot,
} from './plainData.js';
import { READ_RULE, UsherContractError } from './problems.js';
import { parseRecordNarrowing } from './renderedNarrowing.js';
import { isUsableResource } from './sqonPrimitives.js';

/**
 * One resource held with record view, and what is held on it, for
 * {@link canonicalRecordNarrowing}.
 */
export interface HeldResource {
  /**
   * The categories held on the resource with whole-record view, global or its own, never
   * `global.unmarked`. A name undefined in the catalogue is held to no effect.
   */
  heldCategories: readonly CategoryName[];

  resource: ResourceIdentifier;

  /**
   * The resource's own categories, each with its condition, never `resource.unmarked`: an empty map
   * when it defines none.
   */
  resourceCategories: Readonly<
    Partial<Record<CategoryName, CategoryCondition>>
  >;

  /** Whether its unmarked records, those carrying no category that applies to it, are held. */
  unmarkedHeld: boolean;
}

/**
 * One record key's narrowing for one payload, described rather than rendered, for
 * {@link canonicalRecordNarrowing}.
 */
export interface RecordNarrowingDescription {
  /** Every global category defined in the catalogue, held or not, with its condition. */
  globalCategories: Readonly<Partial<Record<CategoryName, CategoryCondition>>>;

  /** The resources held with record view. */
  heldResources: NonEmpty<HeldResource>;

  /**
   * The payload's served resources, with the key's own resource list when it has one, held or not.
   * Every held resource is among them.
   */
  knownResources: readonly ResourceIdentifier[];

  /** The field holding a record's resource identifiers. */
  resourceFieldName: string;
}

/** The wording of every rule held by {@link canonicalRecordNarrowing}, keyed by a stable name. */
export const RECORD_NARROWING_RULES = {
  conditions: 'every condition holds to the grammar of a category condition',
  descriptionIsMap: 'a record narrowing description is a map',
  descriptionMembers:
    'a record narrowing description carries only globalCategories, heldResources, knownResources and resourceFieldName',
  globalCategories:
    'globalCategories is a map from concrete global category names, never global.unmarked, to conditions',
  heldCategories:
    'heldCategories is a list of distinct category names, never global.unmarked',
  heldEntryMembers:
    'each held resource is a map carrying exactly heldCategories, resource, resourceCategories and unmarkedHeld, none of them undefined, so a mistyped member never reads as unmarked held',
  heldResource:
    'each held resource is named by a non-empty identifier other than __proto__, holding no marker read specially by Arranger',
  heldResources: 'heldResources is a list of at least one held resource',
  heldResourcesDistinct: 'no resource is held twice',
  knownIncludesHeld: 'every held resource is known',
  knownResources:
    'knownResources is a list of distinct, non-empty identifiers other than __proto__, none holding a marker read specially by Arranger',
  resourceCategories:
    "resourceCategories is a map from the resource's own category names, never resource.unmarked, to conditions, empty when it defines none",
  resourceFieldName: 'the resource field name is a non-empty string',
  resourceFieldUnread:
    'no condition reads the resource field, since a record belongs to its resource by that field and never by a condition',
  servesRecords:
    'each held resource holds its unmarked records or at least one category that applies to it, since otherwise it serves no record and belongs outside the held resources',
  unmarkedHeld: 'unmarkedHeld is a boolean',
} as const;

/**
 * The rule broken when a rendered filter fails its own checks. No description keeping
 * {@link RECORD_NARROWING_RULES} reaches it; checking the rendered filter makes a gap in those
 * rules fail closed.
 */
const RENDERED_RULE =
  'the rendered narrowing holds to the rendered-filter grammar and to the rules for access filters';

const UNMARKED: CategoryName = 'global.unmarked';

const MISSING_MARKER = '__missing__';

const DESCRIPTION_MEMBERS: ReadonlySet<string> = new Set([
  'globalCategories',
  'heldResources',
  'knownResources',
  'resourceFieldName',
]);

const ENTRY_MEMBERS: ReadonlySet<string> = new Set([
  'heldCategories',
  'resource',
  'resourceCategories',
  'unmarkedHeld',
]);

/** A category, its condition normalized. */
interface Category {
  condition: CategoryCondition;
  name: string;
}

/** A held resource, its categories read into sorted, normalized form. */
interface HeldEntry {
  categories: readonly Category[];
  held: ReadonlySet<string>;
  resource: ResourceIdentifier;
  unmarkedHeld: boolean;
}

/**
 * One exclusion. `name` and `resource` are only sort keys, `resource` empty for a global category.
 */
interface Exclusion {
  condition: CategoryCondition;
  lacking: readonly ResourceIdentifier[];
  name: string;
  resource: ResourceIdentifier;
}

const hasNoRepeats = (values: readonly unknown[]): boolean =>
  new Set(values).size === values.length;

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Distinct values in code-unit order, the default sort's, never a locale's. */
const sortedDistinct = (values: readonly string[]): string[] =>
  Array.from(new Set(values)).toSorted();

const isCompleteEntry = (entry: unknown): boolean =>
  isPlainRecord(entry) &&
  hasOnlyMembers(entry, ENTRY_MEMBERS) &&
  Array.from(ENTRY_MEMBERS).every(
    (member) => ownMember(entry, member) !== undefined,
  );

const isHeldCategoryList = (value: unknown): boolean => {
  const categories = listEntries(value);

  return (
    categories !== undefined &&
    categories.every(
      (category) => isCategoryName(category) && category !== UNMARKED,
    ) &&
    hasNoRepeats(categories)
  );
};

const isAuthoredCondition = (
  condition: unknown,
): condition is CategoryCondition =>
  categoryConditionProblems(condition, 'condition').length === 0;

/** A check of one rule, returning the rule when it is broken. */
type Check = () => string | undefined;

const checkOf =
  (holds: () => boolean, rule: string): Check =>
  () =>
    holds() ? undefined : rule;

/**
 * The first rule broken by the description, or `undefined` when it breaks none. Everything is read
 * from the snapshot through own members, defensively, and each check runs only once every check
 * before it has passed, so a check may rely on those.
 */
const firstBrokenRule = (snapshot: unknown): string | undefined => {
  const description = isPlainRecord(snapshot) ? snapshot : {};
  const fieldName = ownMember(description, 'resourceFieldName');
  const globals = ownEntries(ownMember(description, 'globalCategories'));
  const heldList = listEntries(ownMember(description, 'heldResources'));
  const entries = (heldList ?? []).filter(isPlainRecord);
  const known = listEntries(ownMember(description, 'knownResources'));
  const ownCategoriesOf = (
    entry: Readonly<Record<string, unknown>>,
  ): PlainEntries => ownEntries(ownMember(entry, 'resourceCategories')) ?? [];
  const globalNames: ReadonlySet<string> = new Set(
    (globals ?? []).map(([name]) => name),
  );
  const servesRecords = (entry: Readonly<Record<string, unknown>>): boolean => {
    const ownNames: ReadonlySet<string> = new Set(
      ownCategoriesOf(entry).map(([name]) => name),
    );

    return (
      ownMember(entry, 'unmarkedHeld') === true ||
      (listEntries(ownMember(entry, 'heldCategories')) ?? []).some(
        (category) =>
          typeof category === 'string' &&
          (globalNames.has(category) || ownNames.has(category)),
      )
    );
  };
  const conditionsCheck: Check = () => {
    const conditions = [
      ...(globals ?? []).map(([, condition]) => condition),
      ...entries.flatMap((entry) =>
        ownCategoriesOf(entry).map(([, condition]) => condition),
      ),
    ];
    const authored = conditions.filter(isAuthoredCondition);

    if (authored.length === conditions.length) {
      return authored.some((condition) =>
        fieldNamesReadBy(condition).some((read) => read === fieldName),
      )
        ? RECORD_NARROWING_RULES.resourceFieldUnread
        : undefined;
    }

    return RECORD_NARROWING_RULES.conditions;
  };
  const checks: readonly Check[] = [
    checkOf(
      () => isPlainRecord(snapshot),
      RECORD_NARROWING_RULES.descriptionIsMap,
    ),
    checkOf(
      () => hasOnlyMembers(description, DESCRIPTION_MEMBERS),
      RECORD_NARROWING_RULES.descriptionMembers,
    ),
    checkOf(
      () => isNonEmptyString(fieldName),
      RECORD_NARROWING_RULES.resourceFieldName,
    ),
    checkOf(
      () =>
        globals !== undefined &&
        globals.every(([name]) => isConcreteGlobalCategory(name)),
      RECORD_NARROWING_RULES.globalCategories,
    ),
    checkOf(
      () => heldList !== undefined && heldList.length > 0,
      RECORD_NARROWING_RULES.heldResources,
    ),
    checkOf(
      () => (heldList ?? []).every(isCompleteEntry),
      RECORD_NARROWING_RULES.heldEntryMembers,
    ),
    checkOf(
      () =>
        entries.every((entry) =>
          isUsableResource(ownMember(entry, 'resource')),
        ),
      RECORD_NARROWING_RULES.heldResource,
    ),
    checkOf(
      () => hasNoRepeats(entries.map((entry) => ownMember(entry, 'resource'))),
      RECORD_NARROWING_RULES.heldResourcesDistinct,
    ),
    checkOf(
      () =>
        entries.every((entry) =>
          isHeldCategoryList(ownMember(entry, 'heldCategories')),
        ),
      RECORD_NARROWING_RULES.heldCategories,
    ),
    checkOf(
      () =>
        entries.every((entry) => {
          const own = ownEntries(ownMember(entry, 'resourceCategories'));

          return (
            own !== undefined && own.every(([name]) => isResourceCategory(name))
          );
        }),
      RECORD_NARROWING_RULES.resourceCategories,
    ),
    checkOf(
      () =>
        entries.every(
          (entry) => typeof ownMember(entry, 'unmarkedHeld') === 'boolean',
        ),
      RECORD_NARROWING_RULES.unmarkedHeld,
    ),
    checkOf(
      () =>
        known !== undefined &&
        known.every(isUsableResource) &&
        hasNoRepeats(known),
      RECORD_NARROWING_RULES.knownResources,
    ),
    checkOf(() => {
      const knownSet: ReadonlySet<unknown> = new Set(known);

      return entries.every((entry) =>
        knownSet.has(ownMember(entry, 'resource')),
      );
    }, RECORD_NARROWING_RULES.knownIncludesHeld),
    conditionsCheck,
    checkOf(
      () => entries.every(servesRecords),
      RECORD_NARROWING_RULES.servesRecords,
    ),
  ];

  return checks.reduce<string | undefined>(
    (broken, check) => broken ?? check(),
    undefined,
  );
};

const categoriesOf = (
  conditions: Readonly<Partial<Record<CategoryName, CategoryCondition>>>,
): readonly Category[] =>
  Object.entries(conditions)
    .flatMap(([name, condition]) =>
      condition ? [{ condition: normalizedCondition(condition), name }] : [],
    )
    .toSorted((left, right) => compareCodeUnits(left.name, right.name));

const heldEntryOf = ({
  heldCategories,
  resource,
  resourceCategories,
  unmarkedHeld,
}: HeldResource): HeldEntry => ({
  categories: categoriesOf(resourceCategories),
  held: new Set(heldCategories),
  resource,
  unmarkedHeld,
});

const inClause = (fieldName: string, values: readonly string[]): SqonNode => ({
  content: { fieldName, value: [...values] },
  op: 'in',
});

const not = (child: SqonNode): SqonNode => ({ content: [child], op: 'not' });

const and = (members: readonly SqonNode[]): SqonNode => ({
  content: [...members],
  op: 'and',
});

const or = (members: readonly SqonNode[]): SqonNode => ({
  content: [...members],
  op: 'or',
});

const missingClauses = (
  conditions: readonly CategoryCondition[],
): readonly SqonNode[] =>
  sortedDistinct(conditions.flatMap(fieldNamesReadBy)).map((fieldName) =>
    inClause(fieldName, [MISSING_MARKER]),
  );

/** A category's test: its condition, or a record lacking any field read by the condition. */
const categoryTest = (conditions: readonly CategoryCondition[]): SqonNode[] => [
  ...conditions,
  ...missingClauses(conditions),
];

const byNameThenResource = (left: Exclusion, right: Exclusion): number =>
  compareCodeUnits(left.name, right.name) ||
  compareCodeUnits(left.resource, right.resource);

const exclusionsOf = (
  globals: readonly Category[],
  entries: readonly HeldEntry[],
): readonly Exclusion[] =>
  [
    ...globals.flatMap(({ condition, name }) => {
      const lacking = entries
        .filter(({ held }) => !held.has(name))
        .map(({ resource }) => resource);

      return lacking.length > 0
        ? [{ condition, lacking, name, resource: '' }]
        : [];
    }),
    ...entries.flatMap(({ categories, held, resource }) =>
      categories
        .filter(({ name }) => !held.has(name))
        .map(({ condition, name }) => ({
          condition,
          lacking: [resource],
          name,
          resource,
        })),
    ),
  ].toSorted(byNameThenResource);

/**
 * The unmarked clause: a record of a resource lacking unmarked is withheld unless it carries a
 * global category, or carries, for each lacking resource it holds, one of that resource's own.
 */
const unmarkedClause = (
  lacking: readonly HeldEntry[],
  globals: readonly Category[],
  onResourceField: (resources: readonly string[]) => SqonNode,
): SqonNode => {
  const defining = lacking.filter(({ categories }) => categories.length > 0);
  const definingNone = lacking
    .filter(({ categories }) => categories.length === 0)
    .map(({ resource }) => resource);
  const categorized =
    defining.length > 0
      ? [
          and([
            ...(definingNone.length > 0
              ? [not(onResourceField(definingNone))]
              : []),
            ...defining.map(({ categories, resource }) =>
              or([
                not(onResourceField([resource])),
                ...categoryTest(categories.map(({ condition }) => condition)),
              ]),
            ),
          ]),
        ]
      : [];

  return not(
    and([
      onResourceField(lacking.map(({ resource }) => resource)),
      not(
        or([
          ...categoryTest(globals.map(({ condition }) => condition)),
          ...categorized,
        ]),
      ),
    ]),
  );
};

const rendered = ({
  globalCategories,
  heldResources,
  knownResources,
  resourceFieldName,
}: RecordNarrowingDescription): SqonNode => {
  const onResourceField = (resources: readonly string[]): SqonNode =>
    inClause(resourceFieldName, sortedDistinct(resources));
  const entries = heldResources
    .map(heldEntryOf)
    .toSorted((left, right) => compareCodeUnits(left.resource, right.resource));
  const heldNames: ReadonlySet<string> = new Set(
    entries.map(({ resource }) => resource),
  );
  const complement = knownResources.filter(
    (resource) => !heldNames.has(resource),
  );
  const globals = categoriesOf(globalCategories);
  const lackingUnmarked = entries.filter(({ unmarkedHeld }) => !unmarkedHeld);

  return and([
    onResourceField(Array.from(heldNames)),
    ...(complement.length > 0 ? [not(onResourceField(complement))] : []),
    ...exclusionsOf(globals, entries).map(({ condition, lacking }) =>
      not(and([onResourceField(lacking), or(categoryTest([condition]))])),
    ),
    ...(lackingUnmarked.length > 0
      ? [unmarkedClause(lackingUnmarked, globals, onResourceField)]
      : []),
  ]);
};

/**
 * Returns the rendered filter once its own checks pass, and throws rather than return one that
 * fails.
 */
const checkedNarrowing = (sqon: SqonNode): SqonNode => {
  const parsed = parseRecordNarrowing(sqon);
  const enforcement = validateEnforcement({ kind: 'narrow', sqon });

  if (
    parsed.success &&
    SqonSchema.safeParse(sqon).success &&
    enforcement.success
  ) {
    return sqon;
  }

  throw new UsherContractError(RENDERED_RULE, [
    ...(parsed.success ? [] : parsed.problems),
    ...(enforcement.success ? [] : enforcement.problems),
  ]);
};

const snapshotOf = (description: unknown): unknown => {
  try {
    return plainSnapshot(description);
  } catch {
    throw new UsherContractError(READ_RULE);
  }
};

/**
 * Renders one record key's narrowing in its per-category form. With F the resource field and Held
 * the held resources, a record is judged through every value it holds at F, and the root is an
 * `and` holding, in this order:
 *
 * 1. an `in` on F listing Held, so a record holding no held resource is withheld;
 * 2. when some known resources are not held, a `not` around an `in` on F listing them, so a record
 *    holding any of them is withheld;
 * 3. for each category lacking on some held resource, one exclusion: a `not` around an `and` of an
 *    `in` on F listing the held resources lacking it and an `or` of its condition and a missing
 *    clause for each field read by the condition. A global category lacks on every held resource
 *    not holding it, and a resource's own category on that resource alone, so a name defined by two
 *    resources gives two. Exclusions are ordered by category name, then resource;
 * 4. when some held resources do not hold their unmarked records, the unmarked clause: a `not`
 *    around an `and` of an `in` on F listing them and a `not` around an `or` of every global
 *    condition, the missing clauses for the fields read by those conditions, and, when some of them
 *    define categories of their own, a test that the record carries, for each of them it holds, one
 *    of that resource's own categories. That test is an `and` of a `not` around an `in` on F
 *    listing those defining none, when there are any, and for each defining some an `or` of a `not`
 *    around an `in` on F naming it alone, its own conditions and their missing clauses. Global
 *    tests stay unscoped, since globals apply everywhere, and every resource category test is
 *    scoped to its own resource.
 *
 * A record lacking a field read by a condition counts as carrying that condition's category.
 * Conditions are normalized first, by {@link normalizedCondition}, and every list is sorted by code
 * unit, so equal descriptions render byte-identical filters whatever the order they were given in.
 * The size grows with the categories, not the resources. Pure: the description is read once, into a
 * copy, and never changed. Every filter it returns has passed `parseRecordNarrowing`, `SqonSchema`
 * and `validateEnforcement`.
 *
 * @throws {UsherContractError} carrying none of the description's content:
 *
 *   - naming the first rule in {@link RECORD_NARROWING_RULES} broken by the description;
 *   - naming the read rule when the description cannot be read as plain data;
 *   - naming the rendered-filter rule when the rendered filter fails its own checks, which no
 *     description keeping those rules reaches.
 */
export const canonicalRecordNarrowing = (
  description: RecordNarrowingDescription,
): SqonNode => {
  const snapshot = snapshotOf(description);
  const brokenRule = firstBrokenRule(snapshot);

  if (brokenRule === undefined) {
    return checkedNarrowing(rendered(snapshot as RecordNarrowingDescription));
  }

  throw new UsherContractError(brokenRule);
};
