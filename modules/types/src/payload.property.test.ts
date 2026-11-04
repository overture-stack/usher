import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import fastCheck, { type Arbitrary } from 'fast-check';

import {
  type ArtifactAction,
  type DataEntity,
  type FieldAction,
  PAYLOAD_RULES,
  type PermissionsPayload,
  type RecordAction,
  type RevisionAction,
  validatePayload,
} from './payload.js';
import { READ_RULE, ROOT_POSITION } from './problems.js';
import {
  ABSENCES,
  type Absence,
  applicable,
  assertOwnDataCopy,
  assertRefusedWithOneOf,
  type DataRecord,
  describedBy,
  freshKey,
  insertedAt,
  isDataRecord,
  keysOf,
  literalTextOf,
  type Mutation,
  type NonEmptyList,
  oneOf,
  PLAIN_TEXT,
  PROTOTYPE_MEMBER_NAMES,
  siteAmong,
  type TextArbitraries,
  unreadableOf,
  usableKey,
  withAbsentMember,
  withMember,
  withoutMember,
  withRenamedMember,
} from './propertySupport.js';
import { assertCarriesNoInput } from './testSupport.js';

const RECORD_ACTIONS = keysOf({
  count: true,
  create: true,
  delete: true,
  export: true,
  update: true,
  view: true,
} satisfies Readonly<Record<RecordAction, true>>);

const FIELD_ACTIONS = keysOf({
  count: true,
  export: true,
  update: true,
  view: true,
} satisfies Readonly<Record<FieldAction, true>>);

const REVISION_ACTIONS = keysOf({
  export: true,
  view: true,
} satisfies Readonly<Record<RevisionAction, true>>);

const ARTIFACT_ACTIONS = keysOf({
  count: true,
  create: true,
  delete: true,
  export: true,
  update: true,
  view: true,
} satisfies Readonly<Record<ArtifactAction, true>>);

const LIST_VOCABULARIES: ReadonlyMap<string, NonEmptyList<string>> = new Map(
  Object.entries({
    artifact: ARTIFACT_ACTIONS,
    record: RECORD_ACTIONS,
    revision: REVISION_ACTIONS,
  } satisfies Readonly<
    Record<Exclude<DataEntity, 'field'>, NonEmptyList<string>>
  >),
);

const KNOWN_ENTITIES: ReadonlySet<string> = new Set(
  keysOf({
    artifact: true,
    field: true,
    record: true,
    revision: true,
  } satisfies Readonly<Record<DataEntity, true>>),
);

const MEMBER_RULES = {
  aud: PAYLOAD_RULES.audNonEmpty,
  exp: PAYLOAD_RULES.expTimestamp,
  generatedAt: PAYLOAD_RULES.generatedAtTimestamp,
  globalCategories: PAYLOAD_RULES.globalCategories,
  iat: PAYLOAD_RULES.iatTimestamp,
  iss: PAYLOAD_RULES.issNonEmpty,
  payloadVersion: PAYLOAD_RULES.payloadVersion,
  permissions: PAYLOAD_RULES.permissionsIsMap,
  resourceCategories: PAYLOAD_RULES.resourceCategoriesIsMap,
  servedResources: PAYLOAD_RULES.servedResources,
  sub: PAYLOAD_RULES.sub,
} satisfies Readonly<Record<keyof PermissionsPayload, string>>;

const PAYLOAD_MEMBERS = keysOf(MEMBER_RULES);

const WRONG_TYPES: Readonly<
  Record<keyof PermissionsPayload, NonEmptyList<unknown>>
> = {
  aud: [42, true, {}, ['arranger-prod']],
  exp: ['1767225900', true, {}, [1_767_225_900]],
  generatedAt: ['1767225600', true, {}, [1_767_225_600]],
  globalCategories: ['global.controlled', 42, true, {}],
  iat: ['1767225600', true, {}, [1_767_225_600]],
  iss: [42, true, {}, ['https://usher.example.org']],
  payloadVersion: ['1', true, {}, [1]],
  permissions: ['map', 42, true, [{}]],
  resourceCategories: ['map', 42, true, [['resource.pilot']]],
  servedResources: ['HEART_STUDY', 42, true, { HEART_STUDY: true }],
  sub: [42, true, {}, ['subject-id']],
};

