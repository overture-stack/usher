import type { RecordAction } from '@overture-stack/usher-types';

import { ruleCalculation } from './ruleCalculation.js';
import type { AudiencePolicy, Calculation } from './types.js';

/**
 * Calculates what an anonymous visitor holds for one audience, from one read of the store: the
 * baseline's grant on `global.unmarked`, conferring the baseline's record actions on every resource
 * the audience serves whose unmarked records are open, and nothing else, since no grant is recorded
 * for anyone anonymous. A suppressed resource is held by nobody and stays served; a retired one is
 * neither held nor served. Beside what is held, the offerings: every concrete global category, every
 * held resource's own categories, and every resource the audience serves. An empty baseline confers
 * nothing, and names no rule.
 *
 * @param policy the audience's served resources and the global categories, as one read gave them.
 * @param baseline the record actions the baseline confers on everyone.
 */
export const anonymousCalculation = (
  policy: AudiencePolicy,
  baseline: readonly RecordAction[],
): Calculation =>
  ruleCalculation(policy, [
    { actions: baseline, rule: 'baseline', tier: 'open' },
  ]);
