import type {
  CategoryName,
  ResourceIdentifier,
  ResourcePermissions,
} from '@overture-stack/usher-types';

import type { Plane } from '../capabilities/index.js';
import type { GrantRuleRecipient, GrantRules } from '../settings/index.js';

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

/** A category a grant names, by its scope and its name without that scope, as the store holds them. */
export interface NamedCategory {
  name: string;
  scope: 'global' | 'resource';
}

/**
 * A person's latest decision on a grant, as the calculation reads it: whether it accepted or rejected
 * the grant, and the capabilities it was given on, as `entity.action` names.
 */
export interface LatestDecision {
  capabilities: readonly string[];
  decision: 'accepted' | 'rejected';
}

/**
 * A recorded grant reaching a signed-in principal, as the calculation reads it: unrevoked, held by the
 * principal or by a group they belong to, on a resource the audience serves.
 */
export interface ReachingGrant {
  /** When it expires, in milliseconds since the Unix epoch; `null` for a grant that never does. */
  expiresAt: number | null;

  /** The identifier of the resource it is on. */
  externalId: ResourceIdentifier;

  /** The field category it names within its record category; `null` where it names none. */
  fieldCategory: NamedCategory | null;

  /** The principal's own latest decision on it, by its instant; `null` where they have made none. */
  latestDecision: LatestDecision | null;

  /** The plane of its role. */
  plane: Plane;

  /** Its record category; `null` for the control plane's wildcard, the whole resource. */
  recordCategory: NamedCategory | null;

  /** The capabilities its role carries as the store holds them, as `entity.action` names. */
  roleCapabilities: readonly string[];
}

/**
 * What one read of the store gives the calculation for a signed-in principal and one audience: the
 * audience's policy, and every recorded grant reaching the principal there.
 */
export interface PrincipalPolicy extends AudiencePolicy {
  grants: readonly ReachingGrant[];
}

/** The recipient of a grant rule that conferred an entry, as `token.exchange` names it in `rules`. */
export type ConferringRule = GrantRuleRecipient;

/** The grant rules the store holds, as one read gave them: the rules, or the rule the stored value breaks. */
export type StoredGrantRules =
  { kind: 'read'; rules: GrantRules } | { kind: 'refused'; rule: string };

/** What one read of the store gives for one audience, with the grant rules read in the same statement. */
export type AudiencePolicyReading = AudiencePolicy & {
  grantRules: StoredGrantRules;
};

/**
 * What the calculation gives a payload: what the principal holds and what the audience offers, as a
 * payload's members of the same names carry them, with what conferred it.
 */
export interface Calculation {
  /**
   * The earliest expiry among the recorded grants that reached the payload, in whole seconds since the
   * Unix epoch, rounded down; absent where none of them expires.
   */
  earliestGrantExpiry?: number;

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
