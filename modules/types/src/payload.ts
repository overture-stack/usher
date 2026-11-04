import {
  hasOnlyMembers,
  isNonEmptyString,
  isPlainRecord,
  listEntries,
  ownEntries,
  ownMember,
} from './plainData.js';
import {
  brokenRules,
  checkSnapshot,
  ROOT_POSITION,
  type ValidationProblem,
} from './problems.js';
import { isUsableResource } from './sqonPrimitives.js';

/** A list with at least one element. */
export type NonEmpty<Element> = [Element, ...Element[]];

/** A resource identifier, as the instance names it. Opaque to the controller. */
export type ResourceIdentifier = string;

/**
 * A category name, prefixed by its scope: `global` for a category shared by the whole platform, and
 * `resource` for one that exists only in the resource it is listed under. The part after the prefix
 * is the name as configured by the instance, opaque to the controller, and holds no dot. In either
 * scope, a category's records are those matching the condition given to it by the catalogue's
 * category mapping. A key outside both forms makes the payload malformed.
 */
export type CategoryName = `global.${string}` | `resource.${string}`;

/**
 * Actions on a record, in order of increasing reach. `read` is not among them: it is a capability
 * group, so a token carries `count`, `view` and `export` in its place.
 */
export type RecordAction =
  'count' | 'view' | 'export' | 'create' | 'update' | 'delete';

/** Actions on a field. No `create` or `delete`: a field exists per schema rather than per grant. */
export type FieldAction = 'count' | 'view' | 'export' | 'update';

/** Actions on a revision, in services that keep prior states of a record. */
export type RevisionAction = 'view' | 'export';

/** Actions on an artifact: a kept collection of records carrying provenance. */
export type ArtifactAction =
  'count' | 'view' | 'export' | 'create' | 'update' | 'delete';

/**
 * The entities reached under one category, and the actions held on each. An entity absent from an
 * entry is not acted on by this principal under that category.
 */
export interface CategoryPermissions {
  artifact?: NonEmpty<ArtifactAction>;

  /**
   * The field categories reached within this record category, and the actions held on each.
   * Absent means the category is not partitioned by field at all, so the record actions carry
   * every column. Present means only the field categories named inside are reached, which is the
   * same rule as the record axis one level up.
   */
  field?: Record<CategoryName, NonEmpty<FieldAction>>;

  record?: NonEmpty<RecordAction>;

  revision?: NonEmpty<RevisionAction>;
}

/** The entities acted on by a data-plane capability, each carried in a token's category entries. */
export type DataEntity = keyof CategoryPermissions;

/** The entities a control-plane capability acts on: rows in Usher's own store, never in a token. */
export type ControlEntity =
  | 'resource'
  | 'category'
  | 'grant'
  | 'group'
  | 'role'
  | 'ownership'
  | 'invitation'
  | 'custodianship';

// A union in code rather than a table, because no new entity comes without code: a data-plane one
// changes what a token carries, and a control-plane one is new API. Each entity's plane is the union
// holding it, so two capabilities of one entity cannot disagree about it.
/**
 * Every entity known to Usher's vocabulary: a {@link DataEntity} or a {@link ControlEntity}, never
 * both.
 */
export type Entity = DataEntity | ControlEntity;

/**
 * The categories reached within one resource. Entries are independent rather than conditions on one
 * another, so holding two reaches what either admits plus their overlap, and holding more never
 * reaches less.
 */
export type ResourcePermissions = Record<CategoryName, CategoryPermissions>;

/**
 * The decrypted contents of an Usher token, describing what one principal holds for one audience.
 *
 * Global categories are listed once, in `globalCategories`, rather than per resource: a global
 * category applies to every resource whose records match it, so it belongs to no resource in
 * particular. A resource's own categories exist in that resource alone, so they are listed under it,
 * in `resourceCategories`. Neither member says whether a resource has records carrying no concrete
 * category.
 */
export interface PermissionsPayload {
  // The members keep the corpus order rather than an alphabetical one: `payloadVersion` leads
  // because it says how to read the rest, the standard claims follow in the order used by every
  // example, and the content comes last.

