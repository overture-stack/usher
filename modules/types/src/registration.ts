import {
  type CategoryCondition,
  categoryConditionProblems,
  fieldNamesReadBy,
} from './categoryCondition.js';
import {
  type CategoryName,
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
} from './plainData.js';
import {
  brokenRules,
  checkSnapshot,
  memberPosition,
  ROOT_POSITION,
  type ValidationProblem,
} from './problems.js';
import { isUsableResource } from './sqonPrimitives.js';

/** A key whose catalogue is open by configuration: every request gets `allow`. */
export interface OpenKeyRegistration {
  kind: 'open';
}

/**
 * The categories defined by a catalogue, each as the condition matched by its records. A record
 * carries every category whose condition it matches, so two conditions may overlap or even coincide.
 */
export interface CategoryConditions {
  /**
   * Each global category defined by this catalogue, as the condition matched by its records. Present
   * even when the catalogue defines none, as an empty map.
   */
  global: Readonly<Partial<Record<CategoryName, CategoryCondition>>>;

  /** Each resource's own categories, by resource identifier and then by category name. */
  resource?: Readonly<
    Partial<
      Record<
        ResourceIdentifier,
        Readonly<Partial<Record<CategoryName, CategoryCondition>>>
      >
    >
  >;
}

/**
 * A key whose catalogue holds records, each keyed to its resource by the value in one field and
 * carrying every category whose condition it matches.
 */
export interface RecordKeyRegistration {
  /**
   * Global categories defined by Usher and never carried by this catalogue's records, declared
   * rather than defined, so none is also defined in `categories.global`.
   */
  absentCategories?: readonly CategoryName[];

  categories: CategoryConditions;

  kind: 'record';

  /**
   * The field holding a record's resource identifier, one value per record. A record holding several
   * anyway is withheld when none of them is held, or when one is a known resource not held by the
   * principal. The known resources are those served by the payload, together with the key's own
   * resource list when it has one. A value outside the known resources withholds nothing, so it does
   * not hide a held one beside it.
   */
  resourceFieldName: string;

  /**
   * The resources held in this catalogue. Optional: only a key with one can tell grants held for
   * other catalogues apart from grants that match nothing here. An empty list denies every request
   * to the key. When given, it lists every resource defining categories of its own, and only a
   * listed resource is held for the key. Every listed resource is known to the key, beside those
   * served by the payload, so a listed resource not served by the payload is never held and
   * withholds every record holding it.
   */
  resources?: readonly ResourceIdentifier[];
}

/** One key's registration: open, or holding records. */
export type KeyRegistration = OpenKeyRegistration | RecordKeyRegistration;

/**
 * The result of {@link validateRegistration}: a copy of the registration's own data, typed, when it
 * holds to the format, and otherwise every problem found, each value-free.
 */
export type RegistrationValidationResult =
  | { problems: NonEmpty<ValidationProblem>; success: false }
  | { registration: KeyRegistration; success: true };

/**
 * The wording of every rule checked by {@link validateRegistration}, keyed by a stable name, to
 * match against each problem's `rule`.
 */
export const REGISTRATION_RULES = {
  absentCategories:
    'absent categories are a list of distinct concrete global category names',
  absentNotDefined:
    'no category is both declared absent and defined in categories.global',
  artifactKind:
    "artifact keys are not supported: leave downloads to a download service, which checks each file's own recorded sources",
  categoriesIsMap: 'a record key carries categories, as a map',
  categoriesMembers: 'categories carries only global and resource',
  globalCategory:
    'each category defined in categories.global is a concrete global category name',
  globalIsMap:
    'categories.global is a map from global category names to conditions, empty when the catalogue defines none',
  isMap: 'a registration is a map',
  kind: 'a registration is of kind open or record',
  members: 'a registration carries only the members defined by its kind',
  resourceCategory:
    'each category defined under a resource is a resource category name, never resource.unmarked',
  resourceEntryIsMap:
    "a resource's own categories are a map from resource category names to conditions",
  resourceFieldName: 'the resource field name is a non-empty string',
  resourceFieldUnread:
    'no condition reads the resource field, since a record belongs to its resource by that field and never by a condition',
  resourceIdentifier:
    'a resource defining categories is named by a non-empty identifier other than __proto__, holding no marker read specially by Arranger',
  resourceIsMap:
    'categories.resource, when given, is a map from resource identifiers to their own categories',
  resourceListed:
    'a resource defining categories is listed in resources, when resources is given',
  resources:
    'a resource list holds distinct, non-empty identifiers other than __proto__, none holding a marker read specially by Arranger',
} as const;