/**
 * The absence that is a valid value for a member, so a mutation meaning to remove the member deletes
 * it instead: anonymous access is a null subject, Usher may define no global category, and an
 * audience may serve no resource. That last is valid only beside permissions naming none, so
 * emptying `servedResources` beside permissions naming some is a mutation of its own.
 */
const VALID_ABSENCES: Readonly<
  Partial<Record<keyof PermissionsPayload, Absence>>
> = {
  globalCategories: 'empty list',
  servedResources: 'empty list',
  sub: 'null',
};

const TIMESTAMP_MEMBERS = ['iat', 'exp', 'generatedAt'] as const;

const UNMARKED = 'global.unmarked';

const RESOURCE_POSITION = 'permissions.<resource>';
const CATEGORY_POSITION = `${RESOURCE_POSITION}.<category>`;
const ENTITY_POSITION = `${CATEGORY_POSITION}.<entity>`;
const FIELD_POSITION = `${CATEGORY_POSITION}.field`;
const FIELD_CATEGORY_POSITION = `${FIELD_POSITION}.<category>`;
const RESOURCE_CATEGORIES_POSITION = 'resourceCategories.<resource>';

type GeneratedPayload = {
  aud: string;
  exp: number;
  generatedAt: number;
  globalCategories: readonly string[];
  iat: number;
  iss: string;
  payloadVersion: 1;
  permissions: Readonly<Record<string, Readonly<Record<string, DataRecord>>>>;
  resourceCategories: Readonly<Record<string, readonly string[]>>;
  servedResources: readonly string[];
  sub: string | null;
};

interface PayloadArbitraries {
  /** A category name of the scoped form. */
  categoryName: Arbitrary<string>;

  /** A concrete global category name, never `global.unmarked`. */
  globalCategoryName: Arbitrary<string>;

  /** A category name outside the scoped form, `__proto__` included. */
  malformedCategory: Arbitrary<string>;

  /**
   * A payload holding to version 1: every held category is `global.unmarked` or listed,
   * `resourceCategories` names exactly the resources `permissions` names, and `servedResources`
   * lists those and up to two more on which nothing is held.
   */
  payload: Arbitrary<GeneratedPayload>;

  /** A usable resource identifier. */
  resource: Arbitrary<string>;

  /** A resource category name, never `resource.unmarked`. */
  resourceCategoryName: Arbitrary<string>;

  /**
   * A resource identifier that is empty, `__proto__`, or holds a marker read specially by Arranger.
   */
  unusableResource: Arbitrary<string>;
}

const actionListOf = (vocabulary: NonEmptyList<string>): Arbitrary<string[]> =>
  fastCheck.shuffledSubarray([...vocabulary], { minLength: 1 });