  /** The schema version of this payload, one of those declared by the bridge at the exchange. */
  payloadVersion: number;

  /**
   * The principal described by this payload, as the identity provider's subject identifier, or
   * `null` for anonymous access.
   */
  sub: string | null;

  /** The controller that issued this payload. */
  iss: string;

  /** The single application for which this payload was issued. */
  aud: string;

  /** Issued at, in seconds since the Unix epoch. */
  iat: number;

  /**
   * Expiry, in seconds since the Unix epoch. Never later than the earliest expiry among the grants
   * drawn on by this payload, so a reissue from cache cannot extend a token past a lapsed grant.
   */
  exp: number;

  /**
   * When the controller computed `permissions`, in seconds since the Unix epoch. Distinct from
   * `iat`: a reissue from the cached payload renews the token, moving `iat`, while keeping both the
   * computation and this timestamp.
   */
  generatedAt: number;

  /**
   * What the principal holds, keyed by resource identifier. A resource absent from this map is
   * unreachable, no entry is ever a denial, and there is no empty-entry case. The map itself may
   * be empty, which is a registered principal holding no grants at all.
   */
  permissions: Record<ResourceIdentifier, ResourcePermissions>;

  /**
   * Every concrete global category defined by Usher, held or not, each named once and never
   * `global.unmarked`; empty when Usher defines none. Present even when empty: `global.unmarked` is
   * a complement, the records matching none of these, so a list defaulted to none would make every
   * record unmarked.
   */
  globalCategories: readonly CategoryName[];

  /**
   * Each resource's own categories, held or not, keyed by resource identifier: `resource.` names,
   * each once and never `resource.unmarked`, and an empty list for a resource defining none. Names
   * exactly the resources named in `permissions`. Every category held on a resource is
   * `global.unmarked`, one listed in `globalCategories`, or one listed here under that resource.
   * Present even when a list is empty, for the same reason as `globalCategories`.
   */
  resourceCategories: Record<ResourceIdentifier, readonly CategoryName[]>;

  /**
   * Every resource served by the audience, held or not, each named once, every resource named in
   * `permissions` or `resourceCategories` among them. A record holding a served resource not held
   * by the principal is withheld, whatever else it holds. Empty only for an audience serving none,
   * which leaves `permissions` empty too. Present even then, since a list defaulted to none would
   * make no resource known beyond those held.
   */
  servedResources: readonly ResourceIdentifier[];
}

/**
 * The result of {@link validatePayload}: a copy of the payload's own data, typed, when it holds to
 * version 1 of the contract, and otherwise every problem found, each value-free.
 */
export type PayloadValidationResult =
  | { payload: PermissionsPayload; success: true }
  | { problems: NonEmpty<ValidationProblem>; success: false };

/**
 * The wording of every rule checked by {@link validatePayload}, keyed by a stable name, to match
 * against each problem's `rule`.
 */