const OPEN_MEMBERS: ReadonlySet<string> = new Set(['kind']);

const RECORD_MEMBERS: ReadonlySet<string> = new Set([
  'absentCategories',
  'categories',
  'kind',
  'resourceFieldName',
  'resources',
]);

const CATEGORIES_MEMBERS: ReadonlySet<string> = new Set(['global', 'resource']);

const CATEGORIES_POSITION = 'categories';
const GLOBAL_POSITION = `${CATEGORIES_POSITION}.global`;
const RESOURCE_MAP_POSITION = `${CATEGORIES_POSITION}.resource`;

const hasNoRepeats = (values: readonly unknown[]): boolean =>
  new Set(values).size === values.length;

const memberProblems = (
  registration: Readonly<Record<string, unknown>>,
  members: ReadonlySet<string>,
): readonly ValidationProblem[] =>
  brokenRules(ROOT_POSITION, [
    [hasOnlyMembers(registration, members), REGISTRATION_RULES.members],
  ]);

const resourceListProblems = (
  resources: unknown,
  present: boolean,
): readonly ValidationProblem[] => {
  const listed = listEntries(resources);

  return brokenRules('resources', [
    [
      present
        ? listed !== undefined &&
          listed.every(isUsableResource) &&
          hasNoRepeats(listed)
        : true,
      REGISTRATION_RULES.resources,
    ],
  ]);
};

/** The problems with one map of categories: the global map, or one resource's own. */
const definedCategoryProblems = (
  categories: PlainEntries,
  position: string,
  isName: (category: string) => boolean,
  nameRule: string,
  resourceFieldName: unknown,
): readonly ValidationProblem[] =>
  categories.flatMap(([category, condition]) => {
    const categoryPosition = memberPosition(position, category);
    const conditionProblems = categoryConditionProblems(
      condition,
      categoryPosition,
    );

    return [
      ...brokenRules(categoryPosition, [
        [isName(category), nameRule],
        [
          // Read only once the grammar accepts the condition, which makes it a SQON node.
          conditionProblems.length > 0 ||
            fieldNamesReadBy(condition as CategoryCondition).every(
              (fieldName) => fieldName !== resourceFieldName,
            ),
          REGISTRATION_RULES.resourceFieldUnread,
        ],
      ]),
      ...conditionProblems,
    ];
  });

const globalProblems = (
  global: unknown,
  resourceFieldName: unknown,
): readonly ValidationProblem[] => {
  const categories = ownEntries(global);

  if (categories !== undefined) {
    return definedCategoryProblems(
      categories,
      GLOBAL_POSITION,
      isConcreteGlobalCategory,
      REGISTRATION_RULES.globalCategory,
      resourceFieldName,
    );
  }

  return [{ position: GLOBAL_POSITION, rule: REGISTRATION_RULES.globalIsMap }];
};

const ownCategoryProblems = (
  resourceCategories: unknown,
  position: string,
  resourceFieldName: unknown,
): readonly ValidationProblem[] => {
  const categories = ownEntries(resourceCategories);

  if (categories !== undefined) {
    return definedCategoryProblems(
      categories,
      position,
      isResourceCategory,
      REGISTRATION_RULES.resourceCategory,
      resourceFieldName,
    );
  }

  return [{ position, rule: REGISTRATION_RULES.resourceEntryIsMap }];
};

