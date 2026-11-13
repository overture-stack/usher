import type {
  CategoryName,
  ResourceIdentifier,
  ResourcePermissions,
} from '@overture-stack/usher-types';

/** The tier a resource's unmarked records sit at, as the store holds it. */
export type BaseTier = 'grant' | 'open' | 'registered';

/** One resource an audience serves, as the calculation reads it. */
export interface ServedResource {
  baseTier: BaseTier;

  /** The identifier its data carries, which a payload names it by. */
  externalId: ResourceIdentifier;

  /** The names of its own categories, each without its `resource.` scope. */
  ownCategories: readonly string[];

  /** Whether it is retired: a retired resource is served no longer. */
  retired: boolean;

  /** Whether it is suppressed: a suppressed resource is served, and reached by nobody. */
  suppressed: boolean;
}

/**
 * What one read of the store gives the calculation for one audience: the names of every global
 * category, each without its `global.` scope, and every resource the audience serves.
 */
export interface AudiencePolicy {
  globalCategories: readonly string[];
  served: readonly ServedResource[];
}

/** A rule conferring a grant on a whole class of principals, as `token.exchange` names it in `rules`. */
export type ConferringRule = 'baseline' | 'signedIn';

/**
 * What the calculation gives a payload: what the principal holds and what the audience offers, as a
 * payload's members of the same names carry them, with what conferred it.
 */
export interface Calculation {
  /** Every concrete global category, as a payload names it, never `global.unmarked`. */
  globalCategories: readonly CategoryName[];

  /** The recorded grants that reached the payload, a rule's never among them. */
  grantCount: number;

  permissions: Readonly<Record<ResourceIdentifier, ResourcePermissions>>;
  resourceCategories: Readonly<
    Record<ResourceIdentifier, readonly CategoryName[]>
  >;

  /** The rules that conferred an entry on at least one resource, each once. */
  rules: readonly ConferringRule[];

  servedResources: readonly ResourceIdentifier[];
}
