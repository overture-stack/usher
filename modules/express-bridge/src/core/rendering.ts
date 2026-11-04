import {
  type CategoryCondition,
  type CategoryName,
  type CategoryPermissions,
  canonicalRecordNarrowing,
  type Enforcement,
  type HeldResource,
  type KeyRegistration,
  normalizedCondition,
  type OpenKeyRegistration,
  type PermissionsPayload,
  type RecordKeyRegistration,
  type ResourceIdentifier,
} from '@overture-stack/usher-types';

import { guardedNarrowing } from './guards.js';

/** A category's condition as compiled by {@link compileKey}. */
export interface CompiledCondition {
  /**
   * Normalized by usher-types' `normalizedCondition`, so the key order of the adapter's original
   * never shows.
   */
  condition: CategoryCondition;
}

/** One scope's categories, each compiled, keyed by category name within a single key. */
export type CompiledConditions = Readonly<
  Partial<Record<CategoryName, CompiledCondition>>
>;

/**
 * A record key's categories, each compiled and held by that key alone, so two keys defining one
 * category name with different conditions each render their own.
 */
export interface CompiledCategories {
  global: CompiledConditions;

  /** Each resource's own categories, by resource identifier; a resource defining none is absent. */
  resource: Readonly<Partial<Record<ResourceIdentifier, CompiledConditions>>>;
}

/** A record key's registration, with its categories compiled beside it. */
export interface CompiledRecordKey extends RecordKeyRegistration {
  compiledCategories: CompiledCategories;
}

/** One key as compiled by {@link compileKey}. */
export type CompiledKey = CompiledRecordKey | OpenKeyRegistration;

/**
 * A category left unmapped by a key: a global one, which denies the whole key, or a resource's own,
 * which withholds that resource from the key.
 */
export interface UnmappedCategory {
  category: CategoryName;

  /** The resource withheld, for a resource category; absent for a global one. */
  resourceId?: ResourceIdentifier;
}

/** A category defined by the key and not listed by the payload, so never held. */
export interface UnknownCategory {
  category: CategoryName;

  /** The resource it is defined under, for a resource category; absent for a global one. */
  resourceId?: ResourceIdentifier;
}

/** One key's enforcement result, and every category gap met while rendering it. */
export interface KeyRendering {
  enforcement: Enforcement;

  /**
   * Every category defined by the key and not listed by the payload: a global one missing from the
   * payload's global categories, or a resource category missing from the payload's list for a
   * resource named in it.
   */
  unknown: readonly UnknownCategory[];

  /** Every category left unmapped by the key. */
  unmapped: readonly UnmappedCategory[];
}

/** A permission entry left unenforced, and so rendered as nothing. */
export interface UnenforcedEntry {
  category: CategoryName;
  entry: 'fieldPartition';
  resourceId: ResourceIdentifier;
}

const UNMARKED: CategoryName = 'global.unmarked';

const NO_GRANTS: Enforcement = { kind: 'deny', reason: 'no-grants' };

const UNKNOWN_RESOURCE: Enforcement = {
  kind: 'deny',
  reason: 'unknown-resource',
};

const UNMAPPED_CATEGORY: Enforcement = {
  kind: 'deny',
  reason: 'unmapped-category',
};

/**
 * Only viewing counts, since one narrowing serves every read path. An entry partitioned by field is
 * left unenforced, so it counts for nothing.
 */
const viewsWholeRecords = (entry: CategoryPermissions): boolean =>
  !Object.hasOwn(entry, 'field') && (entry.record?.includes('view') ?? false);

/** A map's own entries, keyed as the map is: the keys of a validated value are its own names. */
const ownEntries = <Key extends string, Value>(
  map: Readonly<Partial<Record<Key, Value>>>,
): readonly (readonly [Key, Value])[] =>
  (Object.keys(map) as Key[]).flatMap((key) => {
    const value = map[key];
    return value === undefined ? [] : [[key, value] as const];
  });

/**
 * A map's own member, so an identifier named like a member of `Object.prototype` reads as itself.
 */
const ownValue = <Key extends string, Value>(
  map: Readonly<Partial<Record<Key, Value>>>,
  key: Key,
): Value | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);

const compiledCondition = (
  condition: CategoryCondition,
): CompiledCondition => ({
  condition: normalizedCondition(condition),
});