/**
 * Problems with `categories.resource`, which is refused as not a map only when `present`. `listed`
 * holds the resource list when the key gives one as a list.
 */
const resourceCategoriesProblems = (
  resourceMap: unknown,
  present: boolean,
  listed: readonly unknown[] | undefined,
  resourceFieldName: unknown,
): readonly ValidationProblem[] => {
  const resources = ownEntries(resourceMap);

  if (resources !== undefined) {
    // A Set rather than `in`, so a resource named like a member of `Object.prototype` is matched as
    // the identifier it is.
    const listedResources: ReadonlySet<unknown> | undefined =
      listed === undefined ? undefined : new Set(listed);

    return resources.flatMap(([resource, resourceCategories]) => {
      const resourcePosition = memberPosition(RESOURCE_MAP_POSITION, resource);

      return [
        ...brokenRules(resourcePosition, [
          [isUsableResource(resource), REGISTRATION_RULES.resourceIdentifier],
          [
            listedResources === undefined || listedResources.has(resource),
            REGISTRATION_RULES.resourceListed,
          ],
        ]),
        ...ownCategoryProblems(
          resourceCategories,
          resourcePosition,
          resourceFieldName,
        ),
      ];
    });
  }

  return present
    ? [
        {
          position: RESOURCE_MAP_POSITION,
          rule: REGISTRATION_RULES.resourceIsMap,
        },
      ]
    : [];
};

const categoriesProblems = (
  categories: unknown,
  listed: readonly unknown[] | undefined,
  resourceFieldName: unknown,
): readonly ValidationProblem[] => {
  if (isPlainRecord(categories)) {
    return [
      ...brokenRules(CATEGORIES_POSITION, [
        [
          hasOnlyMembers(categories, CATEGORIES_MEMBERS),
          REGISTRATION_RULES.categoriesMembers,
        ],
      ]),
      ...globalProblems(ownMember(categories, 'global'), resourceFieldName),
      ...resourceCategoriesProblems(
        ownMember(categories, 'resource'),
        Object.hasOwn(categories, 'resource'),
        listed,
        resourceFieldName,
      ),
    ];
  }

  return [
    { position: CATEGORIES_POSITION, rule: REGISTRATION_RULES.categoriesIsMap },
  ];
};

const absenceProblems = (
  absentCategories: unknown,
  present: boolean,
  categories: unknown,
): readonly ValidationProblem[] => {
  const absences = listEntries(absentCategories);
  const global = isPlainRecord(categories)
    ? ownEntries(ownMember(categories, 'global'))
    : undefined;
  const defined: ReadonlySet<unknown> = new Set(
    (global ?? []).map(([category]) => category),
  );

  return brokenRules('absentCategories', [
    [
      present
        ? absences !== undefined &&
          absences.every(isConcreteGlobalCategory) &&
          hasNoRepeats(absences)
        : true,
      REGISTRATION_RULES.absentCategories,
    ],
    [
      (absences ?? []).every((category) => !defined.has(category)),
      REGISTRATION_RULES.absentNotDefined,
    ],
  ]);
};

const openProblems = (
  registration: Readonly<Record<string, unknown>>,
): readonly ValidationProblem[] => memberProblems(registration, OPEN_MEMBERS);

const recordProblems = (
  registration: Readonly<Record<string, unknown>>,
): readonly ValidationProblem[] => {
  const categories = ownMember(registration, 'categories');
  const resources = ownMember(registration, 'resources');

  return [
    ...memberProblems(registration, RECORD_MEMBERS),
    ...brokenRules('resourceFieldName', [
      [
        isNonEmptyString(ownMember(registration, 'resourceFieldName')),
        REGISTRATION_RULES.resourceFieldName,
      ],
    ]),
    ...categoriesProblems(
      categories,
      listEntries(resources),
      ownMember(registration, 'resourceFieldName'),
    ),
    ...absenceProblems(
      ownMember(registration, 'absentCategories'),
      Object.hasOwn(registration, 'absentCategories'),
      categories,
    ),
    ...resourceListProblems(
      resources,
      Object.hasOwn(registration, 'resources'),
    ),
  ];
};

