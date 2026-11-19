import type { GrantRules } from '../settings/index.js';
import { grantRuleConferrals, ruleCalculation } from './ruleCalculation.js';
import type { AudiencePolicy, Calculation } from './types.js';

/**
 * Calculates what an anonymous visitor holds for one audience, from one read of the store: the
 * `everyone` entries of the grant rules, conferring their record actions on `global.unmarked` of every
 * resource the audience serves at the entry's access level, and nothing else, since no grant is recorded
 * for anyone anonymous. A suppressed resource is held by nobody and stays served; a retired one is
 * neither held nor served. Beside what is held, the offerings: every concrete global category, every
 * held resource's own categories, and every resource the audience serves. An entry conferring nothing
 * names no rule.
 *
 * @param policy the audience's served resources and the global categories, as one read gave them.
 * @param grantRules the grant rules the store holds.
 */
export const anonymousCalculation = (
  policy: AudiencePolicy,
  grantRules: GrantRules,
): Calculation =>
  ruleCalculation(policy, grantRuleConferrals(grantRules, ['everyone']));