export const PAYLOAD_RULES = {
  actionListIsList: 'an action list is a list',
  actionListNamesEachOnce: 'an action list names each action once',
  actionListNotEmpty:
    'an action list holds at least one action, since an empty one means what absence means',
  actionListVocabulary:
    "an action list holds only its entity's actions, and read is a capability group rather than an action",
  audNonEmpty: 'aud is a non-empty string',
  categoryEntryNamesEntity:
    'a category entry is a map naming at least one entity',
  categoryForm:
    'a category name is global. or resource. followed by a name holding no dot, other than __proto__',
  entityKey:
    'an entity key is never __proto__, whether or not the vocabulary knows the entity',
  expAfterIat: 'exp is later than iat',
  expTimestamp:
    'exp is a non-negative integer, in seconds since the Unix epoch',
  fieldMapsCategories:
    'a field key maps at least one field category to its actions',
  generatedAtNotAfterIat: 'generatedAt is no later than iat',
  generatedAtTimestamp:
    'generatedAt is a non-negative integer, in seconds since the Unix epoch',
  globalCategories:
    'globalCategories is present, as a list of distinct concrete global category names, never global.unmarked, and empty when Usher defines none',
  heldCategoryListed:
    'every category held on a resource is global.unmarked, listed in globalCategories, or listed under that resource in resourceCategories',
  iatTimestamp:
    'iat is a non-negative integer, in seconds since the Unix epoch',
  issNonEmpty: 'iss is a non-empty string',
  payloadIsMap: 'a payload is a map of the members defined by version 1',
  payloadVersion: 'payloadVersion is present and is the number 1',
  permissionsIsMap:
    'permissions is a map from resource identifier to the categories held there',
  resourceCategoriesIsMap:
    "resourceCategories is present, as a map from resource identifier to that resource's own categories",
  resourceCategoriesNamesEveryHeldResource:
    'resourceCategories names every resource named in permissions',
  resourceCategoriesNamesNoOtherResource:
    'resourceCategories names no resource absent from permissions',
  resourceCategoryList:
    'each list in resourceCategories holds distinct resource category names, never resource.unmarked, and is empty when the resource defines none',
  resourceHoldsCategory:
    'a resource named in permissions holds at least one category',
  resourceIdentifier:
    'a resource identifier is a non-empty string other than __proto__, holding no marker read specially by Arranger',
  rootMembers: 'a payload carries only the members defined by version 1',
  servedResources:
    'servedResources is present, as a list of distinct resource identifiers, each a non-empty string other than __proto__ holding no marker read specially by Arranger',
  servedResourcesListsNamedResources:
    'servedResources lists every resource named in permissions or resourceCategories',
  sub: 'sub is present, as a non-empty string or as null for anonymous access',
} as const;

const RECORD_ACTIONS: Readonly<Record<RecordAction, true>> = {
  count: true,
  create: true,
  delete: true,
  export: true,
  update: true,
  view: true,
};

const FIELD_ACTIONS: Readonly<Record<FieldAction, true>> = {
  count: true,
  export: true,
  update: true,
  view: true,
};

const REVISION_ACTIONS: Readonly<Record<RevisionAction, true>> = {
  export: true,
  view: true,
};

const ARTIFACT_ACTIONS: Readonly<Record<ArtifactAction, true>> = {
  count: true,
  create: true,
  delete: true,
  export: true,
  update: true,
  view: true,
};

const vocabularyOf = (
  actions: Readonly<Record<string, true>>,
): ReadonlySet<string> => new Set(Object.keys(actions));

const FIELD_VOCABULARY = vocabularyOf(FIELD_ACTIONS);

/**
 * The vocabulary of each entity whose value is an action list. `field` is absent: it maps to field
 * categories before its actions. A key found in neither is an entity unknown to this version.
 */
const ACTION_LIST_VOCABULARIES: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map(
  Object.entries({
    artifact: vocabularyOf(ARTIFACT_ACTIONS),
    record: vocabularyOf(RECORD_ACTIONS),
    revision: vocabularyOf(REVISION_ACTIONS),
  } satisfies Readonly<
    Record<Exclude<DataEntity, 'field'>, ReadonlySet<string>>
  >),
);

/**
 * The payload version read by {@link validatePayload}; a payload of any other version is refused at
 * `payloadVersion`.
 */
export const PAYLOAD_VERSION = 1;

/**
 * The name of every member of version 1 of the payload, each required by {@link validatePayload},
 * as a frozen list.
 */
export const PAYLOAD_MEMBER_NAMES: readonly (keyof PermissionsPayload)[] =
  Object.freeze(
    Object.keys({
      aud: true,
      exp: true,
      generatedAt: true,
      globalCategories: true,
      iat: true,
      iss: true,
      payloadVersion: true,
      permissions: true,
      resourceCategories: true,
      servedResources: true,
      sub: true,
    } satisfies Readonly<
      Record<keyof PermissionsPayload, true>
    >) as (keyof PermissionsPayload)[],
  );

const PAYLOAD_MEMBERS: ReadonlySet<string> = new Set(PAYLOAD_MEMBER_NAMES);

const NON_EMPTY_STRING_RULES = [
  ['iss', PAYLOAD_RULES.issNonEmpty],
  ['aud', PAYLOAD_RULES.audNonEmpty],
] as const;

