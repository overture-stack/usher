import type {
	CategoryName,
	CategoryPermissions,
	NonEmpty,
	ResourceIdentifier,
	ResourcePermissions,
} from '@overture-stack/usher-types';

import type { AudiencePolicy, Calculation, ConferringRule, ServedResource } from './types.js';

/**
 * One entry conferred on a payload: what one rule or one recorded grant confers under one category of
 * one resource.
 */
export interface HeldEntry {
	category: CategoryName;
	externalId: ResourceIdentifier;
	permissions: CategoryPermissions;
}

/** What conferred a calculation's entries, beside the entries themselves. */
export interface Conferrers {
	/**
	 * The earliest expiry among the recorded grants drawn on, in whole seconds since the Unix epoch,
	 * where any expires.
	 */
	earliestGrantExpiry?: number;

	/** How many recorded grants were drawn on. */
	grantCount: number;

	/** The rules that conferred an entry, each once, in the order they are named. */
	rules: readonly ConferringRule[];
}

// The global category of the records matching no other, which a payload never lists as concrete.
const UNMARKED = 'unmarked';

/** The global category of the records matching no other category, as a payload names it. */
export const UNMARKED_CATEGORY: CategoryName = `global.${UNMARKED}`;

/**
 * The list given, typed as holding at least one element, or `undefined` for an empty one.
 *
 * @param list the list.
 */
export const nonEmpty = <Element>(list: readonly Element[]): NonEmpty<Element> | undefined => {
	const [first, ...rest] = list;
	return first === undefined ? undefined : [first, ...rest];
};

/**
 * The resources an audience serves that an entry may be conferred on: every one neither retired nor
 * suppressed, in the order served.
 *
 * @param served every resource the audience serves, retired ones included.
 */
export const reachableOf = (served: readonly ServedResource[]): readonly ServedResource[] =>
	served.filter(({ retired, suppressed }) => !retired && !suppressed);

// Every action each list names, each once, in the order first named.
const unionOf = <Action>(lists: readonly (readonly Action[] | undefined)[]): NonEmpty<Action> | undefined =>
	nonEmpty([...new Set(lists.flatMap((list) => list ?? []))]);

// The entities held under one category, each the union of what every entry conferring it holds there.
const unitedPermissions = (conferred: readonly CategoryPermissions[]): CategoryPermissions => {
	const artifact = unionOf(conferred.map((entities) => entities.artifact));
	const record = unionOf(conferred.map((entities) => entities.record));
	const revision = unionOf(conferred.map((entities) => entities.revision));
	return {
		...(artifact === undefined ? {} : { artifact }),
		...(record === undefined ? {} : { record }),
		...(revision === undefined ? {} : { revision }),
	};
};

// The categories held on one resource, each united across the entries conferring it.
const resourcePermissions = (entries: readonly HeldEntry[]): ResourcePermissions =>
	Object.fromEntries(
		Object.entries(Object.groupBy(entries, ({ category }) => category)).map(([category, conferring = []]) => [
			category,
			unitedPermissions(conferring.map(({ permissions }) => permissions)),
		]),
	);

/**
 * A calculation from one read of the store and the entries conferred: every entry unioned per
 * resource and category, each action named once in the order the entries first name it. A resource is
 * held where an entry is conferred on it and it is served, neither retired nor suppressed, and no
 * other resource is. Beside what is held, the offerings: every concrete global category, every held
 * resource's own categories, and every resource the audience serves that is not retired.
 *
 * @param policy the audience's served resources and the global categories, as one read gave them.
 * @param entries every entry conferred by a rule or a recorded grant, in the order their actions are
 *   to be named.
 * @param conferrers how many recorded grants the entries draw on, the earliest of their expiries where
 *   any expires, and the rules that conferred an entry.
 */
export const calculationOf = (
	{ globalCategories, served }: AudiencePolicy,
	entries: readonly HeldEntry[],
	{ earliestGrantExpiry, grantCount, rules }: Conferrers,
): Calculation => {
	const current = served.filter(({ retired }) => !retired);
	const byResource = Object.groupBy(entries, ({ externalId }) => externalId);
	const held = reachableOf(current).flatMap((resource) => {
		const conferred = byResource[resource.externalId];
		return conferred === undefined ? [] : [{ conferred, resource }];
	});
	return {
		...(earliestGrantExpiry === undefined ? {} : { earliestGrantExpiry }),
		globalCategories: globalCategories
			.filter((name) => name !== UNMARKED)
			.map((name): CategoryName => `global.${name}`),
		grantCount,
		permissions: Object.fromEntries(
			held.map(({ conferred, resource }) => [resource.externalId, resourcePermissions(conferred)]),
		),
		resourceCategories: Object.fromEntries(
			held.map(({ resource: { externalId, ownCategories } }) => [
				externalId,
				ownCategories.map((name): CategoryName => `resource.${name}`),
			]),
		),
		rules,
		servedResources: current.map(({ externalId }) => externalId),
	};
};
