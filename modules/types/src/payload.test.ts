import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suite, test } from 'node:test';
import { runInNewContext } from 'node:vm';

import * as zod from 'zod';

import {
  type ArtifactAction,
  type CategoryName,
  type CategoryPermissions,
  type ControlEntity,
  type DataEntity,
  type Entity,
  type FieldAction,
  type NonEmpty,
  PAYLOAD_RULES,
  type PermissionsPayload,
  type RecordAction,
  type ResourceIdentifier,
  type ResourcePermissions,
  type RevisionAction,
  validatePayload,
} from './payload.js';
import { READ_RULE } from './problems.js';
import {
  assertAccepted,
  assertCarriesNoInput,
  assertEveryRuleBroken,
  assertInputMarked,
  assertRefused,
  assertRefusedFor,
  LEAK_MARKER,
  LEAK_NUMBER,
  type LeakCase,
  throughJson,
} from './testSupport.js';

const fixtureFileUrl = new URL(
  '../../../.dev/design/conformance/principals.json',
  import.meta.url,
);

const FixtureFileSchema = zod.object({
  principals: zod
    .array(zod.object({ id: zod.string(), payload: zod.unknown() }))
    .min(1),
});

const FixturePayloadSchema = zod.looseObject({
  globalCategories: zod.array(zod.string()),
  permissions: zod.record(
    zod.string(),
    zod.record(zod.string(), zod.unknown()),
  ),
  resourceCategories: zod.record(zod.string(), zod.array(zod.string())),
  servedResources: zod.array(zod.string()),
});

type FixturePayload = zod.infer<typeof FixturePayloadSchema>;

const fixtures = FixtureFileSchema.parse(
  JSON.parse(readFileSync(fixtureFileUrl, 'utf8')),
).principals;

const PROTO = '__proto__';

/** Resource identifiers holding a marker Arranger reads specially, alone or inside a name. */
const MARKER_RESOURCES = [
  '*',
  'HEART_STUDY*',
  'set_id:HEART_STUDY',
  '__missing__',
  'HEART__missing__STUDY',
] as const;

const RESOURCE_POSITION = 'permissions.<resource>';
const CATEGORY_POSITION = 'permissions.<resource>.<category>';
const FIELD_CATEGORY_POSITION =
  'permissions.<resource>.<category>.field.<category>';
const RESOURCE_CATEGORIES_POSITION = 'resourceCategories.<resource>';

/**
 * A payload holding every entity known to the vocabulary, on two resources, one of which holds a
 * category of its own. It lists a global category and a resource category that nothing holds, and
 * serves a resource on which nothing is held.
 */
const validPayload = (): PermissionsPayload => ({
  payloadVersion: 1,
  sub: 'subject-id',
  iss: 'https://usher.example.org',
  aud: 'arranger-prod',
  iat: 1767225600,
  exp: 1767225900,
  generatedAt: 1767225600,
  permissions: {
    HEART_STUDY: {
      'global.controlled': { record: ['count', 'view', 'export'] },
      'global.unmarked': {
        artifact: ['create'],
        field: { 'global.basic': ['view'] },
        record: ['view'],
        revision: ['view'],
      },
      'resource.pilot': { record: ['view'] },
    },
    LUNG_COHORT: { 'global.unmarked': { record: ['view'] } },
  },
  globalCategories: ['global.community-governed', 'global.controlled'],
  resourceCategories: {
    HEART_STUDY: ['resource.clinic', 'resource.pilot'],
    LUNG_COHORT: [],
  },
  servedResources: ['HEART_STUDY', 'LUNG_COHORT', 'REEF_ARCHIVE'],
});

const withMembers = (members: Record<string, unknown>): unknown => ({
  ...validPayload(),
  ...members,
});

const withoutMember = (member: string): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(validPayload()).filter(([key]) => key !== member),
  );

/** One resource, listing no category of its own, whose entry is `resourceEntry`. */
const withResourceEntry = (resourceEntry: unknown): unknown =>
  withMembers({
    permissions: { HEART_STUDY: resourceEntry },
    resourceCategories: { HEART_STUDY: [] },
  });

/** One resource holding `global.unmarked`, whose category entry is `categoryEntry`. */
const withCategoryEntry = (categoryEntry: unknown): unknown =>
  withResourceEntry({ 'global.unmarked': categoryEntry });

/**
 * One resource holding one category, named `categoryName`, with record view, and listing it in the
 * member its scope belongs to: a `resource.` name as the resource's own, any other as global.
 */
const withHeldCategory = (categoryName: string): unknown => {
  const listedAsOwn = categoryName.startsWith('resource.');

  return throughJson(
    withMembers({
      globalCategories: listedAsOwn ? [] : [categoryName],
      permissions: { HEART_STUDY: { [categoryName]: { record: ['view'] } } },
      resourceCategories: { HEART_STUDY: listedAsOwn ? [categoryName] : [] },
    }),
  );
};

/** One resource holding `global.unmarked`, named `resource` in both maps and served. */
const withResourceNamed = (resource: string): unknown =>
  throughJson(
    withMembers({
      permissions: { [resource]: { 'global.unmarked': { record: ['view'] } } },
      resourceCategories: { [resource]: [] },
      servedResources: [resource],
    }),
  );

const withServedResources = (servedResources: unknown): unknown =>
  withMembers({ servedResources });

/** One resource holding `global.unmarked` with record view, beside `globalCategories`. */
const withGlobalCategories = (globalCategories: unknown): unknown =>
  withMembers({
    globalCategories,
    permissions: { HEART_STUDY: { 'global.unmarked': { record: ['view'] } } },
    resourceCategories: { HEART_STUDY: [] },
  });

/** One resource holding `global.unmarked` with record view, listing `ownCategories` as its own. */
const withOwnCategories = (ownCategories: unknown): unknown =>
  withMembers({
    globalCategories: [],
    permissions: { HEART_STUDY: { 'global.unmarked': { record: ['view'] } } },
    resourceCategories: { HEART_STUDY: ownCategories },
  });

const withFixtureMembers = (
  payload: FixturePayload,
  members: Record<string, unknown>,
): unknown => ({ ...payload, ...members });

/** A concrete global category held on some resource of `payload`, when one is. */
const heldGlobalCategory = (payload: FixturePayload): string | undefined =>
  Object.values(payload.permissions)
    .flatMap((categories) => Object.keys(categories))
    .find(
      (category) =>
        category.startsWith('global.') && category !== 'global.unmarked',
    );