const TIMESTAMP_RULES = [
  ['iat', PAYLOAD_RULES.iatTimestamp],
  ['exp', PAYLOAD_RULES.expTimestamp],
  ['generatedAt', PAYLOAD_RULES.generatedAtTimestamp],
] as const;

/**
 * A scope, then a name holding no dot and other than `__proto__`, so that every category name is an
 * own key in any copy of the payload.
 */
const CATEGORY_NAME_FORM = /^(?:global|resource)\.(?!__proto__$)[^.]+$/u;

const RESOURCE_POSITION = 'permissions.<resource>';
const CATEGORY_POSITION = `${RESOURCE_POSITION}.<category>`;
const ENTITY_POSITION = `${CATEGORY_POSITION}.<entity>`;
const FIELD_POSITION = `${CATEGORY_POSITION}.field`;
const FIELD_CATEGORY_POSITION = `${FIELD_POSITION}.<category>`;
const RESOURCE_CATEGORIES_POSITION = 'resourceCategories.<resource>';

const UNMARKED: CategoryName = 'global.unmarked';

/** Unmarked is the records matching no condition, so no resource category may take its name. */
const RESERVED_RESOURCE_NAME: CategoryName = 'resource.unmarked';

/**
 * Whether `value` is a category name: `global` or `resource`, a dot, then a name holding no dot that
 * is not `__proto__`.
 */
export const isCategoryName = (value: unknown): value is CategoryName =>
  typeof value === 'string' && CATEGORY_NAME_FORM.test(value);

/**
 * Whether `value` names a concrete global category: `global.` and a name, never `global.unmarked`,
 * which is the records carrying none.
 */
export const isConcreteGlobalCategory = (
  value: unknown,
): value is CategoryName =>
  isCategoryName(value) && value.startsWith('global.') && value !== UNMARKED;

/**
 * Whether `value` names a resource's own category: `resource.` and a name, never
 * `resource.unmarked`.
 */
export const isResourceCategory = (value: unknown): value is CategoryName =>
  isCategoryName(value) &&
  value.startsWith('resource.') &&
  value !== RESERVED_RESOURCE_NAME;

const isTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const hasNoRepeats = (values: readonly unknown[]): boolean =>
  new Set(values).size === values.length;

const actionListProblems = (
  value: unknown,
  vocabulary: ReadonlySet<string>,
  position: string,
): readonly ValidationProblem[] => {
  const actions = listEntries(value);

  if (actions !== undefined) {
    return brokenRules(position, [
      [actions.length > 0, PAYLOAD_RULES.actionListNotEmpty],
      [hasNoRepeats(actions), PAYLOAD_RULES.actionListNamesEachOnce],
      [
        actions.every(
          (action) => typeof action === 'string' && vocabulary.has(action),
        ),
        PAYLOAD_RULES.actionListVocabulary,
      ],
    ]);
  }

  return [{ position, rule: PAYLOAD_RULES.actionListIsList }];
};

const fieldProblems = (value: unknown): readonly ValidationProblem[] => {
  const fieldCategories = ownEntries(value);

  if (fieldCategories !== undefined && fieldCategories.length > 0) {
    return fieldCategories.flatMap(([fieldCategory, actions]) => [
      ...brokenRules(FIELD_CATEGORY_POSITION, [
        [isCategoryName(fieldCategory), PAYLOAD_RULES.categoryForm],
      ]),
      ...actionListProblems(actions, FIELD_VOCABULARY, FIELD_CATEGORY_POSITION),
    ]);
  }

  return [
    { position: FIELD_POSITION, rule: PAYLOAD_RULES.fieldMapsCategories },
  ];
};

/**
 * An entity unknown to this version is skipped, since skipping it serves less. One named
 * `__proto__` is refused instead, so that any copy of the entry holds only entities checked here.
 */
