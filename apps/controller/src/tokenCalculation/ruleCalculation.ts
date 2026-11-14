import type { RecordAction } from '@overture-stack/usher-types';

import {
  calculationOf,
  type HeldEntry,
  nonEmpty,
  reachableOf,
  UNMARKED_CATEGORY,
} from './heldEntries.js';
import type {
  AudiencePolicy,
  BaseTier,
  Calculation,
  ConferringRule,
  ServedResource,
} from './types.js';

/** A rule conferring record actions on the unmarked records of every resource at one base tier. */
export interface Conferral {
  /** The record actions it confers, in its order; none confers nothing. */
  actions: readonly RecordAction[];

  rule: ConferringRule;

  /** The base tier of the resources whose unmarked records it reaches. */
  tier: BaseTier;
}

/** What the rules confer: their entries, and the rules conferring at least one. */
export interface RuleEntries {
  entries: readonly HeldEntry[];

  /** Each rule conferring an entry, once, in the order given. */
  rules: readonly ConferringRule[];
}

/**
 * The entries the rules given confer: each rule's record actions on `global.unmarked` of every
 * resource the audience serves at the rule's base tier, neither retired nor suppressed. Each rule
 * conferring an entry is named once, in the order given; a rule conferring no actions, or reaching no
 * resource, confers nothing and is not named.
 *
 * @param served every resource the audience serves, retired ones included.
 * @param conferrals the rules, each with its actions and the base tier it reaches, in the order they
 *   are named.
 */
export const ruleEntries = (
  served: readonly ServedResource[],
  conferrals: readonly Conferral[],
): RuleEntries => {
  const conferring = conferrals.flatMap(({ actions, rule, tier }) => {
    const conferred = nonEmpty(actions);
    return conferred === undefined ? [] : [{ actions: conferred, rule, tier }];
  });
  const held = reachableOf(served).flatMap((resource) => {
    const conferral = conferring.find(({ tier }) => tier === resource.baseTier);
    return conferral === undefined ? [] : [{ conferral, resource }];
  });
  return {
    entries: held.map(({ conferral, resource }) => ({
      category: UNMARKED_CATEGORY,
      externalId: resource.externalId,
      permissions: { record: [...conferral.actions] },
    })),
    rules: conferring
      .filter(({ rule }) =>
        held.some(({ conferral }) => conferral.rule === rule),
      )
      .map(({ rule }) => rule),
  };
};

/**
 * Calculates what a principal holds for one audience through the rules given, from one read of the
 * store: each rule's record actions on `global.unmarked` of every resource the audience serves at the
 * rule's base tier, and nothing else. A suppressed resource is held by nobody and stays served; a
 * retired one is neither held nor served. Beside what is held, the offerings: every concrete global
 * category, every held resource's own categories, and every resource the audience serves. Each rule
 * conferring an entry on at least one resource is named once, in the order given; a rule conferring
 * no actions, or reaching no resource, confers nothing and is not named. No recorded grant is read,
 * so none is counted.
 *
 * @param policy the audience's served resources and the global categories, as one read gave them.
 * @param conferrals the rules, each with its actions and the base tier it reaches, in the order they
 *   are named.
 */
export const ruleCalculation = (
  policy: AudiencePolicy,
  conferrals: readonly Conferral[],
): Calculation => {
  const { entries, rules } = ruleEntries(policy.served, conferrals);
  return calculationOf(policy, entries, { grantCount: 0, rules });
};
