import type { RecordAction } from '@overture-stack/usher-types';

import { grantEntries } from './grantEntries.js';
import { calculationOf } from './heldEntries.js';
import { ruleEntries } from './ruleCalculation.js';
import type { Calculation, PrincipalPolicy } from './types.js';

/**
 * Calculates what a signed-in principal holds for one audience at the instant their token is issued,
 * from one read of the store, through the rules and the recorded grants reaching them, unioned per
 * resource and category.
 *
 * Through the rules: the baseline's record actions on `global.unmarked` of every resource the audience
 * serves whose unmarked records are open, and the signed-in rule's on those of every resource whose
 * unmarked records are registered. Each rule conferring an entry is named once, the baseline first;
 * an empty rule confers nothing, and is not named.
 *
 * Through the recorded grants: each grant kept, where the principal's latest decision on it accepts it
 * and it expires after the second the token is issued in, or never, confers under its record category
 * what its role carries as read that the decision accepted, of the actions payload version 1 lists for
 * artifacts, records and revisions, each under its entity. A control-plane role confers nothing, nor
 * does a grant naming no record category, and a grant naming a field category is left out entirely.
 * Every grant drawn on is counted in `grantCount`, a rule never, and the earliest of their expiries,
 * rounded down to the whole second, is `earliestGrantExpiry`.
 *
 * A suppressed resource is held by nobody and stays served; a retired one is neither held nor served,
 * and a resource the audience does not serve is reached through nothing. Beside what is held, the
 * offerings: every concrete global category, every held resource's own categories, and every resource
 * the audience serves that is not retired.
 *
 * @param policy the audience's served resources, the global categories and the grants reaching the
 *   principal, as one read gave them.
 * @param conferring the record actions the baseline confers on everyone, those the signed-in rule
 *   confers on every signed-in principal, and the instant the token is issued, in whole seconds since
 *   the Unix epoch.
 */
export const signedInCalculation = (
  policy: PrincipalPolicy,
  {
    baseline,
    issuedAt,
    signedInRule,
  }: {
    baseline: readonly RecordAction[];
    issuedAt: number;
    signedInRule: readonly RecordAction[];
  },
): Calculation => {
  const ruled = ruleEntries(policy.served, [
    { actions: baseline, rule: 'baseline', tier: 'open' },
    { actions: signedInRule, rule: 'signedIn', tier: 'registered' },
  ]);
  const granted = grantEntries(policy.served, policy.grants, issuedAt);
  return calculationOf(policy, [...ruled.entries, ...granted.entries], {
    ...(granted.earliestExpiry === undefined
      ? {}
      : { earliestGrantExpiry: granted.earliestExpiry }),
    grantCount: granted.grantCount,
    rules: ruled.rules,
  });
};