const payloadArbitrariesOf = (text: TextArbitraries): PayloadArbitraries => {
  const categoryBase = text.nonEmpty.map((name) =>
    usableKey(name.replaceAll('.', '~')),
  );
  const categoryName = fastCheck
    .tuple(fastCheck.constantFrom('global', 'resource'), categoryBase)
    .map(([scope, name]) => `${scope}.${name}`);
  const concreteBase = categoryBase.map((name) =>
    freshKey(new Set(['unmarked']), name),
  );
  const globalCategoryName = concreteBase.map((name) => `global.${name}`);
  const resourceCategoryName = concreteBase.map((name) => `resource.${name}`);
  const resource = literalTextOf(text).nonEmpty.map(usableKey);
  const fieldMap = fastCheck
    .uniqueArray(fastCheck.tuple(categoryName, actionListOf(FIELD_ACTIONS)), {
      maxLength: 3,
      minLength: 1,
      selector: ([name]) => name,
    })
    .map((entries) => Object.fromEntries(entries));
  const unknownEntity = fastCheck.tuple(
    text.nonEmpty.map((key) =>
      KNOWN_ENTITIES.has(key) || key === '__proto__' ? `${key}~` : key,
    ),
    fastCheck.jsonValue({ maxDepth: 2 }),
  );
  const categoryEntry = fastCheck
    .tuple(
      fastCheck.record(
        {
          artifact: actionListOf(ARTIFACT_ACTIONS),
          field: fieldMap,
          record: actionListOf(RECORD_ACTIONS),
          revision: actionListOf(REVISION_ACTIONS),
        },
        { requiredKeys: [] },
      ),
      fastCheck.uniqueArray(unknownEntity, {
        maxLength: 2,
        selector: ([key]) => key,
      }),
      actionListOf(RECORD_ACTIONS),
    )
    .map(([known, unknown, fallback]): DataRecord => {
      const entities = [...Object.entries(known), ...unknown];

      return Object.fromEntries(
        entities.length > 0 ? entities : [['record', fallback]],
      );
    });
  const grants = fastCheck.uniqueArray(
    fastCheck.tuple(
      resource,
      fastCheck.uniqueArray(resourceCategoryName, { maxLength: 2 }),
      fastCheck.array(fastCheck.tuple(fastCheck.nat(), categoryEntry), {
        maxLength: 3,
        minLength: 1,
      }),
    ),
    { maxLength: 3, selector: ([identifier]) => identifier },
  );
  const timestamps = fastCheck
    .tuple(
      fastCheck.integer({ max: Number.MAX_SAFE_INTEGER - 1, min: 0 }),
      fastCheck.nat(),
      fastCheck.nat(),
    )
    .map(([iat, expiresAfter, generatedBefore]) => ({
      exp: iat + 1 + (expiresAfter % (Number.MAX_SAFE_INTEGER - iat)),
      generatedAt: iat - (generatedBefore % (iat + 1)),
      iat,
    }));
  const payload = fastCheck
    .tuple(
      grants,
      fastCheck.uniqueArray(globalCategoryName, { maxLength: 3 }),
      timestamps,
      fastCheck.oneof(fastCheck.constant(null), text.nonEmpty),
      text.nonEmpty,
      text.nonEmpty,
      fastCheck.uniqueArray(resource, { maxLength: 2 }),
    )
    .map(
      ([
        held,
        globalCategories,
        { exp, generatedAt, iat },
        sub,
        iss,
        aud,
        unheld,
      ]): GeneratedPayload => ({
        aud,
        exp,
        generatedAt,
        globalCategories,
        iat,
        iss,
        payloadVersion: 1,
        permissions: Object.fromEntries(
          held.map(([identifier, ownCategories, picks]) => {
            const holdable = [UNMARKED, ...globalCategories, ...ownCategories];

            return [
              identifier,
              Object.fromEntries(
                picks.map(([pick, entry]) => [
                  holdable[pick % holdable.length] ?? UNMARKED,
                  entry,
                ]),
              ),
            ];
          }),
        ),
        resourceCategories: Object.fromEntries(
          held.map(([identifier, ownCategories]) => [
            identifier,
            ownCategories,
          ]),
        ),
        servedResources: Array.from(
          new Set([...unheld, ...held.map(([identifier]) => identifier)]),
        ),
        sub,
      }),
    );
  const malformedCategory = fastCheck.oneof(
    fastCheck.constantFrom(
      '',
      '__proto__',
      'global',
      'global.',
      'global.__proto__',
      'resource.',
      'resource.__proto__',
      'Global.unmarked',
      ' global.unmarked',
      '.unmarked',
      'global..unmarked',
      'local.unmarked',
    ),
    categoryBase,
    fastCheck
      .tuple(categoryBase, categoryBase)
      .map(([name, more]) => `global.${name}.${more}`),
    fastCheck
      .tuple(text.any, categoryBase)
      .map(
        ([scope, name]) =>
          `${freshKey(new Set(['global', 'resource']), scope.replaceAll('.', '~'))}.${name}`,
      ),
  );
  const unusableResource = fastCheck.oneof(
    fastCheck.constantFrom('', '__proto__'),
    fastCheck
      .tuple(
        text.any,
        fastCheck.constantFrom('*', 'set_id:', '__missing__'),
        text.any,
      )
      .map(([before, marker, after]) => `${before}${marker}${after}`),
  );

  return {
    categoryName,
    globalCategoryName,
    malformedCategory,
    payload,
    resource,
    resourceCategoryName,
    unusableResource,
  };
};

const updatedAt = (
  value: unknown,
  keys: readonly string[],
  update: (current: unknown) => unknown,
): unknown => {
  const [key, ...rest] = keys;

  if (key === undefined) {
    return update(value);
  }

  return isDataRecord(value)
    ? withMember(value, key, updatedAt(value[key], rest, update))
    : value;
};

const changingMap =
  (change: (record: DataRecord) => DataRecord) =>
  (current: unknown): unknown =>
    isDataRecord(current) ? change(current) : current;

interface CategorySite {
  category: string;
  resource: string;
}

interface ActionSite {
  actions: readonly unknown[];
  keys: readonly string[];
  position: string;
  vocabulary: NonEmptyList<string>;
}