const compiledConditions = (
  conditions: Readonly<Partial<Record<CategoryName, CategoryCondition>>>,
): CompiledConditions =>
  Object.fromEntries(
    ownEntries(conditions).map(([category, condition]) => [
      category,
      compiledCondition(condition),
    ]),
  );

/** The conditions alone, in the form taken by a narrowing's description. */
const conditionsOf = (
  compiled: CompiledConditions,
): Readonly<Partial<Record<CategoryName, CategoryCondition>>> =>
  Object.fromEntries(
    ownEntries(compiled).map(([category, { condition }]) => [
      category,
      condition,
    ]),
  );

/**
 * Compiles one key's registration: a record key's global categories and each resource's own are
 * kept beside the registration with every condition normalized, and an open registration is
 * returned as it is. Assumes a registration accepted by `validateRegistration`.
 */
export const compileKey = (registration: KeyRegistration): CompiledKey =>
  registration.kind === 'record'
    ? {
        ...registration,
        compiledCategories: {
          global: compiledConditions(registration.categories.global),
          resource: Object.fromEntries(
            ownEntries(registration.categories.resource ?? {}).map(
              ([resource, own]) => [resource, compiledConditions(own)],
            ),
          ),
        },
      }
    : registration;

/** The payload's global categories neither defined nor declared absent by the key. */
const unmappedGlobals = (
  payload: PermissionsPayload,
  key: CompiledRecordKey,
): readonly CategoryName[] => {
  const absent: ReadonlySet<CategoryName> = new Set(key.absentCategories ?? []);
  const isMapped = (category: CategoryName): boolean =>
    Object.hasOwn(key.compiledCategories.global, category) ||
    absent.has(category);

  return payload.globalCategories.filter((category) => !isMapped(category));
};

/**
 * The key's categories not listed by the payload. A resource not named by the payload says nothing
 * either way, so its categories are left out.
 */
const unknownCategories = (
  payload: PermissionsPayload,
  key: CompiledRecordKey,
): readonly UnknownCategory[] => {
  const listedGlobals: ReadonlySet<CategoryName> = new Set(
    payload.globalCategories,
  );

  return [
    ...ownEntries(key.compiledCategories.global)
      .map(([category]) => category)
      .filter((category) => !listedGlobals.has(category))
      .map((category) => ({ category })),
    ...ownEntries(key.compiledCategories.resource).flatMap(
      ([resource, own]) => {
        const offered = ownValue(payload.resourceCategories, resource);

        return offered === undefined
          ? []
          : ownEntries(own)
              .map(([category]) => category)
              .filter((category) => !offered.includes(category))
              .map((category) => ({ category, resourceId: resource }));
      },
    ),
  ];
};

/**
 * The resource categories offered for a resource by the payload and not defined under it by the
 * key.
 */
const resourceGaps = (
  payload: PermissionsPayload,
  key: CompiledRecordKey,
  resource: ResourceIdentifier,
): readonly CategoryName[] => {
  const defined = ownValue(key.compiledCategories.resource, resource) ?? {};

  return (ownValue(payload.resourceCategories, resource) ?? []).filter(
    (category) => !Object.hasOwn(defined, category),
  );
};

/**
 * What is held on one resource, or `undefined` when the resource is not held: it is held when its
 * unmarked records are, or when it holds a category applying to it, either a global one defined by
 * the key or one of its own.
 */
const heldResourceOf = (
  payload: PermissionsPayload,
  key: CompiledRecordKey,
  resource: ResourceIdentifier,
): HeldResource | undefined => {
  const own = ownValue(key.compiledCategories.resource, resource) ?? {};
  const viewed = ownEntries(ownValue(payload.permissions, resource) ?? {})
    .filter(([, entry]) => viewsWholeRecords(entry))
    .map(([category]) => category);
  const heldCategories = viewed.filter((category) => category !== UNMARKED);
  const unmarkedHeld = viewed.includes(UNMARKED);
  const applies = (category: CategoryName): boolean =>
    Object.hasOwn(key.compiledCategories.global, category) ||
    Object.hasOwn(own, category);

  return unmarkedHeld || heldCategories.some(applies)
    ? {
        heldCategories,
        resource,
        resourceCategories: conditionsOf(own),
        unmarkedHeld,
      }
    : undefined;
};

/**
 * The resources known to a key, in code-unit order. A listed resource not served by the payload is
 * never held, so knowing it withholds every record holding it.
 */