const entityProblems = (
  entity: string,
  value: unknown,
): readonly ValidationProblem[] => {
  const vocabulary = ACTION_LIST_VOCABULARIES.get(entity);

  if (entity === 'field') {
    return fieldProblems(value);
  }

  if (vocabulary) {
    return actionListProblems(
      value,
      vocabulary,
      `${CATEGORY_POSITION}.${entity}`,
    );
  }

  return brokenRules(ENTITY_POSITION, [
    [entity !== '__proto__', PAYLOAD_RULES.entityKey],
  ]);
};

const categoryProblems = (
  category: string,
  categoryEntry: unknown,
): readonly ValidationProblem[] => {
  const entities = ownEntries(categoryEntry);

  return [
    ...brokenRules(CATEGORY_POSITION, [
      [isCategoryName(category), PAYLOAD_RULES.categoryForm],
      [
        entities !== undefined && entities.length > 0,
        PAYLOAD_RULES.categoryEntryNamesEntity,
      ],
    ]),
    ...(entities ?? []).flatMap(([entity, value]) =>
      entityProblems(entity, value),
    ),
  ];
};

const resourceProblems = (
  resource: string,
  resourceEntry: unknown,
): readonly ValidationProblem[] => {
  const categories = ownEntries(resourceEntry);

  return [
    ...brokenRules(RESOURCE_POSITION, [
      [isUsableResource(resource), PAYLOAD_RULES.resourceIdentifier],
      [
        categories !== undefined && categories.length > 0,
        PAYLOAD_RULES.resourceHoldsCategory,
      ],
    ]),
    ...(categories ?? []).flatMap(([category, categoryEntry]) =>
      categoryProblems(category, categoryEntry),
    ),
  ];
};

const permissionsProblems = (
  permissions: unknown,
): readonly ValidationProblem[] => {
  const resources = ownEntries(permissions);

  if (resources !== undefined) {
    return resources.flatMap(([resource, resourceEntry]) =>
      resourceProblems(resource, resourceEntry),
    );
  }

  return [{ position: 'permissions', rule: PAYLOAD_RULES.permissionsIsMap }];
};

const isDistinctListOf = (
  value: unknown,
  isName: (entry: unknown) => boolean,
): boolean => {
  const entries = listEntries(value);

  return (
    entries !== undefined && entries.every(isName) && hasNoRepeats(entries)
  );
};

const globalCategoriesProblems = (
  globalCategories: unknown,
): readonly ValidationProblem[] =>
  brokenRules('globalCategories', [
    [
      isDistinctListOf(globalCategories, isConcreteGlobalCategory),
      PAYLOAD_RULES.globalCategories,
    ],
  ]);

/**
 * The two rules tying `resourceCategories` to `permissions` apply only when `permissions` is a map.
 */
const resourceCategoriesProblems = (
  permissions: unknown,
  resourceCategories: unknown,
): readonly ValidationProblem[] => {
  const lists = ownEntries(resourceCategories);
  const resources = ownEntries(permissions);

  if (lists !== undefined) {
    // Sets rather than `in` or a plain object, so a resource named like a member of
    // `Object.prototype` is matched as the identifier it is.
    const heldResources: ReadonlySet<string> | undefined =
      resources === undefined
        ? undefined
        : new Set(resources.map(([resource]) => resource));
    const listedResources: ReadonlySet<string> = new Set(
      lists.map(([resource]) => resource),
    );

    return [
      ...lists.flatMap(([resource, list]) =>
        brokenRules(RESOURCE_CATEGORIES_POSITION, [
          [isUsableResource(resource), PAYLOAD_RULES.resourceIdentifier],
          [
            heldResources === undefined || heldResources.has(resource),
            PAYLOAD_RULES.resourceCategoriesNamesNoOtherResource,
          ],
          [
            isDistinctListOf(list, isResourceCategory),
            PAYLOAD_RULES.resourceCategoryList,
          ],
        ]),
      ),
      ...(resources ?? [])
        .filter(([resource]) => !listedResources.has(resource))
        .map(() => ({
          position: RESOURCE_CATEGORIES_POSITION,
          rule: PAYLOAD_RULES.resourceCategoriesNamesEveryHeldResource,
        })),
    ];
  }

  return [
    {
      position: 'resourceCategories',
      rule: PAYLOAD_RULES.resourceCategoriesIsMap,
    },
  ];
};

