import {
  type CategoryCondition,
  type CategoryName,
  type CategoryPermissions,
  canonicalOperatorOf,
  type Enforcement,
  normalizedCondition,
  type PermissionsPayload,
  parseRecordNarrowing,
  type RecordKeyRegistration,
  type ResourceIdentifier,
} from '@overture-stack/usher-types';

import type { BridgeEventData } from './events.js';

/** A narrowing's filter, as carried by an enforcement result. */
type Filter = Extract<Enforcement, { kind: 'narrow' }>['sqon'];

/** The event naming a guard's denial. */
export type GuardEvent =
  | {
      data: BridgeEventData['catalogue.filterLimit'];
      name: 'catalogue.filterLimit';
    }
  | {
      data: BridgeEventData['catalogue.renderingMismatch'];
      name: 'catalogue.renderingMismatch';
    };

/**
 * What a record narrowing says, in the shape returned by `parseRecordNarrowing`, so the payload's
 * account and the filter's can be compared through one function.
 */
interface Statement {
  complement: readonly ResourceIdentifier[];
  exclusions: readonly {
    condition: CategoryCondition;
    lacking: readonly ResourceIdentifier[];
  }[];
  held: readonly ResourceIdentifier[];
  resourceFieldName: string;
  unmarked?: {
    globalConditions: readonly CategoryCondition[];
    lacking: readonly ResourceIdentifier[];
    scopedConditions: readonly {
      condition: CategoryCondition;
      resource: ResourceIdentifier;
    }[];
  };
}

type NamedCondition = readonly [CategoryName, CategoryCondition];

/** One resource held for a key by the payload, with the categories held on it. */
interface Holding {
  categories: ReadonlySet<CategoryName>;
  resource: ResourceIdentifier;
  unmarked: boolean;
}

const UNMARKED: CategoryName = 'global.unmarked';

const MISSING_MARKER = '__missing__';

const MISSING_WEIGHT = 2;

/** What each node weighs by its canonical operator, before the nodes beneath it. */
const OPERATOR_WEIGHTS: ReadonlyMap<string, number> = new Map(
  Object.entries({
    and: 0,
    between: 2,
    gt: 2,
    gte: 2,
    in: 1,
    lt: 2,
    lte: 2,
    not: 1,
    or: 0,
  }),
);

const RENDERING_MISMATCH: Enforcement = {
  kind: 'deny',
  reason: 'rendering-mismatch',
};

const FILTER_LIMIT: Enforcement = { kind: 'deny', reason: 'filter-limit' };

/** A member of a node, read only when it is the node's own. */
const memberOf = (node: unknown, member: string): unknown =>
  typeof node === 'object' && node !== null
    ? Object.getOwnPropertyDescriptor(node, member)?.value
    : undefined;

const listsMissing = (content: unknown): boolean => {
  const value = memberOf(content, 'value');

  return (Array.isArray(value) ? value : [value]).includes(MISSING_MARKER);
};

const weightOf = (node: unknown): number => {
  const operator = canonicalOperatorOf(memberOf(node, 'op')) ?? '';
  const content = memberOf(node, 'content');
  const own =
    operator === 'in' && listsMissing(content)
      ? MISSING_WEIGHT
      : (OPERATOR_WEIGHTS.get(operator) ?? Number.POSITIVE_INFINITY);
  const children: readonly unknown[] = Array.isArray(content) ? content : [];

  return children.reduce<number>(
    (total, child) => total + weightOf(child),
    own,
  );
};

/**
 * How many clauses a search engine counts in `filter` once rewritten, weighed as OpenSearch counts
 * them, with operators read through SQON's aliases:
 *
 * - an `in` weighs 1 whatever the number of values listed, or 2 when it lists `__missing__`;
 * - a `gt`, `gte`, `lt`, `lte` or `between` weighs 2;
 * - a `not` weighs 1 beyond its member;
 * - an `and` or an `or` weighs nothing beyond its members;
 * - any other operator weighs more than any limit.
 */
export const filterClauseCount = (filter: Filter): number => weightOf(filter);