suite('validatePayload', () => {
  suite('the conformance fixtures', () => {
    for (const { id, payload } of fixtures) {
      test(`accepts the ${id} payload and returns it unchanged`, () => {
        const result = validatePayload(payload);

        assertAccepted(result);
        assert.deepEqual(result.success && result.payload, payload);
      });

      const fixturePayload = FixturePayloadSchema.parse(payload);

      test(`refuses the ${id} payload with resource categories listed for a resource absent from permissions`, () => {
        const mutated = withFixtureMembers(fixturePayload, {
          resourceCategories: {
            ...fixturePayload.resourceCategories,
            UNLISTED_RESOURCE: [],
          },
        });

        const result = validatePayload(mutated);

        assertRefusedFor(
          result,
          RESOURCE_CATEGORIES_POSITION,
          PAYLOAD_RULES.resourceCategoriesNamesNoOtherResource,
        );
      });

      const [firstListed] = Object.keys(fixturePayload.resourceCategories);

      if (firstListed !== undefined) {
        test(`refuses the ${id} payload with a resource named in permissions missing from resourceCategories`, () => {
          const mutated = withFixtureMembers(fixturePayload, {
            resourceCategories: Object.fromEntries(
              Object.entries(fixturePayload.resourceCategories).filter(
                ([resource]) => resource !== firstListed,
              ),
            ),
          });

          const result = validatePayload(mutated);

          assertRefusedFor(
            result,
            RESOURCE_CATEGORIES_POSITION,
            PAYLOAD_RULES.resourceCategoriesNamesEveryHeldResource,
          );
        });
      }

      const heldGlobal = heldGlobalCategory(fixturePayload);

      if (heldGlobal !== undefined) {
        test(`refuses the ${id} payload with a held global category left out of globalCategories`, () => {
          const mutated = withFixtureMembers(fixturePayload, {
            globalCategories: fixturePayload.globalCategories.filter(
              (category) => category !== heldGlobal,
            ),
          });

          const result = validatePayload(mutated);

          assertRefusedFor(
            result,
            CATEGORY_POSITION,
            PAYLOAD_RULES.heldCategoryListed,
          );
        });
      }

      const [firstHeld] = Object.keys(fixturePayload.permissions);

      if (firstHeld !== undefined) {
        test(`refuses the ${id} payload with a resource named in permissions left out of servedResources`, () => {
          const mutated = withFixtureMembers(fixturePayload, {
            servedResources: fixturePayload.servedResources.filter(
              (resource) => resource !== firstHeld,
            ),
          });

          const result = validatePayload(mutated);

          assertRefusedFor(
            result,
            RESOURCE_POSITION,
            PAYLOAD_RULES.servedResourcesListsNamedResources,
          );
        });
      }
    }
  });

  suite('the root', () => {
    test('accepts a payload holding every entity known to the vocabulary', () => {
      const payload = validPayload();

      const result = validatePayload(payload);

      assertAccepted(result);
    });

    test('accepts a principal holding no grants, with permissions and both category members empty', () => {
      const payload = withMembers({
        globalCategories: [],
        permissions: {},
        resourceCategories: {},
      });

      const result = validatePayload(payload);

      assertAccepted(result);
    });

    test('accepts an audience serving no resource, with permissions, resourceCategories and servedResources all empty', () => {
      const payload = withMembers({
        permissions: {},
        resourceCategories: {},
        servedResources: [],
      });

      const result = validatePayload(payload);

      assertAccepted(result);
    });

    test('accepts a null subject, which is anonymous access', () => {
      const payload = withMembers({ sub: null });

      const result = validatePayload(payload);

      assertAccepted(result);
    });

    test('refuses an absent subject, which is malformed rather than anonymous', () => {
      const payload = withoutMember('sub');

      const result = validatePayload(payload);

      assertRefusedFor(result, 'sub', PAYLOAD_RULES.sub);
    });

    for (const sub of [undefined, '', 42, true, {}, ['subject-id']]) {
      test(`refuses a subject of ${JSON.stringify(sub) ?? 'undefined'}, since a subject is a non-empty string or null`, () => {
        const payload = withMembers({ sub });

        const result = validatePayload(payload);

        assertRefusedFor(result, 'sub', PAYLOAD_RULES.sub);
      });
    }

    for (const [member, rule] of [
      ['payloadVersion', PAYLOAD_RULES.payloadVersion],
      ['iss', PAYLOAD_RULES.issNonEmpty],
      ['aud', PAYLOAD_RULES.audNonEmpty],
      ['iat', PAYLOAD_RULES.iatTimestamp],
      ['exp', PAYLOAD_RULES.expTimestamp],
      ['generatedAt', PAYLOAD_RULES.generatedAtTimestamp],
      ['permissions', PAYLOAD_RULES.permissionsIsMap],
    ] as const) {
      test(`refuses a payload missing ${member}`, () => {
        const payload = withoutMember(member);

        const result = validatePayload(payload);

        assertRefusedFor(result, member, rule);
      });
    }

    for (const member of ['categoryVersions', 'extra', PROTO]) {
      test(`refuses an unknown root member named ${member}, since the root is strict`, () => {
        const payload = throughJson(withMembers({ [member]: {} }));

        const result = validatePayload(payload);

        assertRefusedFor(result, '(root)', PAYLOAD_RULES.rootMembers);
      });
    }

    for (const payloadVersion of [0, 2, '1', null]) {
      test(`refuses payloadVersion ${JSON.stringify(payloadVersion)}, since only version 1 is read`, () => {
        const payload = withMembers({ payloadVersion });

        const result = validatePayload(payload);

        assertRefusedFor(
          result,
          'payloadVersion',
          PAYLOAD_RULES.payloadVersion,
        );
      });
    }

    for (const [member, rule] of [
      ['iss', PAYLOAD_RULES.issNonEmpty],
      ['aud', PAYLOAD_RULES.audNonEmpty],
    ] as const) {
      for (const value of ['', 42, null]) {
        test(`refuses ${member} of ${JSON.stringify(value)}, since it must be a non-empty string`, () => {
          const payload = withMembers({ [member]: value });

          const result = validatePayload(payload);

          assertRefusedFor(result, member, rule);
        });
      }
    }

    for (const [member, rule] of [
      ['iat', PAYLOAD_RULES.iatTimestamp],
      ['exp', PAYLOAD_RULES.expTimestamp],
      ['generatedAt', PAYLOAD_RULES.generatedAtTimestamp],
    ] as const) {
      for (const [description, value] of [
        ['a negative number', -1],
        ['a fraction', 1767225600.5],
        ['beyond the safe integer range', 2 ** 53],
        ['infinite', Number.POSITIVE_INFINITY],
        ['a string', '1767225600'],
        ['null', null],
      ] as const) {
        test(`refuses ${member} that is ${description}, since it must be a non-negative safe integer`, () => {
          const payload = withMembers({ [member]: value });

          const result = validatePayload(payload);

          assertRefusedFor(result, member, rule);
        });
      }
    }

    test('accepts zero as a timestamp, since it is a non-negative integer', () => {
      const payload = withMembers({ exp: 300, generatedAt: 0, iat: 0 });

      const result = validatePayload(payload);

      assertAccepted(result);
    });

    test('refuses an expiry equal to the issue time', () => {
      const payload = withMembers({ exp: 1767225600, iat: 1767225600 });

      const result = validatePayload(payload);

      assertRefusedFor(result, 'exp', PAYLOAD_RULES.expAfterIat);
    });

    test('refuses an expiry earlier than the issue time', () => {
      const payload = withMembers({ exp: 1767225000, iat: 1767225600 });

      const result = validatePayload(payload);

      assertRefusedFor(result, 'exp', PAYLOAD_RULES.expAfterIat);
    });

    test('refuses permissions computed later than the token was issued', () => {
      const payload = withMembers({ generatedAt: 1767225601, iat: 1767225600 });

      const result = validatePayload(payload);

      assertRefusedFor(
        result,
        'generatedAt',
        PAYLOAD_RULES.generatedAtNotAfterIat,
      );
    });

    for (const [description, generatedAt] of [
      ['at the issue time', 1767225600],
      ['before the issue time, as a reissue from cache is', 1767225000],
    ] as const) {
      test(`accepts permissions computed ${description}`, () => {
        const payload = withMembers({ generatedAt, iat: 1767225600 });

        const result = validatePayload(payload);

        assertAccepted(result);
      });
    }

    for (const [description, value] of [
      ['undefined', undefined],
      ['null', null],
      ['a number', 42],
      ['a string', 'token'],
      ['an empty list', []],
      ['a list holding a valid payload', [validPayload()]],
      ['a class instance', new (class Payload {})()],
      ['a map', new Map(Object.entries(validPayload()))],
    ] as const) {
      test(`refuses ${description} as a payload, returning the refusal rather than throwing`, () => {
        const result = validatePayload(value);

        assertRefusedFor(result, '(root)', PAYLOAD_RULES.payloadIsMap);
      });
    }
  });

  suite('permissions', () => {
    for (const [description, permissions] of [
      ['a list', []],
      ['null', null],
      ['a string', 'HEART_STUDY'],
      ['a number', 42],
      ['a Map', new Map([['HEART_STUDY', {}]])],
    ] as const) {
      test(`refuses permissions that are ${description}, which is not a plain map`, () => {
        const payload = withMembers({ permissions });

        const result = validatePayload(payload);

        assertRefusedFor(result, 'permissions', PAYLOAD_RULES.permissionsIsMap);
      });
    }

    for (const resourceEntry of [{}, [], null, 'global.unmarked']) {
      test(`refuses a resource entry of ${JSON.stringify(resourceEntry)}, which names no category`, () => {
        const payload = withResourceEntry(resourceEntry);

        const result = validatePayload(payload);

        assertRefusedFor(
          result,
          RESOURCE_POSITION,
          PAYLOAD_RULES.resourceHoldsCategory,
        );
      });
    }

    for (const resource of ['', PROTO]) {
      test(`refuses ${JSON.stringify(resource)} as a resource identifier in permissions`, () => {
        const payload = withResourceNamed(resource);

        const result = validatePayload(payload);

        assertRefusedFor(
          result,
          RESOURCE_POSITION,
          PAYLOAD_RULES.resourceIdentifier,
        );
      });
    }

    for (const resource of MARKER_RESOURCES) {
      test(`refuses ${JSON.stringify(resource)} as a resource identifier in permissions, since it holds a marker read specially by Arranger`, () => {
        const payload = withResourceNamed(resource);

        const result = validatePayload(payload);

        assertRefusedFor(
          result,
          RESOURCE_POSITION,
          PAYLOAD_RULES.resourceIdentifier,
        );
      });
    }

    for (const resource of ['constructor', 'toString', 'hasOwnProperty']) {
      test(`accepts a resource called ${resource}, since an identifier is opaque`, () => {
        const payload = withResourceNamed(resource);

        const result = validatePayload(payload);

        assertAccepted(result);
      });
    }

    for (const categoryName of [
      'open',
      'local.pilot',
      'global.',
      'resource.',
      'global.__proto__',
      'resource.__proto__',
      'global.controlled.extra',
      'Global.controlled',
      '.controlled',
    ]) {
      test(`refuses a category named ${JSON.stringify(categoryName)}, which is outside the scoped category form`, () => {
        const payload = withHeldCategory(categoryName);

        const result = validatePayload(payload);

        assertRefusedFor(result, CATEGORY_POSITION, PAYLOAD_RULES.categoryForm);
      });
    }

    for (const categoryName of [
      'resource.pilot',
      'global.__proto__x',
      'global.constructor',
    ]) {
      test(`accepts a category named ${categoryName}, which has the scoped category form`, () => {
        const payload = withHeldCategory(categoryName);

        const result = validatePayload(payload);

        assertAccepted(result);
      });
    }

    for (const categoryEntry of [{}, [], null, ['view']]) {
      test(`refuses a category entry of ${JSON.stringify(categoryEntry)}, which carries no entity key`, () => {
        const payload = withCategoryEntry(categoryEntry);

        const result = validatePayload(payload);

        assertRefusedFor(
          result,
          CATEGORY_POSITION,
          PAYLOAD_RULES.categoryEntryNamesEntity,
        );
      });
    }

    for (const entity of ['record', 'revision', 'artifact']) {
      const position = `${CATEGORY_POSITION}.${entity}`;

      test(`refuses an empty ${entity} action list, which means what absence means`, () => {
        const payload = withCategoryEntry({ [entity]: [] });

        const result = validatePayload(payload);

        assertRefusedFor(result, position, PAYLOAD_RULES.actionListNotEmpty);
      });

      test(`refuses a ${entity} action list repeating an action`, () => {
        const payload = withCategoryEntry({ [entity]: ['view', 'view'] });

        const result = validatePayload(payload);

        assertRefusedFor(
          result,
          position,
          PAYLOAD_RULES.actionListNamesEachOnce,
        );
      });

      test(`refuses a ${entity} action list that is a single string rather than a list`, () => {
        const payload = withCategoryEntry({ [entity]: 'view' });

        const result = validatePayload(payload);

        assertRefusedFor(result, position, PAYLOAD_RULES.actionListIsList);
      });

      test(`refuses a sparse ${entity} action list, since a hole is no action`, () => {
        const payload = withCategoryEntry({ [entity]: ['view', , 'export'] });

        const result = validatePayload(payload);

        assertRefusedFor(result, position, PAYLOAD_RULES.actionListVocabulary);
      });
    }

    for (const [entity, action] of [
      ['record', 'read'],
      ['revision', 'read'],
      ['artifact', 'read'],
      ['record', 'download'],
      ['record', 'own'],
      ['record', 'VIEW'],
      ['record', 42],
      ['revision', 'count'],
      ['revision', 'update'],
      ['revision', 'create'],
      ['revision', 'delete'],
    ] as const) {
      test(`refuses ${JSON.stringify(action)} as a ${entity} action, which is outside that entity's vocabulary`, () => {
        const payload = withCategoryEntry({ [entity]: ['view', action] });

        const result = validatePayload(payload);

        assertRefusedFor(
          result,
          `${CATEGORY_POSITION}.${entity}`,
          PAYLOAD_RULES.actionListVocabulary,
        );
      });
    }

    for (const action of ['read', 'create', 'delete', 'download']) {
      test(`refuses ${JSON.stringify(action)} as a field action, which is outside the field vocabulary`, () => {
        const payload = withCategoryEntry({
          field: { 'global.basic': ['view', action] },
          record: ['view'],
        });

        const result = validatePayload(payload);

        assertRefusedFor(
          result,
          FIELD_CATEGORY_POSITION,
          PAYLOAD_RULES.actionListVocabulary,
        );
      });
    }

    test('refuses an empty field action list', () => {
      const payload = withCategoryEntry({
        field: { 'global.basic': [] },
        record: ['view'],
      });

      const result = validatePayload(payload);

      assertRefusedFor(
        result,
        FIELD_CATEGORY_POSITION,
        PAYLOAD_RULES.actionListNotEmpty,
      );
    });

    test('refuses a field action list repeating an action', () => {
      const payload = withCategoryEntry({
        field: { 'global.basic': ['count', 'count'] },
        record: ['view'],
      });

      const result = validatePayload(payload);

      assertRefusedFor(
        result,
        FIELD_CATEGORY_POSITION,
        PAYLOAD_RULES.actionListNamesEachOnce,
      );
    });

    for (const field of [{}, ['view'], null, 'global.basic']) {
      test(`refuses a field key of ${JSON.stringify(field)}, since it must be a non-empty map of field categories`, () => {
        const payload = withCategoryEntry({ field, record: ['view'] });

        const result = validatePayload(payload);

        assertRefusedFor(
          result,
          `${CATEGORY_POSITION}.field`,
          PAYLOAD_RULES.fieldMapsCategories,
        );
      });
    }

    for (const fieldCategory of [
      'basic',
      'local.basic',
      'global.',
      'global.__proto__',
      'resource.__proto__',
    ]) {
      test(`refuses a field category named ${JSON.stringify(fieldCategory)}, which is outside the scoped category form`, () => {
        const payload = throughJson(
          withCategoryEntry({
            field: { [fieldCategory]: ['view'] },
            record: ['view'],
          }),
        );

        const result = validatePayload(payload);

        assertRefusedFor(
          result,
          FIELD_CATEGORY_POSITION,
          PAYLOAD_RULES.categoryForm,
        );
      });
    }

    test('accepts every action in each entity vocabulary', () => {
      const payload = withCategoryEntry({
        artifact: ['count', 'view', 'export', 'create', 'update', 'delete'],
        field: {
          'global.basic': ['count', 'view', 'export', 'update'],
          'resource.clinician': ['view'],
        },
        record: ['count', 'view', 'export', 'create', 'update', 'delete'],
        revision: ['view', 'export'],
      });

      const result = validatePayload(payload);

      assertAccepted(result);
    });

    test('tolerates an entity key unknown to the vocabulary, beside a known one', () => {
      const payload = withCategoryEntry({
        dataset: ['anything', 42],
        record: ['view'],
      });

      const result = validatePayload(payload);

      assertAccepted(result);
    });

    test('tolerates a category entry carrying only an entity key unknown to the vocabulary', () => {
      const payload = withCategoryEntry({ dataset: { nested: [null] } });

      const result = validatePayload(payload);

      assertAccepted(result);
    });

    test('leaves the contents of an unknown entity key unvalidated, whatever they hold', () => {
      const payload = withCategoryEntry({
        dataset: 'not a list',
        record: ['view'],
      });

      const result = validatePayload(payload);

      assertAccepted(result);
    });

    test('tolerates an unknown entity named like a member of Object.prototype', () => {
      const payload = withCategoryEntry({
        constructor: ['view'],
        record: ['view'],
      });

      const result = validatePayload(payload);

      assertAccepted(result);
    });

    test('refuses an entity key named __proto__, since an assignment would read it as a prototype', () => {
      const payload = throughJson(
        withCategoryEntry({ [PROTO]: { record: ['view', 'read'] } }),
      );

      const result = validatePayload(payload);

      assertRefusedFor(
        result,
        `${CATEGORY_POSITION}.<entity>`,
        PAYLOAD_RULES.entityKey,
      );
    });
  });

  suite('globalCategories and resourceCategories', () => {
    for (const [member, rule] of [
      ['globalCategories', PAYLOAD_RULES.globalCategories],
      ['resourceCategories', PAYLOAD_RULES.resourceCategoriesIsMap],
    ] as const) {
      test(`refuses a payload missing ${member}, rather than reading it as listing no category`, () => {
        const payload = withoutMember(member);

        const result = validatePayload(payload);

        assertRefusedFor(result, member, rule);
      });

      test(`refuses ${member} of null, rather than reading it as listing no category`, () => {
        const payload = withMembers({ [member]: null });

        const result = validatePayload(payload);

        assertRefusedFor(result, member, rule);
      });
    }

    test('refuses offeredCategories in place of both category members, since it is no member of version 1', () => {
      const payload = {
        ...Object.fromEntries(
          Object.entries(validPayload()).filter(
            ([member]) =>
              member !== 'globalCategories' && member !== 'resourceCategories',
          ),
        ),
        offeredCategories: {
          HEART_STUDY: [
            'global.controlled',
            'global.unmarked',
            'resource.pilot',
          ],
          LUNG_COHORT: ['global.unmarked'],
        },
      };

      const result = validatePayload(payload);

      assertRefusedFor(result, '(root)', PAYLOAD_RULES.rootMembers);
      assertRefusedFor(
        result,
        'globalCategories',
        PAYLOAD_RULES.globalCategories,
      );
      assertRefusedFor(
        result,
        'resourceCategories',
        PAYLOAD_RULES.resourceCategoriesIsMap,
      );
    });

    test('accepts both category members empty beside a resource holding global.unmarked alone', () => {
      const payload = withGlobalCategories([]);

      const result = validatePayload(payload);

      assertAccepted(result);
    });

    test('accepts global.unmarked held with neither list naming it', () => {
      const payload = withMembers({
        globalCategories: ['global.controlled'],
        permissions: {
          HEART_STUDY: { 'global.unmarked': { record: ['view'] } },
        },
        resourceCategories: { HEART_STUDY: ['resource.pilot'] },
      });

      const result = validatePayload(payload);

      assertAccepted(result);
    });

    test('accepts a held resource category listed under its own resource', () => {
      const payload = withMembers({
        globalCategories: [],
        permissions: {
          HEART_STUDY: { 'resource.pilot': { record: ['view'] } },
        },
        resourceCategories: { HEART_STUDY: ['resource.pilot'] },
      });

      const result = validatePayload(payload);

      assertAccepted(result);
    });

    test('accepts a field category that neither list names, since the lists name the categories a record carries', () => {
      const payload = withCategoryEntry({
        field: { 'global.basic': ['view'], 'resource.clinician': ['view'] },
        record: ['view'],
      });

      const result = validatePayload(payload);

      assertAccepted(result);
    });

    test('refuses a held global category that globalCategories does not list', () => {
      const payload = withMembers({
        globalCategories: ['global.community-governed'],
      });

      const result = validatePayload(payload);

      assertRefusedFor(
        result,
        CATEGORY_POSITION,
        PAYLOAD_RULES.heldCategoryListed,
      );
    });

    test('refuses a held resource category that no list names', () => {
      const payload = withMembers({
        resourceCategories: {
          HEART_STUDY: ['resource.clinic'],
          LUNG_COHORT: [],
        },
      });

      const result = validatePayload(payload);

      assertRefusedFor(
        result,
        CATEGORY_POSITION,
        PAYLOAD_RULES.heldCategoryListed,
      );
    });

    test('refuses a held resource category listed under another resource but not its own', () => {
      const payload = withMembers({
        resourceCategories: {
          HEART_STUDY: ['resource.clinic'],
          LUNG_COHORT: ['resource.pilot'],
        },
      });

      const result = validatePayload(payload);

      assertRefusedFor(
        result,
        CATEGORY_POSITION,
        PAYLOAD_RULES.heldCategoryListed,
      );
    });

    test('refuses resource.unmarked held on a resource, since no list may name it', () => {
      const payload = withResourceEntry({
        'global.unmarked': { record: ['view'] },
        'resource.unmarked': { record: ['view'] },
      });

      const result = validatePayload(payload);

      assertRefusedFor(
        result,
        CATEGORY_POSITION,
        PAYLOAD_RULES.heldCategoryListed,
      );
    });

    for (const [description, listed] of [
      ['a resource category', ['resource.pilot']],
      ['an empty list', []],
    ] as const) {
      test(`refuses ${description} listed under a resource absent from permissions`, () => {
        const resourceCategories = {
          ...validPayload().resourceCategories,
          REEF_ARCHIVE: listed,
        };
        const payload = withMembers({ resourceCategories });

        const result = validatePayload(payload);

        assertRefusedFor(
          result,
          RESOURCE_CATEGORIES_POSITION,
          PAYLOAD_RULES.resourceCategoriesNamesNoOtherResource,
        );
      });
    }

    test('refuses resourceCategories omitting a resource named in permissions', () => {
      const payload = withMembers({
        resourceCategories: {
          HEART_STUDY: ['resource.clinic', 'resource.pilot'],
        },
      });

      const result = validatePayload(payload);

      assertRefusedFor(
        result,
        RESOURCE_CATEGORIES_POSITION,
        PAYLOAD_RULES.resourceCategoriesNamesEveryHeldResource,
      );
    });

    for (const [description, globalCategories] of [
      [
        'global.unmarked, which names the records carrying no concrete category',
        ['global.controlled', 'global.unmarked'],
      ],
      ['a resource category', ['global.controlled', 'resource.pilot']],
      ['a category twice', ['global.controlled', 'global.controlled']],
      ['a name without its scope', ['controlled']],
      ['a name holding a separator', ['global.controlled.extra']],
      ['an empty name', ['global.']],
      ['global.__proto__', ['global.__proto__']],
      ['a number', [42]],
      ['null', [null]],
      ['a hole', ['global.controlled', , 'global.community-governed']],
    ] as const) {
      test(`refuses globalCategories listing ${description}`, () => {
        const payload = withGlobalCategories(globalCategories);

        const result = validatePayload(payload);

        assertRefusedFor(
          result,
          'globalCategories',
          PAYLOAD_RULES.globalCategories,
        );
      });
    }

    for (const globalCategories of ['global.controlled', {}, 42]) {
      test(`refuses globalCategories of ${JSON.stringify(globalCategories)}, which is not a list`, () => {
        const payload = withGlobalCategories(globalCategories);

        const result = validatePayload(payload);

        assertRefusedFor(
          result,
          'globalCategories',
          PAYLOAD_RULES.globalCategories,
        );
      });
    }

    for (const [description, ownCategories] of [
      ['a global category', ['global.controlled']],
      [
        'resource.unmarked, a name reserved for no category',
        ['resource.unmarked'],
      ],
      ['a category twice', ['resource.pilot', 'resource.pilot']],
      ['a name without its scope', ['pilot']],
      ['a name holding a separator', ['resource.pilot.extra']],
      ['resource.__proto__', ['resource.__proto__']],
      ['a number', [42]],
      ['a hole', ['resource.pilot', , 'resource.clinic']],
    ] as const) {
      test(`refuses a resource category list holding ${description}`, () => {
        const payload = withOwnCategories(ownCategories);

        const result = validatePayload(payload);

        assertRefusedFor(
          result,
          RESOURCE_CATEGORIES_POSITION,
          PAYLOAD_RULES.resourceCategoryList,
        );
      });
    }

    for (const ownCategories of ['resource.pilot', null, {}]) {
      test(`refuses a resource category list of ${JSON.stringify(ownCategories)}, which is not a list`, () => {
        const payload = withOwnCategories(ownCategories);

        const result = validatePayload(payload);

        assertRefusedFor(
          result,
          RESOURCE_CATEGORIES_POSITION,
          PAYLOAD_RULES.resourceCategoryList,
        );
      });
    }

    for (const resourceCategories of [[], 'HEART_STUDY', 42]) {
      test(`refuses resourceCategories of ${JSON.stringify(resourceCategories)}, which is not a map`, () => {
        const payload = withMembers({ resourceCategories });

        const result = validatePayload(payload);

        assertRefusedFor(
          result,
          'resourceCategories',
          PAYLOAD_RULES.resourceCategoriesIsMap,
        );
      });
    }

    for (const resource of ['', PROTO]) {
      test(`refuses ${JSON.stringify(resource)} as a resource identifier in resourceCategories`, () => {
        const payload = withResourceNamed(resource);

        const result = validatePayload(payload);

        assertRefusedFor(
          result,
          RESOURCE_CATEGORIES_POSITION,
          PAYLOAD_RULES.resourceIdentifier,
        );
      });
    }

    for (const resource of MARKER_RESOURCES) {
      test(`refuses ${JSON.stringify(resource)} as a resource identifier in resourceCategories, since it holds a marker read specially by Arranger`, () => {
        const payload = withResourceNamed(resource);

        const result = validatePayload(payload);

        assertRefusedFor(
          result,
          RESOURCE_CATEGORIES_POSITION,
          PAYLOAD_RULES.resourceIdentifier,
        );
      });
    }

    for (const resource of ['constructor', 'toString', 'hasOwnProperty']) {
      test(`refuses resource categories listed for a resource called ${resource} that is absent from permissions`, () => {
        const resourceCategories = {
          ...validPayload().resourceCategories,
          [resource]: [],
        };
        const payload = withMembers({ resourceCategories });

        const result = validatePayload(payload);

        assertRefusedFor(
          result,
          RESOURCE_CATEGORIES_POSITION,
          PAYLOAD_RULES.resourceCategoriesNamesNoOtherResource,
        );
      });

      test(`refuses resourceCategories omitting a resource called ${resource} that is named in permissions`, () => {
        const permissions = {
          ...validPayload().permissions,
          [resource]: { 'global.unmarked': { record: ['view'] } },
        };
        const payload = withMembers({ permissions });

        const result = validatePayload(payload);

        assertRefusedFor(
          result,
          RESOURCE_CATEGORIES_POSITION,
          PAYLOAD_RULES.resourceCategoriesNamesEveryHeldResource,
        );
      });
    }

    test('refuses resource categories listed for a resource called __proto__ that is absent from permissions', () => {
      const payload = throughJson(
        withMembers({
          resourceCategories: {
            ...validPayload().resourceCategories,
            [PROTO]: ['resource.pilot'],
          },
        }),
      );

      const result = validatePayload(payload);

      assertRefusedFor(
        result,
        RESOURCE_CATEGORIES_POSITION,
        PAYLOAD_RULES.resourceCategoriesNamesNoOtherResource,
      );
    });
  });

  suite('servedResources', () => {
    test('accepts a served resource on which nothing is held', () => {
      const payload = withServedResources([
        'HEART_STUDY',
        'LUNG_COHORT',
        'REEF_ARCHIVE',
        'VOID_INDEX',
      ]);

      const result = validatePayload(payload);

      assertAccepted(result);
    });

    test('accepts the served resources in any order', () => {
      const payload = withServedResources([
        'REEF_ARCHIVE',
        'LUNG_COHORT',
        'HEART_STUDY',
      ]);

      const result = validatePayload(payload);

      assertAccepted(result);
    });

    test('refuses a payload missing servedResources, rather than reading it as serving nothing', () => {
      const payload = withoutMember('servedResources');

      const result = validatePayload(payload);

      assertRefusedFor(
        result,
        'servedResources',
        PAYLOAD_RULES.servedResources,
      );
    });

    test('refuses servedResources of null, rather than reading it as serving nothing', () => {
      const payload = withServedResources(null);

      const result = validatePayload(payload);

      assertRefusedFor(
        result,
        'servedResources',
        PAYLOAD_RULES.servedResources,
      );
    });

    for (const servedResources of [
      'HEART_STUDY',
      { HEART_STUDY: true },
      42,
      true,
    ]) {
      test(`refuses servedResources of ${JSON.stringify(servedResources)}, which is not a list`, () => {
        const payload = withServedResources(servedResources);

        const result = validatePayload(payload);

        assertRefusedFor(
          result,
          'servedResources',
          PAYLOAD_RULES.servedResources,
        );
      });
    }

    test('refuses servedResources naming a resource twice', () => {
      const payload = withServedResources([
        'HEART_STUDY',
        'LUNG_COHORT',
        'REEF_ARCHIVE',
        'LUNG_COHORT',
      ]);

      const result = validatePayload(payload);

      assertRefusedFor(
        result,
        'servedResources',
        PAYLOAD_RULES.servedResources,
      );
    });

    for (const [description, unusable] of [
      ['an empty identifier', ''],
      ['__proto__', PROTO],
      ...MARKER_RESOURCES.map(
        (resource) =>
          [
            `${JSON.stringify(resource)}, which holds a marker read specially by Arranger`,
            resource,
          ] as const,
      ),
      ['a number', 42],
      ['null', null],
      ['a list', ['VOID_INDEX']],
    ] as const) {
      test(`refuses servedResources holding ${description}, which is no usable resource identifier`, () => {
        const payload = throughJson(
          withServedResources([
            'HEART_STUDY',
            'LUNG_COHORT',
            'REEF_ARCHIVE',
            unusable,
          ]),
        );

        const result = validatePayload(payload);

        assertRefusedFor(
          result,
          'servedResources',
          PAYLOAD_RULES.servedResources,
        );
      });
    }

    test('refuses servedResources holding a hole, since a hole is no resource identifier', () => {
      const payload = withServedResources([
        'HEART_STUDY',
        ,
        'LUNG_COHORT',
        'REEF_ARCHIVE',
      ]);

      const result = validatePayload(payload);

      assertRefusedFor(
        result,
        'servedResources',
        PAYLOAD_RULES.servedResources,
      );
    });

    test('refuses a resource named in permissions that servedResources leaves out, at its position in permissions', () => {
      const payload = withServedResources(['HEART_STUDY', 'REEF_ARCHIVE']);

      const result = validatePayload(payload);

      assertRefusedFor(
        result,
        RESOURCE_POSITION,
        PAYLOAD_RULES.servedResourcesListsNamedResources,
      );
    });

    test('refuses a resource named in resourceCategories that servedResources leaves out, at its position in resourceCategories', () => {
      const payload = withServedResources(['HEART_STUDY', 'REEF_ARCHIVE']);

      const result = validatePayload(payload);

      assertRefusedFor(
        result,
        RESOURCE_CATEGORIES_POSITION,
        PAYLOAD_RULES.servedResourcesListsNamedResources,
      );
    });

    test('refuses a resource named in resourceCategories alone that servedResources leaves out, beside the rule tying resourceCategories to permissions', () => {
      const payload = withMembers({
        resourceCategories: {
          ...validPayload().resourceCategories,
          VOID_INDEX: [],
        },
      });

      const result = validatePayload(payload);

      assertRefusedFor(
        result,
        RESOURCE_CATEGORIES_POSITION,
        PAYLOAD_RULES.servedResourcesListsNamedResources,
      );
      assertRefusedFor(
        result,
        RESOURCE_CATEGORIES_POSITION,
        PAYLOAD_RULES.resourceCategoriesNamesNoOtherResource,
      );
    });

    test('refuses an empty servedResources beside permissions naming a resource', () => {
      const payload = withServedResources([]);

      const result = validatePayload(payload);

      assertRefusedFor(
        result,
        RESOURCE_POSITION,
        PAYLOAD_RULES.servedResourcesListsNamedResources,
      );
    });

    for (const resource of ['constructor', 'toString', 'hasOwnProperty']) {
      test(`refuses a resource called ${resource}, named in permissions, that servedResources leaves out`, () => {
        const payload = withMembers({
          permissions: {
            [resource]: { 'global.unmarked': { record: ['view'] } },
          },
          resourceCategories: { [resource]: [] },
          servedResources: ['HEART_STUDY'],
        });

        const result = validatePayload(payload);

        assertRefusedFor(
          result,
          RESOURCE_POSITION,
          PAYLOAD_RULES.servedResourcesListsNamedResources,
        );
      });
    }
  });

  suite('what it returns', () => {
    test('returns a copy, so a later change to the input reaches nothing returned', () => {
      const payload = validPayload();

      const result = validatePayload(payload);
      payload.permissions['EXTRA_STUDY'] = {
        'global.controlled': { record: ['view'] },
      };

      assert.deepEqual(result.success && result.payload, validPayload());
    });

    test('returns only the own members of the payload, never an inherited one', () => {
      const inherited = Object.assign(Object.create(null), {
        EXTRA_STUDY: { 'global.controlled': { record: ['view', 'export'] } },
      });
      const permissions = Object.assign(
        Object.create(inherited),
        validPayload().permissions,
      );
      const payload = withMembers({ permissions });

      const result = validatePayload(payload);

      assertAccepted(result);
      assert.equal(
        result.success &&
          Object.hasOwn(result.payload.permissions, 'EXTRA_STUDY'),
        false,
      );
      assert.equal(
        result.success && 'EXTRA_STUDY' in result.payload.permissions,
        false,
      );
    });

    test('returns the value each member held when it was checked, read once', () => {
      const reads = { count: 0 };
      const payload = Object.defineProperty(withoutMember('sub'), 'sub', {
        enumerable: true,
        get: (): string | null => {
          reads.count += 1;

          return reads.count === 1 ? null : 'another-subject';
        },
      });

      const result = validatePayload(payload);

      assertAccepted(result);
      assert.equal(result.success && result.payload.sub, null);
      assert.equal(reads.count, 1);
    });

    test('accepts a payload made in another realm, returning it as plain data of this one', () => {
      const payload: unknown = runInNewContext(
        `(${JSON.stringify(validPayload())})`,
      );

      const result = validatePayload(payload);

      assertAccepted(result);
      assert.deepEqual(result.success && result.payload, validPayload());
    });

    test('accepts a payload whose maps have no prototype, returning it as plain data', () => {
      const payload = Object.assign(Object.create(null), {
        ...validPayload(),
        permissions: Object.assign(
          Object.create(null),
          validPayload().permissions,
        ),
      });

      const result = validatePayload(payload);

      assertAccepted(result);
      assert.deepEqual(result.success && result.payload, validPayload());
    });

    test('keeps a __proto__ key inside an unknown entity as the own member it is', () => {
      const payload = throughJson(
        withCategoryEntry({ dataset: { [PROTO]: { record: ['view'] } } }),
      );

      const result = validatePayload(payload);
      const entry = result.success
        ? result.payload.permissions['HEART_STUDY']?.['global.unmarked']
        : undefined;
      const dataset: unknown = entry && Reflect.get(entry, 'dataset');

      assertAccepted(result);
      assert.equal(Object.hasOwn(Object(dataset), PROTO), true);
      assert.equal(Object.getPrototypeOf(dataset), Object.prototype);
    });

    test('refuses a payload carrying a symbol key, which no parsed value carries', () => {
      const payload = withMembers({
        permissions: {
          ...validPayload().permissions,
          [Symbol('resource')]: { 'global.unmarked': { record: ['view'] } },
        },
      });

      const result = validatePayload(payload);

      assertRefusedFor(result, 'permissions', PAYLOAD_RULES.permissionsIsMap);
    });

    for (const [description, payload] of [
      [
        'a getter that throws',
        Object.defineProperty({ ...validPayload() }, 'iss', {
          enumerable: true,
          get: (): never => {
            throw new Error('unreadable');
          },
        }),
      ],
      [
        'a proxy whose trap throws',
        new Proxy(validPayload(), {
          ownKeys: (): never => {
            throw new Error('unreadable');
          },
        }),
      ],
    ] as const) {
      test(`refuses a payload holding ${description}, returning the refusal rather than throwing`, () => {
        const result = validatePayload(payload);

        assertRefusedFor(result, '(root)', READ_RULE);
      });
    }
  });

  suite('what problems carry', () => {
    const MARKED_RESOURCE = `${LEAK_MARKER}_resource`;
    const MARKED_CATEGORY = `global.${LEAK_MARKER}_category`;
    const MARKED_FIELD_CATEGORY = `global.${LEAK_MARKER}_field`;
    const MARKED_OWN_CATEGORY = `resource.${LEAK_MARKER}_own`;
    const MARKED_UNHELD_RESOURCE = `${LEAK_MARKER}_unheld`;

    /** The words fixed by the contract, carried unmarked by a leak input. */
    const CONTRACT_WORDS: ReadonlySet<string> = new Set([
      '',
      PROTO,
      'artifact',
      'aud',
      'count',
      'create',
      'delete',
      'exp',
      'export',
      'field',
      'generatedAt',
      'global.__proto__',
      'globalCategories',
      'iat',
      'iss',
      'payloadVersion',
      'permissions',
      'record',
      'resourceCategories',
      'revision',
      'servedResources',
      'sub',
      'update',
      'view',
    ]);

    /** A valid payload in which every identifier and value carries the marker. */
    const markedPayload = (): Record<string, unknown> => ({
      payloadVersion: 1,
      sub: `${LEAK_MARKER}_subject`,
      iss: `https://${LEAK_MARKER}.example.org`,
      aud: `${LEAK_MARKER}_audience`,
      iat: LEAK_NUMBER,
      exp: LEAK_NUMBER + 300,
      generatedAt: LEAK_NUMBER - 60,
      permissions: {
        [MARKED_RESOURCE]: {
          [MARKED_CATEGORY]: {
            [`${LEAK_MARKER}_entity`]: [`${LEAK_MARKER}_unread`],
            field: { [MARKED_FIELD_CATEGORY]: ['view'] },
            record: ['view'],
          },
        },
      },
      globalCategories: [MARKED_CATEGORY],
      resourceCategories: { [MARKED_RESOURCE]: [MARKED_OWN_CATEGORY] },
      servedResources: [MARKED_RESOURCE, MARKED_UNHELD_RESOURCE],
    });

    const markedWith = (members: Record<string, unknown>): unknown =>
      throughJson({ ...markedPayload(), ...members });

    /** The marked payload, holding `categoryEntry` as its one category entry. */
    const markedEntry = (categoryEntry: unknown): unknown =>
      markedWith({
        permissions: {
          [MARKED_RESOURCE]: { [MARKED_CATEGORY]: categoryEntry },
        },
      });

    /** The marked payload, listing `ownCategories` under its one resource. */
    const markedOwnCategories = (ownCategories: unknown): unknown =>
      markedWith({ resourceCategories: { [MARKED_RESOURCE]: ownCategories } });

    /** The marked payload with its resource named `resource` in both maps and served. */
    const markedResource = (resource: string): unknown =>
      markedWith({
        permissions: {
          [resource]: { [MARKED_CATEGORY]: { record: ['view'] } },
        },
        resourceCategories: { [resource]: [MARKED_OWN_CATEGORY] },
        servedResources: [resource, MARKED_UNHELD_RESOURCE],
      });

    /** The marked payload with its one held category named `category`. */
    const markedCategory = (category: string): unknown =>
      markedWith({
        permissions: {
          [MARKED_RESOURCE]: { [category]: { record: ['view'] } },
        },
      });

    const leakCases: readonly LeakCase[] = [
      {
        description: 'a payload that is not a map',
        input: [markedPayload()],
        position: '(root)',
        rule: PAYLOAD_RULES.payloadIsMap,
      },
      {
        description: 'a payload version that is a string',
        input: markedWith({ payloadVersion: `${LEAK_MARKER}_version` }),
        position: 'payloadVersion',
        rule: PAYLOAD_RULES.payloadVersion,
      },
      {
        description: 'an unknown root member',
        input: markedWith({
          [`${LEAK_MARKER}_member`]: `${LEAK_MARKER}_value`,
        }),
        position: '(root)',
        rule: PAYLOAD_RULES.rootMembers,
      },
      {
        description: 'a subject that is not a string',
        input: markedWith({ sub: { [LEAK_MARKER]: `${LEAK_MARKER}_subject` } }),
        position: 'sub',
        rule: PAYLOAD_RULES.sub,
      },
      {
        description: 'an empty subject',
        input: markedWith({ sub: '' }),
        position: 'sub',
        rule: PAYLOAD_RULES.sub,
      },
      {
        description: 'an issuer that is not a string',
        input: markedWith({ iss: { [LEAK_MARKER]: LEAK_MARKER } }),
        position: 'iss',
        rule: PAYLOAD_RULES.issNonEmpty,
      },
      {
        description: 'an empty audience',
        input: markedWith({ aud: '' }),
        position: 'aud',
        rule: PAYLOAD_RULES.audNonEmpty,
      },
      {
        description: 'an issue time that is a string',
        input: markedWith({ iat: `${LEAK_MARKER}_iat` }),
        position: 'iat',
        rule: PAYLOAD_RULES.iatTimestamp,
      },
      {
        description: 'a negative expiry',
        input: markedWith({ exp: -LEAK_NUMBER }),
        position: 'exp',
        rule: PAYLOAD_RULES.expTimestamp,
      },
      {
        description: 'a fractional computation time',
        input: markedWith({ generatedAt: LEAK_NUMBER + 0.5 }),
        position: 'generatedAt',
        rule: PAYLOAD_RULES.generatedAtTimestamp,
      },
      {
        description: 'an expiry at the issue time',
        input: markedWith({ exp: LEAK_NUMBER }),
        position: 'exp',
        rule: PAYLOAD_RULES.expAfterIat,
      },
      {
        description: 'a computation time after the issue time',
        input: markedWith({ generatedAt: LEAK_NUMBER + 1 }),
        position: 'generatedAt',
        rule: PAYLOAD_RULES.generatedAtNotAfterIat,
      },
      {
        description: 'permissions that are not a map',
        input: markedWith({ permissions: [MARKED_RESOURCE] }),
        position: 'permissions',
        rule: PAYLOAD_RULES.permissionsIsMap,
      },
      {
        description: 'a resource holding no category',
        input: markedWith({ permissions: { [MARKED_RESOURCE]: {} } }),
        position: RESOURCE_POSITION,
        rule: PAYLOAD_RULES.resourceHoldsCategory,
      },
      {
        description: 'an empty resource identifier in permissions',
        input: markedResource(''),
        position: RESOURCE_POSITION,
        rule: PAYLOAD_RULES.resourceIdentifier,
      },
      {
        description: 'a __proto__ resource identifier in resourceCategories',
        input: markedResource(PROTO),
        position: RESOURCE_CATEGORIES_POSITION,
        rule: PAYLOAD_RULES.resourceIdentifier,
      },
      {
        description:
          'a resource identifier holding a marker read specially by Arranger',
        input: markedResource(`set_id:${LEAK_MARKER}_resource*`),
        position: RESOURCE_POSITION,
        rule: PAYLOAD_RULES.resourceIdentifier,
      },
      {
        description: 'a category outside the scoped form',
        input: markedCategory(`${LEAK_MARKER}_category`),
        position: CATEGORY_POSITION,
        rule: PAYLOAD_RULES.categoryForm,
      },
      {
        description: 'a category named __proto__ after its scope',
        input: markedCategory('global.__proto__'),
        position: CATEGORY_POSITION,
        rule: PAYLOAD_RULES.categoryForm,
      },
      {
        description: 'a category entry that is a list',
        input: markedEntry([`${LEAK_MARKER}_entity`]),
        position: CATEGORY_POSITION,
        rule: PAYLOAD_RULES.categoryEntryNamesEntity,
      },
      {
        description: 'an entity key named __proto__',
        input: markedEntry({ [PROTO]: { record: [`${LEAK_MARKER}_action`] } }),
        position: `${CATEGORY_POSITION}.<entity>`,
        rule: PAYLOAD_RULES.entityKey,
      },
      {
        description: 'a record action list that is a string',
        input: markedEntry({ record: `${LEAK_MARKER}_action` }),
        position: `${CATEGORY_POSITION}.record`,
        rule: PAYLOAD_RULES.actionListIsList,
      },
      {
        description: 'an empty revision action list',
        input: markedEntry({
          [`${LEAK_MARKER}_entity`]: [LEAK_MARKER],
          revision: [],
        }),
        position: `${CATEGORY_POSITION}.revision`,
        rule: PAYLOAD_RULES.actionListNotEmpty,
      },
      {
        description: 'an artifact action list repeating an action',
        input: markedEntry({
          artifact: [`${LEAK_MARKER}_action`, `${LEAK_MARKER}_action`],
        }),
        position: `${CATEGORY_POSITION}.artifact`,
        rule: PAYLOAD_RULES.actionListNamesEachOnce,
      },
      {
        description: 'a record action outside its vocabulary',
        input: markedEntry({ record: [`${LEAK_MARKER}_action`] }),
        position: `${CATEGORY_POSITION}.record`,
        rule: PAYLOAD_RULES.actionListVocabulary,
      },
      {
        description: 'a field key that is not a map',
        input: markedEntry({
          field: [MARKED_FIELD_CATEGORY],
          record: ['view'],
        }),
        position: `${CATEGORY_POSITION}.field`,
        rule: PAYLOAD_RULES.fieldMapsCategories,
      },
      {
        description: 'a field category outside the scoped form',
        input: markedEntry({
          field: { [`${LEAK_MARKER}_field`]: ['view'] },
          record: ['view'],
        }),
        position: FIELD_CATEGORY_POSITION,
        rule: PAYLOAD_RULES.categoryForm,
      },
      {
        description: 'a field action outside its vocabulary',
        input: markedEntry({
          field: { [MARKED_FIELD_CATEGORY]: [`${LEAK_MARKER}_action`] },
          record: ['view'],
        }),
        position: FIELD_CATEGORY_POSITION,
        rule: PAYLOAD_RULES.actionListVocabulary,
      },
      {
        description: 'globalCategories that are not a list',
        input: markedWith({
          globalCategories: { [MARKED_CATEGORY]: `${LEAK_MARKER}_value` },
        }),
        position: 'globalCategories',
        rule: PAYLOAD_RULES.globalCategories,
      },
      {
        description: 'globalCategories repeating a category',
        input: markedWith({
          globalCategories: [MARKED_CATEGORY, MARKED_CATEGORY],
        }),
        position: 'globalCategories',
        rule: PAYLOAD_RULES.globalCategories,
      },
      {
        description: 'globalCategories listing a resource category',
        input: markedWith({
          globalCategories: [MARKED_CATEGORY, MARKED_OWN_CATEGORY],
        }),
        position: 'globalCategories',
        rule: PAYLOAD_RULES.globalCategories,
      },
      {
        description: 'resourceCategories that are not a map',
        input: markedWith({ resourceCategories: [MARKED_RESOURCE] }),
        position: 'resourceCategories',
        rule: PAYLOAD_RULES.resourceCategoriesIsMap,
      },
      {
        description:
          'resource categories listed for a resource absent from permissions',
        input: markedWith({
          resourceCategories: {
            [MARKED_RESOURCE]: [MARKED_OWN_CATEGORY],
            [`${LEAK_MARKER}_extra`]: [`resource.${LEAK_MARKER}_extra`],
          },
        }),
        position: RESOURCE_CATEGORIES_POSITION,
        rule: PAYLOAD_RULES.resourceCategoriesNamesNoOtherResource,
      },
      {
        description:
          'a resource named in permissions that resourceCategories omits',
        input: markedWith({ resourceCategories: {} }),
        position: RESOURCE_CATEGORIES_POSITION,
        rule: PAYLOAD_RULES.resourceCategoriesNamesEveryHeldResource,
      },
      {
        description: 'a resource category list that is a string',
        input: markedOwnCategories(MARKED_OWN_CATEGORY),
        position: RESOURCE_CATEGORIES_POSITION,
        rule: PAYLOAD_RULES.resourceCategoryList,
      },
      {
        description: 'a resource category list repeating a category',
        input: markedOwnCategories([MARKED_OWN_CATEGORY, MARKED_OWN_CATEGORY]),
        position: RESOURCE_CATEGORIES_POSITION,
        rule: PAYLOAD_RULES.resourceCategoryList,
      },
      {
        description: 'a resource category list naming a global category',
        input: markedOwnCategories([MARKED_CATEGORY]),
        position: RESOURCE_CATEGORIES_POSITION,
        rule: PAYLOAD_RULES.resourceCategoryList,
      },
      {
        description: 'servedResources that are not a list',
        input: markedWith({
          servedResources: { [MARKED_RESOURCE]: `${LEAK_MARKER}_value` },
        }),
        position: 'servedResources',
        rule: PAYLOAD_RULES.servedResources,
      },
      {
        description: 'servedResources repeating a resource',
        input: markedWith({
          servedResources: [
            MARKED_RESOURCE,
            MARKED_UNHELD_RESOURCE,
            MARKED_UNHELD_RESOURCE,
          ],
        }),
        position: 'servedResources',
        rule: PAYLOAD_RULES.servedResources,
      },
      {
        description:
          'servedResources holding an identifier with a marker read specially by Arranger',
        input: markedWith({
          servedResources: [MARKED_RESOURCE, `set_id:${LEAK_MARKER}_served*`],
        }),
        position: 'servedResources',
        rule: PAYLOAD_RULES.servedResources,
      },
      {
        description:
          'a resource named in permissions that servedResources omits',
        input: markedWith({ servedResources: [MARKED_UNHELD_RESOURCE] }),
        position: RESOURCE_POSITION,
        rule: PAYLOAD_RULES.servedResourcesListsNamedResources,
      },
      {
        description:
          'a resource named in resourceCategories that servedResources omits',
        input: markedWith({ servedResources: [MARKED_UNHELD_RESOURCE] }),
        position: RESOURCE_CATEGORIES_POSITION,
        rule: PAYLOAD_RULES.servedResourcesListsNamedResources,
      },
      {
        description: 'a held global category that globalCategories omits',
        input: markedWith({
          globalCategories: [`global.${LEAK_MARKER}_other`],
        }),
        position: CATEGORY_POSITION,
        rule: PAYLOAD_RULES.heldCategoryListed,
      },
      {
        description: 'a held resource category listed under no resource',
        input: markedWith({
          permissions: {
            [MARKED_RESOURCE]: {
              [MARKED_OWN_CATEGORY]: { record: ['view'] },
            },
          },
          resourceCategories: { [MARKED_RESOURCE]: [] },
        }),
        position: CATEGORY_POSITION,
        rule: PAYLOAD_RULES.heldCategoryListed,
      },
    ];

    test('starts from a marked payload that is itself accepted', () => {
      const payload = markedPayload();

      const result = validatePayload(payload);

      assertInputMarked(payload, CONTRACT_WORDS);
      assertAccepted(result);
    });

    for (const { description, input, position, rule } of leakCases) {
      test(`names no content of the input in the problems for ${description}`, () => {
        assertInputMarked(input, CONTRACT_WORDS);

        const result = validatePayload(input);

        assertRefusedFor(result, position, rule);
        assertCarriesNoInput(result);
      });
    }

    test('names no content of an error thrown by a getter while the payload is read', () => {
      const payload = Object.defineProperty(markedPayload(), 'iss', {
        enumerable: true,
        get: (): never => {
          throw new Error(`${LEAK_MARKER}_thrown`);
        },
      });

      const result = validatePayload(payload);

      assertRefusedFor(result, '(root)', READ_RULE);
      assertCarriesNoInput(result);
    });

    test('breaks every rule held by the validator, between the inputs above', () => {
      const cases = leakCases;

      assertEveryRuleBroken(cases, PAYLOAD_RULES);
    });
  });

  suite('the payload types', () => {
    test('describe the documented token examples', () => {
      const anonymous: PermissionsPayload = {
        payloadVersion: 1,
        sub: null,
        iss: 'https://usher.example.org',
        aud: 'arranger-prod',
        iat: 1718611200,
        exp: 1718611500,
        generatedAt: 1718611200,
        permissions: {
          OPEN_COHORT: { 'global.unmarked': { record: ['view'] } },
        },
        globalCategories: [],
        resourceCategories: { OPEN_COHORT: [] },
        servedResources: ['OPEN_COHORT', 'SEALED_COHORT'],
      };

      const result = validatePayload(anonymous);

      assertAccepted(result);
    });

    test('carry every name defined by the contract', () => {
      const resource: ResourceIdentifier = 'HEART_STUDY';
      const categories: NonEmpty<CategoryName> = [
        'global.controlled',
        'resource.pilot',
      ];
      const recordActions: NonEmpty<RecordAction> = ['count', 'delete'];
      const fieldActions: NonEmpty<FieldAction> = ['update'];
      const revisionActions: NonEmpty<RevisionAction> = ['export'];
      const artifactActions: NonEmpty<ArtifactAction> = ['create'];
      const categoryPermissions: CategoryPermissions = {
        artifact: artifactActions,
        field: { 'global.basic': fieldActions },
        record: recordActions,
        revision: revisionActions,
      };
      const resourcePermissions: ResourcePermissions = {
        'global.controlled': categoryPermissions,
      };
      const dataEntities: NonEmpty<DataEntity> = [
        'artifact',
        'field',
        'record',
        'revision',
      ];
      const controlEntities: NonEmpty<ControlEntity> = [
        'category',
        'custodianship',
        'grant',
        'group',
        'invitation',
        'ownership',
        'resource',
        'role',
      ];

      const entities: NonEmpty<Entity> = [...dataEntities, ...controlEntities];

      assert.equal(entities.length, 12);
      assert.deepEqual(Object.keys(resourcePermissions), ['global.controlled']);
      assert.equal(resource, 'HEART_STUDY');
      assert.equal(categories.length, 2);
    });

    test('refuse at compile time the shapes refused by the validator at run time', () => {
      // @ts-expect-error read is a capability group, never an action
      const groupAsAction: RecordAction = 'read';
      // @ts-expect-error a field exists per schema, so it is never created
      const createdField: FieldAction = 'create';
      // @ts-expect-error a bare category name carries no scope
      const unscoped: CategoryName = 'open';
      // @ts-expect-error an empty list means what absence already means
      const emptyActions: NonEmpty<RecordAction> = [];
      // @ts-expect-error anonymous is an explicit null, never an absent subject
      const absentSubject: PermissionsPayload = {
        payloadVersion: 1,
        iss: 'https://usher.example.org',
        aud: 'arranger-prod',
        iat: 1718611200,
        exp: 1718611500,
        generatedAt: 1718611200,
        permissions: {},
        globalCategories: [],
        resourceCategories: {},
        servedResources: [],
      };
      // @ts-expect-error the category members are required, even when they list nothing
      const unlisted: PermissionsPayload = {
        payloadVersion: 1,
        sub: null,
        iss: 'https://usher.example.org',
        aud: 'arranger-prod',
        iat: 1718611200,
        exp: 1718611500,
        generatedAt: 1718611200,
        permissions: {},
        servedResources: [],
      };
      // @ts-expect-error servedResources is required, even for an audience serving nothing
      const unserved: PermissionsPayload = {
        payloadVersion: 1,
        sub: null,
        iss: 'https://usher.example.org',
        aud: 'arranger-prod',
        iat: 1718611200,
        exp: 1718611500,
        generatedAt: 1718611200,
        permissions: {},
        globalCategories: [],
        resourceCategories: {},
      };

      const results = [absentSubject, unlisted, unserved].map(validatePayload);

      results.forEach(assertRefused);
      assert.deepEqual(
        [groupAsAction, createdField, unscoped, emptyActions],
        ['read', 'create', 'open', []],
      );
    });
  });
});