const categorySitesOf = (payload: GeneratedPayload): readonly CategorySite[] =>
  Object.entries(payload.permissions).flatMap(([resource, entry]) =>
    Object.keys(entry).map((category) => ({ category, resource })),
  );

const actionSitesOf = (payload: GeneratedPayload): readonly ActionSite[] =>
  categorySitesOf(payload).flatMap(({ category, resource }) =>
    Object.entries(payload.permissions[resource]?.[category] ?? {}).flatMap(
      ([entity, value]): readonly ActionSite[] => {
        const keys = ['permissions', resource, category, entity];
        const vocabulary = LIST_VOCABULARIES.get(entity);

        if (entity === 'field' && isDataRecord(value)) {
          return Object.entries(value).map(([fieldCategory, actions]) => ({
            actions: Array.isArray(actions) ? actions : [],
            keys: [...keys, fieldCategory],
            position: FIELD_CATEGORY_POSITION,
            vocabulary: FIELD_ACTIONS,
          }));
        }

        return vocabulary && Array.isArray(value)
          ? [
              {
                actions: value,
                keys,
                position: `${CATEGORY_POSITION}.${entity}`,
                vocabulary,
              },
            ]
          : [];
      },
    ),
  );

const mapSitesOf = (
  payload: GeneratedPayload,
): readonly (readonly string[])[] => [
  [],
  ['permissions'],
  ['resourceCategories'],
  ...Object.keys(payload.permissions).map((resource) => [
    'permissions',
    resource,
  ]),
  ...categorySitesOf(payload).flatMap(({ category, resource }) => [
    ['permissions', resource, category],
    ...(isDataRecord(payload.permissions[resource]?.[category]?.['field'])
      ? [['permissions', resource, category, 'field']]
      : []),
  ]),
];

const refusal = (
  kind: string,
  changed: unknown,
  position: string,
  rule: string,
): Mutation => ({ changed, expected: [{ position, rule }], kind });

const outsiderOf = (
  vocabulary: NonEmptyList<string>,
  text: TextArbitraries,
): Arbitrary<unknown> => {
  const inside: ReadonlySet<string> = new Set(vocabulary);
  const named = [
    ...RECORD_ACTIONS,
    'read',
    'READ',
    'View',
    ' view',
    'view ',
    '',
    '__proto__',
    ...PROTOTYPE_MEMBER_NAMES,
  ].filter((action) => !inside.has(action));

  return fastCheck.oneof(
    fastCheck.constantFrom(...(named.length > 0 ? named : ['read'])),
    text.any.map((action) => freshKey(inside, action)),
    fastCheck.constantFrom<unknown>(1, null, true, {}, ['view']),
  );
};