/**
 * A map's own member, so an identifier named like a member of `Object.prototype` reads as itself.
 */
const ownMemberOf = <Value>(
  map: Readonly<Partial<Record<string, Value>>> | undefined,
  name: string,
): Value | undefined =>
  map !== undefined && Object.hasOwn(map, name) ? map[name] : undefined;

const definedConditions = (
  conditions: Readonly<Partial<Record<CategoryName, CategoryCondition>>> = {},
): readonly NamedCondition[] =>
  (
    Object.entries(conditions) as [
      CategoryName,
      CategoryCondition | undefined,
    ][]
  ).flatMap(([name, condition]) =>
    condition === undefined ? [] : [[name, condition] as const],
  );

const holdsWholeRecords = (entry: CategoryPermissions): boolean =>
  !Object.hasOwn(entry, 'field') && entry.record?.includes('view') === true;

const holdingsOf = (
  payload: PermissionsPayload,
  key: RecordKeyRegistration,
): readonly Holding[] => {
  const listed =
    key.resources === undefined ? undefined : new Set(key.resources);
  const globals = key.categories.global;

  return Object.entries(payload.permissions).flatMap(([resource, entries]) => {
    const own: Readonly<Partial<Record<CategoryName, CategoryCondition>>> =
      ownMemberOf(key.categories.resource, resource) ?? {};
    const viewed = (
      Object.entries(entries) as [CategoryName, CategoryPermissions][]
    )
      .filter(([, entry]) => holdsWholeRecords(entry))
      .map(([category]) => category);
    const categories: ReadonlySet<CategoryName> = new Set(
      viewed.filter((category) => category !== UNMARKED),
    );
    const unmarked = viewed.includes(UNMARKED);
    const isListed = listed?.has(resource) ?? true;
    const definesEveryOffered = (
      ownMemberOf(payload.resourceCategories, resource) ?? []
    ).every((category) => ownMemberOf(own, category) !== undefined);
    const reachesRecords =
      unmarked ||
      [...categories].some(
        (category) =>
          ownMemberOf(globals, category) !== undefined ||
          ownMemberOf(own, category) !== undefined,
      );

    return isListed && definesEveryOffered && reachesRecords
      ? [{ categories, resource, unmarked }]
      : [];
  });
};

/**
 * What a key's narrowing must say for a payload, derived from the payload and the key's registration
 * alone. It shares no helper with rendering.ts, so a fault in either is caught by the other. Both
 * rely on usher-types' `normalizedCondition`, whose correctness therefore rests on its own tests.
 */
const expectedStatement = (
  payload: PermissionsPayload,
  key: RecordKeyRegistration,
): Statement => {
  const holdings = holdingsOf(payload, key);
  const held = holdings.map(({ resource }) => resource);
  const heldNames: ReadonlySet<ResourceIdentifier> = new Set(held);
  const known = [...payload.servedResources, ...(key.resources ?? [])];
  const globals = definedConditions(key.categories.global);
  const ownOf = (resource: ResourceIdentifier): readonly NamedCondition[] =>
    definedConditions(ownMemberOf(key.categories.resource, resource));
  const lackingUnmarked = holdings.filter(({ unmarked }) => !unmarked);

  return {
    complement: known.filter((resource) => !heldNames.has(resource)),
    exclusions: [
      ...globals.flatMap(([name, condition]) => {
        const lacking = holdings
          .filter(({ categories }) => !categories.has(name))
          .map(({ resource }) => resource);

        return lacking.length > 0 ? [{ condition, lacking }] : [];
      }),
      ...holdings.flatMap(({ categories, resource }) =>
        ownOf(resource)
          .filter(([name]) => !categories.has(name))
          .map(([, condition]) => ({ condition, lacking: [resource] })),
      ),
    ],
    held,
    resourceFieldName: key.resourceFieldName,
    ...(lackingUnmarked.length > 0
      ? {
          unmarked: {
            globalConditions: globals.map(([, condition]) => condition),
            lacking: lackingUnmarked.map(({ resource }) => resource),
            scopedConditions: lackingUnmarked.flatMap(({ resource }) =>
              ownOf(resource).map(([, condition]) => ({ condition, resource })),
            ),
          },
        }
      : {}),
  };
};

