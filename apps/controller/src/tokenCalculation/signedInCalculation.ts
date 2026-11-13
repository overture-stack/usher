import type { RecordAction } from '@overture-stack/usher-types';

import { ruleCalculation } from './ruleCalculation.js';
import type { AudiencePolicy, Calculation } from './types.js';

/**
 * Calculates what a signed-in principal holds for one audience through the rules alone, from one read
 * of the store: the baseline's record actions on `global.unmarked` of every resource the audience
 * serves whose unmarked records are open, and the signed-in rule's on those of every resource whose
 * unmarked records are registered. A resource whose unmarked records are by grant is held through
 * neither, and no recorded grant is read, so none is counted. A suppressed resource is held by nobody
 * and stays served; a retired one is neither held nor served. Beside what is held, the offerings, as
 * the anonymous calculation gives them. Each rule conferring an entry is named once, the baseline
 * first; an empty rule confers nothing, and is not named.
 *
 * @param policy the audience's served resources and the global categories, as one read gave them.
 * @param baseline the record actions the baseline confers on everyone.
 * @param signedInRule the record actions the signed-in rule confers on every signed-in principal.
 */
export const signedInCalculation = (
  policy: AudiencePolicy,
  baseline: readonly RecordAction[],
  signedInRule: readonly RecordAction[],
): Calculation =>
  ruleCalculation(policy, [
    { actions: baseline, rule: 'baseline', tier: 'open' },
    { actions: signedInRule, rule: 'signedIn', tier: 'registered' },
  ]);