const payloadMutationsOf = (
  payload: GeneratedPayload,
  text: TextArbitraries,
): NonEmptyList<Arbitrary<Mutation>> => {
  const {
    globalCategoryName,
    malformedCategory,
    resource,
    resourceCategoryName,
    unusableResource,
  } = payloadArbitrariesOf(text);
  const resources = Object.keys(payload.permissions);
  const resourceSite = siteAmong(resources);
  const servedSite = siteAmong(payload.servedResources);
  const categorySite = siteAmong(categorySitesOf(payload));
  const listedCategorySite = siteAmong(
    categorySitesOf(payload).filter(({ category }) => category !== UNMARKED),
  );
  const listedNames: ReadonlySet<string> = new Set([
    UNMARKED,
    ...payload.globalCategories,
    ...Object.values(payload.resourceCategories).flat(),
  ]);
  const actionSite = siteAmong(actionSitesOf(payload));
  const fieldSite = siteAmong(
    categorySitesOf(payload).filter(({ category, resource: held }) =>
      isDataRecord(payload.permissions[held]?.[category]?.['field']),
    ),
  );
  const fieldCategorySite = siteAmong(
    actionSitesOf(payload).filter(
      ({ position }) => position === FIELD_CATEGORY_POSITION,
    ),
  );
  const withOwnCategories = (
    changed: unknown,
    held: string,
    update: (ownCategories: readonly string[]) => unknown,
  ): unknown =>
    updatedAt(changed, ['resourceCategories', held], () =>
      update(payload.resourceCategories[held] ?? []),
    );
  const withGlobalCategories = (
    update: (globalCategories: readonly string[]) => readonly string[],
  ): unknown =>
    withMember(payload, 'globalCategories', update(payload.globalCategories));
  const rootAbsence = fastCheck
    .tuple(
      fastCheck.constantFrom(...PAYLOAD_MEMBERS),
      fastCheck.constantFrom(...ABSENCES),
      fastCheck.nat(),
    )
    .map(([member, chosen, wrongIndex]) => {
      const absence: Absence =
        VALID_ABSENCES[member] === chosen ? 'deleted' : chosen;
      const wrongTypes = WRONG_TYPES[member];

      return refusal(
        'a root member gone missing',
        withAbsentMember(
          payload,
          member,
          absence,
          wrongTypes[wrongIndex % wrongTypes.length],
        ),
        member,
        MEMBER_RULES[member],
      );
    });

  const mutations = applicable<Mutation>([
    rootAbsence,
    fastCheck
      .constantFrom<unknown>(undefined, null, '', 1, true, [payload], 'payload')
      .map((changed) =>
        refusal(
          'a payload that is not a map',
          changed,
          ROOT_POSITION,
          PAYLOAD_RULES.payloadIsMap,
        ),
      ),
    fastCheck
      .tuple(
        fastCheck.oneof(
          fastCheck.constant('__proto__'),
          text.any.map((key) => freshKey(new Set(PAYLOAD_MEMBERS), key)),
        ),
        fastCheck.oneof(fastCheck.constant(undefined), fastCheck.jsonValue()),
      )
      .map(([key, value]) =>
        refusal(
          'a member version 1 does not define',
          withMember(payload, key, value),
          ROOT_POSITION,
          PAYLOAD_RULES.rootMembers,
        ),
      ),
    fastCheck
      .oneof(
        fastCheck.constantFrom<unknown>(
          0,
          2,
          -1,
          1.5,
          '1',
          true,
          Number.NaN,
          [1],
        ),
        fastCheck.integer().map((version) => (version === 1 ? 2 : version)),
      )
      .map((payloadVersion) =>
        refusal(
          'a version other than 1',
          withMember(payload, 'payloadVersion', payloadVersion),
          'payloadVersion',
          PAYLOAD_RULES.payloadVersion,
        ),
      ),
    fastCheck
      .tuple(
        fastCheck.constantFrom(...TIMESTAMP_MEMBERS),
        fastCheck.oneof(
          fastCheck.constantFrom(
            -1,
            0.5,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            Number.NEGATIVE_INFINITY,
            Number.MAX_SAFE_INTEGER + 1,
            2 ** 64,
          ),
          fastCheck.integer({ max: -1 }),
          fastCheck
            .double({ noNaN: true })
            .map((value) =>
              Number.isSafeInteger(value) ? -1 - Math.abs(value) : value,
            ),
        ),
      )
      .map(([member, value]) =>
        refusal(
          'a timestamp that is no non-negative safe integer',
          withMember(payload, member, value),
          member,
          MEMBER_RULES[member],
        ),
      ),
    fastCheck
      .nat()
      .map((before) =>
        refusal(
          'an expiry no later than the issue',
          withMember(
            payload,
            'exp',
            payload.iat - (before % (payload.iat + 1)),
          ),
          'exp',
          PAYLOAD_RULES.expAfterIat,
        ),
      ),
    fastCheck
      .nat()
      .map((after) =>
        refusal(
          'permissions computed after the issue',
          withMember(
            payload,
            'generatedAt',
            payload.iat + 1 + (after % (Number.MAX_SAFE_INTEGER - payload.iat)),
          ),
          'generatedAt',
          PAYLOAD_RULES.generatedAtNotAfterIat,
        ),
      ),
    resourceSite &&
      fastCheck.tuple(resourceSite, unusableResource).map(([held, unusable]) =>
        refusal(
          'an unusable resource identifier',
          updatedAt(
            updatedAt(
              payload,
              ['permissions'],
              changingMap((map) => withRenamedMember(map, held, unusable)),
            ),
            ['resourceCategories'],
            changingMap((map) => withRenamedMember(map, held, unusable)),
          ),
          RESOURCE_POSITION,
          PAYLOAD_RULES.resourceIdentifier,
        ),
      ),
    fastCheck
      .tuple(unusableResource, resourceCategoryName)
      .map(([unusable, ownCategory]) =>
        refusal(
          'an unusable resource identifier in resourceCategories',
          updatedAt(
            payload,
            ['resourceCategories'],
            changingMap((map) => withMember(map, unusable, [ownCategory])),
          ),
          RESOURCE_CATEGORIES_POSITION,
          PAYLOAD_RULES.resourceIdentifier,
        ),
      ),
    categorySite &&
      fastCheck
        .tuple(categorySite, malformedCategory)
        .map(([{ category, resource: held }, malformed]) =>
          refusal(
            'a held category named outside the scoped form',
            updatedAt(
              payload,
              ['permissions', held],
              changingMap((map) => withRenamedMember(map, category, malformed)),
            ),
            CATEGORY_POSITION,
            PAYLOAD_RULES.categoryForm,
          ),
        ),
    fieldCategorySite &&
      fastCheck
        .tuple(fieldCategorySite, malformedCategory)
        .map(([{ keys }, malformed]) =>
          refusal(
            'a field category named outside the scoped form',
            updatedAt(
              payload,
              keys.slice(0, -1),
              changingMap((map) =>
                withRenamedMember(map, keys.at(-1) ?? '', malformed),
              ),
            ),
            FIELD_CATEGORY_POSITION,
            PAYLOAD_RULES.categoryForm,
          ),
        ),
    listedCategorySite?.map(({ category, resource: held }) =>
      refusal(
        'a held category dropped from the list naming it',
        withOwnCategories(
          withGlobalCategories((globalCategories) =>
            globalCategories.filter((name) => name !== category),
          ),
          held,
          (ownCategories) => ownCategories.filter((name) => name !== category),
        ),
        CATEGORY_POSITION,
        PAYLOAD_RULES.heldCategoryListed,
      ),
    ),
    categorySite &&
      fastCheck
        .tuple(
          categorySite,
          fastCheck.oneof(globalCategoryName, resourceCategoryName),
        )
        .map(([{ category, resource: held }, unlisted]) =>
          refusal(
            'a held category renamed to one no list names',
            updatedAt(
              payload,
              ['permissions', held],
              changingMap((map) =>
                withRenamedMember(
                  map,
                  category,
                  freshKey(
                    new Set([...listedNames, ...Object.keys(map)]),
                    unlisted,
                  ),
                ),
              ),
            ),
            CATEGORY_POSITION,
            PAYLOAD_RULES.heldCategoryListed,
          ),
        ),
    fastCheck
      .tuple(
        fastCheck.oneof(
          malformedCategory,
          fastCheck.constant(UNMARKED),
          resourceCategoryName,
        ),
        fastCheck.nat(),
      )
      .map(([unlistable, index]) =>
        refusal(
          'globalCategories naming no concrete global category',
          withGlobalCategories((globalCategories) =>
            insertedAt(globalCategories, index, unlistable),
          ),
          'globalCategories',
          PAYLOAD_RULES.globalCategories,
        ),
      ),
    fastCheck
      .tuple(globalCategoryName, fastCheck.nat(), fastCheck.nat())
      .map(([twice, first, second]) =>
        refusal(
          'globalCategories naming a category twice',
          withGlobalCategories((globalCategories) =>
            insertedAt(
              insertedAt(globalCategories, first, twice),
              second,
              twice,
            ),
          ),
          'globalCategories',
          PAYLOAD_RULES.globalCategories,
        ),
      ),
    resourceSite &&
      fastCheck
        .tuple(
          resourceSite,
          fastCheck.oneof(
            malformedCategory,
            fastCheck.constantFrom('resource.unmarked', UNMARKED),
            globalCategoryName,
          ),
          fastCheck.nat(),
        )
        .map(([held, unlistable, index]) =>
          refusal(
            'a resource category list naming no resource category',
            withOwnCategories(payload, held, (ownCategories) =>
              insertedAt(ownCategories, index, unlistable),
            ),
            RESOURCE_CATEGORIES_POSITION,
            PAYLOAD_RULES.resourceCategoryList,
          ),
        ),
    resourceSite &&
      fastCheck
        .tuple(
          resourceSite,
          resourceCategoryName,
          fastCheck.nat(),
          fastCheck.nat(),
        )
        .map(([held, twice, first, second]) =>
          refusal(
            'a resource category list naming a category twice',
            withOwnCategories(payload, held, (ownCategories) =>
              insertedAt(
                insertedAt(ownCategories, first, twice),
                second,
                twice,
              ),
            ),
            RESOURCE_CATEGORIES_POSITION,
            PAYLOAD_RULES.resourceCategoryList,
          ),
        ),
    resourceSite &&
      fastCheck
        .tuple(
          resourceSite,
          fastCheck.constantFrom<unknown>(
            undefined,
            null,
            '',
            'resource.pilot',
            {},
            1,
          ),
        )
        .map(([held, notAList]) =>
          refusal(
            'a resource category list that is no list',
            withOwnCategories(payload, held, () => notAList),
            RESOURCE_CATEGORIES_POSITION,
            PAYLOAD_RULES.resourceCategoryList,
          ),
        ),
    fastCheck
      .tuple(
        resource,
        fastCheck.uniqueArray(resourceCategoryName, { maxLength: 2 }),
      )
      .map(([extra, ownCategories]) =>
        refusal(
          'resource categories listed for a resource absent from permissions',
          updatedAt(
            payload,
            ['resourceCategories'],
            changingMap((map) =>
              withMember(
                map,
                freshKey(new Set(resources), extra),
                ownCategories,
              ),
            ),
          ),
          RESOURCE_CATEGORIES_POSITION,
          PAYLOAD_RULES.resourceCategoriesNamesNoOtherResource,
        ),
      ),
    resourceSite?.map((held) =>
      refusal(
        'a held resource left out of resourceCategories',
        updatedAt(
          payload,
          ['resourceCategories'],
          changingMap((map) => withoutMember(map, held)),
        ),
        RESOURCE_CATEGORIES_POSITION,
        PAYLOAD_RULES.resourceCategoriesNamesEveryHeldResource,
      ),
    ),
    resourceSite?.map((held) =>
      refusal(
        'a held resource dropped from permissions while still in resourceCategories',
        updatedAt(
          payload,
          ['permissions'],
          changingMap((map) => withoutMember(map, held)),
        ),
        RESOURCE_CATEGORIES_POSITION,
        PAYLOAD_RULES.resourceCategoriesNamesNoOtherResource,
      ),
    ),
    resourceSite?.map((held) =>
      refusal(
        'a named resource left out of servedResources',
        withMember(
          payload,
          'servedResources',
          payload.servedResources.filter((resource) => resource !== held),
        ),
        RESOURCE_POSITION,
        PAYLOAD_RULES.servedResourcesListsNamedResources,
      ),
    ),
    resources.length > 0
      ? fastCheck.constant(
          refusal(
            'servedResources emptied beside permissions naming a resource',
            withMember(payload, 'servedResources', []),
            RESOURCE_POSITION,
            PAYLOAD_RULES.servedResourcesListsNamedResources,
          ),
        )
      : undefined,
    servedSite &&
      fastCheck
        .tuple(servedSite, fastCheck.nat())
        .map(([twice, index]) =>
          refusal(
            'servedResources naming a resource twice',
            withMember(
              payload,
              'servedResources',
              insertedAt(payload.servedResources, index, twice),
            ),
            'servedResources',
            PAYLOAD_RULES.servedResources,
          ),
        ),
    fastCheck
      .tuple(
        fastCheck.oneof(
          unusableResource,
          fastCheck.constantFrom<unknown>(42, null, true, {}, ['HEART_STUDY']),
        ),
        fastCheck.nat(),
      )
      .map(([unusable, index]) =>
        refusal(
          'servedResources holding no usable resource identifier',
          withMember(
            payload,
            'servedResources',
            insertedAt<unknown>(payload.servedResources, index, unusable),
          ),
          'servedResources',
          PAYLOAD_RULES.servedResources,
        ),
      ),
    resourceSite &&
      fastCheck
        .tuple(
          resourceSite,
          fastCheck.constantFrom<unknown>(
            {},
            [],
            null,
            undefined,
            '',
            1,
            'global.unmarked',
            [{ record: ['view'] }],
          ),
        )
        .map(([held, entry]) =>
          refusal(
            'a resource entry naming no category',
            updatedAt(payload, ['permissions', held], () => entry),
            RESOURCE_POSITION,
            PAYLOAD_RULES.resourceHoldsCategory,
          ),
        ),
    categorySite &&
      fastCheck
        .tuple(
          categorySite,
          fastCheck.constantFrom<unknown>(
            {},
            [],
            null,
            undefined,
            '',
            1,
            'record',
            ['record'],
          ),
        )
        .map(([{ category, resource: held }, entry]) =>
          refusal(
            'a category entry naming no entity',
            updatedAt(payload, ['permissions', held, category], () => entry),
            CATEGORY_POSITION,
            PAYLOAD_RULES.categoryEntryNamesEntity,
          ),
        ),
    categorySite &&
      fastCheck
        .tuple(
          categorySite,
          fastCheck.oneof(actionListOf(RECORD_ACTIONS), fastCheck.jsonValue()),
        )
        .map(([{ category, resource: held }, value]) =>
          refusal(
            'an entity named __proto__',
            updatedAt(
              payload,
              ['permissions', held, category],
              changingMap((map) => withMember(map, '__proto__', value)),
            ),
            ENTITY_POSITION,
            PAYLOAD_RULES.entityKey,
          ),
        ),
    actionSite?.map(({ keys, position }) =>
      refusal(
        'an empty action list',
        updatedAt(payload, keys, () => []),
        position,
        PAYLOAD_RULES.actionListNotEmpty,
      ),
    ),
    actionSite &&
      fastCheck
        .tuple(actionSite, fastCheck.nat(), fastCheck.nat())
        .map(([{ actions, keys, position }, from, to]) =>
          refusal(
            'an action list naming an action twice',
            updatedAt(payload, keys, () =>
              insertedAt(actions, to, actions[from % actions.length]),
            ),
            position,
            PAYLOAD_RULES.actionListNamesEachOnce,
          ),
        ),
    actionSite?.chain(({ actions, keys, position, vocabulary }) =>
      fastCheck
        .tuple(outsiderOf(vocabulary, text), fastCheck.nat())
        .map(([outsider, index]) =>
          refusal(
            "an action outside its entity's vocabulary",
            updatedAt(payload, keys, () =>
              insertedAt(actions, index, outsider),
            ),
            position,
            PAYLOAD_RULES.actionListVocabulary,
          ),
        ),
    ),
    actionSite &&
      fastCheck
        .tuple(
          actionSite,
          fastCheck.constantFrom<unknown>(
            undefined,
            null,
            '',
            'view',
            { view: true },
            1,
          ),
        )
        .map(([{ keys, position }, notAList]) =>
          refusal(
            'an action list that is no list',
            updatedAt(payload, keys, () => notAList),
            position,
            PAYLOAD_RULES.actionListIsList,
          ),
        ),
    fieldSite &&
      fastCheck
        .tuple(
          fieldSite,
          fastCheck.constantFrom<unknown>(
            {},
            [],
            null,
            undefined,
            '',
            1,
            'global.unmarked',
            ['global.unmarked'],
          ),
        )
        .map(([{ category, resource: held }, field]) =>
          refusal(
            'a field key mapping no field category',
            updatedAt(
              payload,
              ['permissions', held, category, 'field'],
              () => field,
            ),
            FIELD_POSITION,
            PAYLOAD_RULES.fieldMapsCategories,
          ),
        ),
    fastCheck
      .tuple(
        siteAmong(mapSitesOf(payload)) ?? fastCheck.constant([]),
        unreadableOf(text),
      )
      .map(([keys, unreadable]) => ({
        changed: updatedAt(payload, keys, (map) =>
          isDataRecord(map) ? unreadable(map) : map,
        ),
        expected: [{ position: ROOT_POSITION, rule: READ_RULE }],
        kind: 'a map that throws when read',
      })),
  ]);
  const [first, ...others] = mutations;

  if (first) {
    return [first, ...others];
  }

  throw new Error('no mutation applies to the payload');
};

const plain = payloadArbitrariesOf(PLAIN_TEXT);

const payloadMutationOf = (text: TextArbitraries): Arbitrary<Mutation> =>
  payloadArbitrariesOf(text).payload.chain((payload) =>
    oneOf(payloadMutationsOf(payload, text)).map(describedBy),
  );

suite('validatePayload, over generated values', () => {
  suite('the properties', () => {
    test('accepts every generated payload, returning a copy of its own data', () => {
      fastCheck.assert(
        fastCheck.property(plain.payload, (payload) => {
          const result = validatePayload(payload);

          assert.deepEqual(result.success ? [] : result.problems, []);
          assertOwnDataCopy(result.success && result.payload, payload);
        }),
        { numRuns: 300 },
      );
    });

    test('refuses every single forbidden change, for the rule it breaks', () => {
      fastCheck.assert(
        fastCheck.property(
          payloadMutationOf(PLAIN_TEXT),
          ({ changed, expected }) => {
            assertRefusedWithOneOf(validatePayload(changed), expected);
          },
        ),
        { numRuns: 600 },
      );
    });
  });
});