/**
 * Whether the key defines or declares absent every global category listed by the payload. No
 * narrowing is accepted without it, whatever rendering decided.
 */
const coversEveryGlobal = (
  payload: PermissionsPayload,
  key: RecordKeyRegistration,
): boolean => {
  const absent: ReadonlySet<CategoryName> = new Set(key.absentCategories ?? []);

  return payload.globalCategories.every(
    (category) =>
      ownMemberOf(key.categories.global, category) !== undefined ||
      absent.has(category),
  );
};

const sortedSet = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].toSorted();

const conditionText = (condition: CategoryCondition): string =>
  JSON.stringify(normalizedCondition(condition));

/**
 * A statement as text: every list as a sorted set and every condition as its normalized JSON, so two
 * statements saying the same thing give the same text.
 */
const statementText = ({
  complement,
  exclusions,
  held,
  resourceFieldName,
  unmarked,
}: Statement): string =>
  JSON.stringify({
    complement: sortedSet(complement),
    exclusions: sortedSet(
      exclusions.map(({ condition, lacking }) =>
        JSON.stringify([conditionText(condition), sortedSet(lacking)]),
      ),
    ),
    held: sortedSet(held),
    resourceFieldName,
    unmarked:
      unmarked === undefined
        ? null
        : {
            globalConditions: sortedSet(
              unmarked.globalConditions.map(conditionText),
            ),
            lacking: sortedSet(unmarked.lacking),
            scopedConditions: sortedSet(
              unmarked.scopedConditions.map(({ condition, resource }) =>
                JSON.stringify([resource, conditionText(condition)]),
              ),
            ),
          },
  });

/**
 * Checks a rendered record narrowing against the payload and the record key it was rendered for,
 * and returns:
 *
 * - `deny` with `rendering-mismatch` when the payload lists a global category neither defined nor
 *   declared absent by the key, when `parseRecordNarrowing` refuses the filter, or when the
 *   filter's resource field, held resources, complement, exclusions or unmarked clause differ from
 *   what the payload and registration say, lists compared as sets and conditions by their
 *   normalized JSON;
 * - otherwise `deny` with `filter-limit` when {@link filterClauseCount} exceeds
 *   `filterClauseLimit`;
 * - otherwise `narrow` with the filter as given.
 */
export const guardedNarrowing = ({
  filterClauseLimit,
  key,
  narrowing,
  payload,
}: {
  filterClauseLimit: number;
  key: RecordKeyRegistration;
  narrowing: Filter;
  payload: PermissionsPayload;
}): Enforcement => {
  const parsed = parseRecordNarrowing(narrowing);
  const matches =
    parsed.success &&
    coversEveryGlobal(payload, key) &&
    statementText(parsed.narrowing) ===
      statementText(expectedStatement(payload, key));

  if (matches) {
    return filterClauseCount(narrowing) <= filterClauseLimit
      ? { kind: 'narrow', sqon: narrowing }
      : FILTER_LIMIT;
  }

  return RENDERING_MISMATCH;
};

/**
 * The event naming a guard's denial: `catalogue.renderingMismatch` with the catalogue for
 * `rendering-mismatch`, or `catalogue.filterLimit` with the catalogue and `filterClauseLimit` for
 * `filter-limit`, never a count of grants. `undefined` for any other result.
 *
 * @param catalogue the key the result is for.
 */
export const guardEventOf = (
  catalogue: string,
  enforcement: Enforcement,
  filterClauseLimit: number,
): GuardEvent | undefined => {
  if (
    enforcement.kind === 'deny' &&
    enforcement.reason === 'rendering-mismatch'
  ) {
    return { data: { catalogue }, name: 'catalogue.renderingMismatch' };
  }

  if (enforcement.kind === 'deny' && enforcement.reason === 'filter-limit') {
    return {
      data: { catalogue, filterClauseLimit },
      name: 'catalogue.filterLimit',
    };
  }

  return undefined;
};