/**
 * The rule tying `servedResources` to the resources named in `permissions` and `resourceCategories`
 * applies only when `servedResources` is a list. An unserved resource is refused at its position in
 * each member naming it, so one named in both is refused twice.
 */
const servedResourcesProblems = (
  permissions: unknown,
  resourceCategories: unknown,
  servedResources: unknown,
): readonly ValidationProblem[] => {
  const served = listEntries(servedResources);

  if (served !== undefined) {
    // A Set rather than `in`, so a resource named like a member of `Object.prototype` is matched as
    // the identifier it is.
    const servedNames: ReadonlySet<unknown> = new Set(served);
    const unservedProblems = (
      map: unknown,
      position: string,
    ): readonly ValidationProblem[] =>
      (ownEntries(map) ?? [])
        .filter(([resource]) => !servedNames.has(resource))
        .map(() => ({
          position,
          rule: PAYLOAD_RULES.servedResourcesListsNamedResources,
        }));

    return [
      ...brokenRules('servedResources', [
        [
          isDistinctListOf(served, isUsableResource),
          PAYLOAD_RULES.servedResources,
        ],
      ]),
      ...unservedProblems(permissions, RESOURCE_POSITION),
      ...unservedProblems(resourceCategories, RESOURCE_CATEGORIES_POSITION),
    ];
  }

  return [{ position: 'servedResources', rule: PAYLOAD_RULES.servedResources }];
};

/**
 * Problems with the categories held in `permissions`, each of which must be `global.unmarked` or
 * listed in the member for its scope. A field category is not held on a resource but within a
 * category entry, so it is outside this rule. A member that is not a list lists nothing here, since
 * its own rule refuses it.
 */
const heldCategoryProblems = (
  permissions: unknown,
  globalCategories: unknown,
  resourceCategories: unknown,
): readonly ValidationProblem[] => {
  // A Map and Sets rather than plain objects, so a resource named like a member of
  // `Object.prototype` never reads an inherited list.
  const listedGlobals: ReadonlySet<unknown> = new Set(
    listEntries(globalCategories) ?? [],
  );
  const listsByResource: ReadonlyMap<string, unknown> = new Map(
    ownEntries(resourceCategories) ?? [],
  );

  return (ownEntries(permissions) ?? []).flatMap(
    ([resource, resourceEntry]) => {
      const listedOwn: ReadonlySet<unknown> = new Set(
        listEntries(listsByResource.get(resource)) ?? [],
      );
      const isListed = (category: string): boolean =>
        category === UNMARKED ||
        (isConcreteGlobalCategory(category) && listedGlobals.has(category)) ||
        (isResourceCategory(category) && listedOwn.has(category));

      return (ownEntries(resourceEntry) ?? []).flatMap(([category]) =>
        brokenRules(CATEGORY_POSITION, [
          [isListed(category), PAYLOAD_RULES.heldCategoryListed],
        ]),
      );
    },
  );
};

const claimProblems = (
  payload: Readonly<Record<string, unknown>>,
): readonly ValidationProblem[] => {
  const sub = ownMember(payload, 'sub');
  const iat = ownMember(payload, 'iat');
  const exp = ownMember(payload, 'exp');
  const generatedAt = ownMember(payload, 'generatedAt');

  return [
    ...brokenRules(ROOT_POSITION, [
      [hasOnlyMembers(payload, PAYLOAD_MEMBERS), PAYLOAD_RULES.rootMembers],
    ]),
    ...brokenRules('sub', [
      [sub === null || isNonEmptyString(sub), PAYLOAD_RULES.sub],
    ]),
    ...NON_EMPTY_STRING_RULES.flatMap(([member, rule]) =>
      brokenRules(member, [
        [isNonEmptyString(ownMember(payload, member)), rule],
      ]),
    ),
    ...TIMESTAMP_RULES.flatMap(([member, rule]) =>
      brokenRules(member, [[isTimestamp(ownMember(payload, member)), rule]]),
    ),
    ...brokenRules('exp', [
      [
        isTimestamp(iat) && isTimestamp(exp) ? exp > iat : true,
        PAYLOAD_RULES.expAfterIat,
      ],
    ]),
    ...brokenRules('generatedAt', [
      [
        isTimestamp(iat) && isTimestamp(generatedAt)
          ? generatedAt <= iat
          : true,
        PAYLOAD_RULES.generatedAtNotAfterIat,
      ],
    ]),
  ];
};