const knownResourcesOf = (
  payload: PermissionsPayload,
  key: CompiledRecordKey,
): readonly ResourceIdentifier[] =>
  Array.from(
    new Set([...payload.servedResources, ...(key.resources ?? [])]),
  ).toSorted();

const renderRecordKey = (
  payload: PermissionsPayload,
  key: CompiledRecordKey,
  filterClauseLimit: number,
): KeyRendering => {
  const unknown = unknownCategories(payload, key);
  const globalGaps = unmappedGlobals(payload, key);

  if (globalGaps.length > 0) {
    return {
      enforcement: UNMAPPED_CATEGORY,
      unknown,
      unmapped: globalGaps.map((category) => ({ category })),
    };
  }

  const listed: ReadonlySet<ResourceIdentifier> | undefined =
    key.resources === undefined ? undefined : new Set(key.resources);
  const candidates = Object.keys(payload.permissions).filter(
    (resource) => listed?.has(resource) ?? true,
  );
  const unmapped = candidates.flatMap((resource) =>
    resourceGaps(payload, key, resource).map((category) => ({
      category,
      resourceId: resource,
    })),
  );
  const withheld: ReadonlySet<ResourceIdentifier> = new Set(
    unmapped.map(({ resourceId }) => resourceId),
  );
  const [firstHeld, ...otherHeld] = candidates
    .filter((resource) => !withheld.has(resource))
    .flatMap((resource) => heldResourceOf(payload, key, resource) ?? []);

  if (firstHeld) {
    return {
      enforcement: guardedNarrowing({
        filterClauseLimit,
        key,
        narrowing: canonicalRecordNarrowing({
          globalCategories: conditionsOf(key.compiledCategories.global),
          heldResources: [firstHeld, ...otherHeld],
          knownResources: knownResourcesOf(payload, key),
          resourceFieldName: key.resourceFieldName,
        }),
        payload,
      }),
      unknown,
      unmapped,
    };
  }

  return {
    enforcement: key.resources?.length === 0 ? UNKNOWN_RESOURCE : NO_GRANTS,
    unknown,
    unmapped,
  };
};

/**
 * Renders one key's enforcement result from a validated payload and the key as compiled by
 * {@link compileKey}:
 *
 * - an open key gets `allow`;
 * - a record key gets `deny` with `unmapped-category` when the payload lists a global category
 *   neither defined nor declared absent by the key;
 * - otherwise, with at least one resource held, it gets usher-types' record narrowing over the held
 *   resources, or `deny` with `rendering-mismatch` when that narrowing says anything other than the
 *   payload and registration, or `deny` with `filter-limit` when it holds more clauses than
 *   `filterClauseLimit`;
 * - otherwise it gets `deny` with `unknown-resource` when the key registers an empty resource list,
 *   and `deny` with `no-grants` for any other key.
 *
 * A resource is held when `permissions` names it, the key's resource list includes it when the key
 * has one, every resource category offered for it by the payload is defined under it by the key,
 * and its unmarked records, or a category applying to it, are held with whole-record view. The
 * narrowing withholds every record of a known resource not held, the known resources being the
 * payload's served resources together with the key's own resource list. `unknown` and `unmapped`
 * list every category gap met, and the payload's category lists reach nothing else; both are empty
 * for an open key. Assumes a payload accepted by `validatePayload` and a key accepted by
 * `validateRegistration`; given anything else it can throw usher-types' `UsherContractError`.
 *
 * @param filterClauseLimit the most clauses a record key's narrowing may hold.
 */
export const renderKey = (
  payload: PermissionsPayload,
  key: CompiledKey,
  filterClauseLimit: number,
): KeyRendering => {
  switch (key.kind) {
    case 'open':
      return { enforcement: { kind: 'allow' }, unknown: [], unmapped: [] };
    case 'record':
      return renderRecordKey(payload, key, filterClauseLimit);
  }
};

/**
 * Every entry in the payload partitioned by field, each named by its resource and category: the
 * entries rendered as nothing by {@link renderKey}.
 */
export const unenforcedEntries = (
  payload: PermissionsPayload,
): readonly UnenforcedEntry[] =>
  ownEntries(payload.permissions).flatMap(([resourceId, entries]) =>
    ownEntries(entries)
      .filter(([, entry]) => Object.hasOwn(entry, 'field'))
      .map(([category]): UnenforcedEntry => ({
        category,
        entry: 'fieldPartition',
        resourceId,
      })),
  );