// A Map rather than a plain object, so an inherited name is never a kind.
const PROBLEMS_BY_KIND: ReadonlyMap<
  unknown,
  (
    registration: Readonly<Record<string, unknown>>,
  ) => readonly ValidationProblem[]
> = new Map(
  Object.entries({
    open: openProblems,
    record: recordProblems,
  } satisfies Readonly<
    Record<
      KeyRegistration['kind'],
      (
        registration: Readonly<Record<string, unknown>>,
      ) => readonly ValidationProblem[]
    >
  >),
);

const refusedKindRule = (kind: unknown): string =>
  kind === 'artifact'
    ? REGISTRATION_RULES.artifactKind
    : REGISTRATION_RULES.kind;

const registrationProblems = (value: unknown): readonly ValidationProblem[] => {
  if (isPlainRecord(value)) {
    const kind = ownMember(value, 'kind');
    const problemsOf = PROBLEMS_BY_KIND.get(kind);

    return problemsOf
      ? problemsOf(value)
      : [{ position: 'kind', rule: refusedKindRule(kind) }];
  }

  return [{ position: ROOT_POSITION, rule: REGISTRATION_RULES.isMap }];
};

/**
 * Validates one key's registration. Never throws, whatever `value` is. A registration that holds to
 * the format comes back as a typed copy of its own data, which is exactly what was checked; any
 * other comes back as every problem found.
 *
 * The registration is refused with a single problem when it:
 * - is not a map, at `(root)`;
 * - throws when read, through a getter or a proxy, at `(root)` under the read rule;
 * - has the kind `artifact`, at `kind` under a rule of its own;
 * - has any other kind outside `open` and `record`, an absent one included, at `kind`.
 *
 * Otherwise every broken rule among these is reported:
 * - the registration carries only the members defined by its kind;
 * - `resourceFieldName` is a non-empty string;
 * - `categories` is a map carrying only `global` and an optional `resource`;
 * - `categories.global` maps each concrete global category name to a condition;
 * - `categories.resource`, when present, maps each resource to its own `resource.` category names,
 *   never `resource.unmarked`, and their conditions;
 * - every condition holds to the grammar checked by `validateCategoryCondition`, and never reads the
 *   resource field;
 * - `absentCategories`, when present, lists distinct concrete global categories, none also defined
 *   in `categories.global`;
 * - `resources`, when present, lists distinct resource identifiers;
 * - a resource identifier is neither empty nor `__proto__`, and holds no marker read specially by
 *   Arranger;
 * - every resource defining categories is listed in `resources`, when that is present.
 *
 * An optional member counts as present whenever the registration has it, even holding `undefined`.
 *
 * Every problem names its rule and a position. A condition's own problems are positioned under its
 * category. A position under `categories.global` or `categories.resource` names the category name or
 * resource identifier it is found under, as written by `keySegment`: bare or quoted in brackets, as
 * in `categories.resource.HEART_STUDY["resource.consented"]`. No position names a field name, a
 * value, or an entry of `absentCategories` or `resources`.
 *
 * @param value a registration, untrusted.
 */
export const validateRegistration = (
  value: unknown,
): RegistrationValidationResult => {
  const {
    problems: [firstProblem, ...otherProblems],
    snapshot,
  } = checkSnapshot(value, registrationProblems);

  return firstProblem
    ? { problems: [firstProblem, ...otherProblems], success: false }
    : { registration: snapshot as KeyRegistration, success: true };
};