const payloadProblems = (value: unknown): readonly ValidationProblem[] => {
  if (isPlainRecord(value)) {
    const permissions = ownMember(value, 'permissions');
    const globalCategories = ownMember(value, 'globalCategories');
    const resourceCategories = ownMember(value, 'resourceCategories');
    const servedResources = ownMember(value, 'servedResources');

    // Version 1 says how to read the rest, so a payload of any other version is read no further.
    return ownMember(value, 'payloadVersion') === PAYLOAD_VERSION
      ? [
          ...claimProblems(value),
          ...permissionsProblems(permissions),
          ...globalCategoriesProblems(globalCategories),
          ...resourceCategoriesProblems(permissions, resourceCategories),
          ...servedResourcesProblems(
            permissions,
            resourceCategories,
            servedResources,
          ),
          ...heldCategoryProblems(
            permissions,
            globalCategories,
            resourceCategories,
          ),
        ]
      : [{ position: 'payloadVersion', rule: PAYLOAD_RULES.payloadVersion }];
  }

  return [{ position: ROOT_POSITION, rule: PAYLOAD_RULES.payloadIsMap }];
};

/**
 * Validates a decrypted payload against version 1 of the contract. Never throws, whatever `value`
 * is. A payload that holds to the contract comes back as a typed copy of its own data, which is
 * exactly what was checked; any other comes back as every problem found, none naming content of the
 * payload.
 *
 * The payload is refused with a single problem, and read no further, when it:
 * - is not a map, at `(root)`;
 * - throws when read, through a getter or a proxy, at `(root)` under the read rule;
 * - has a `payloadVersion` that is absent or other than the number 1, at `payloadVersion`.
 *
 * Otherwise every broken rule among these is reported:
 * - every member is present, and the root carries no other;
 * - `sub` is a non-empty string, or `null` for anonymous access;
 * - `iss` and `aud` are non-empty strings;
 * - `iat`, `exp` and `generatedAt` are non-negative integers, `exp` later than `iat` and
 *   `generatedAt` no later than `iat`;
 * - `permissions` is a map in which each resource holds at least one category, each category entry
 *   is a map naming at least one entity, and a `field` entity maps at least one field category;
 * - a resource identifier is neither empty nor `__proto__`, and holds no marker read specially by
 *   Arranger;
 * - a category name has the scoped form, with a name other than `__proto__`;
 * - an action list is non-empty, unrepeated and within its entity's vocabulary;
 * - `globalCategories` lists distinct concrete global categories;
 * - `resourceCategories` lists distinct resource categories under exactly the resources named in
 *   `permissions`;
 * - every category held on a resource is `global.unmarked`, or listed for it in `globalCategories`
 *   or `resourceCategories`;
 * - `servedResources` lists distinct resource identifiers, every resource named in `permissions` or
 *   `resourceCategories` among them;
 * - `globalCategories`, `resourceCategories` and `servedResources` are present even when they list
 *   nothing, so an absent or `null` one is refused rather than read as none.
 *
 * An entity key unknown to version 1 is accepted without its contents being read, unless it is
 * `__proto__`. An unknown key at any other level is refused.
 *
 * @param value the decrypted payload, as parsed, untrusted.
 */
export const validatePayload = (value: unknown): PayloadValidationResult => {
  const {
    problems: [firstProblem, ...otherProblems],
    snapshot,
  } = checkSnapshot(value, payloadProblems);

  return firstProblem
    ? { problems: [firstProblem, ...otherProblems], success: false }
    : { payload: snapshot as PermissionsPayload, success: true };
};
