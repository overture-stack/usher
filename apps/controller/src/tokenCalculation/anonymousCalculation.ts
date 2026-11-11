import type {
  CategoryName,
  NonEmpty,
  RecordAction,
  ResourcePermissions,
} from '@overture-stack/usher-types';

import type { AudiencePolicy, Calculation, ServedResource } from './types.js';

// The global category of the records matching no other, which a payload never lists as concrete.
const UNMARKED = 'unmarked';

const UNMARKED_CATEGORY: CategoryName = `global.${UNMARKED}`;

const isCurrent = ({ retired }: ServedResource): boolean => !retired;

// A resource whose unmarked records are open to everyone: open at its base tier, and not suppressed,
// since a suppressed resource is reached by nobody.
const isOpen = ({ baseTier, suppressed }: ServedResource): boolean =>
  baseTier === 'open' && !suppressed;

const nonEmpty = (
  actions: readonly RecordAction[],
): NonEmpty<RecordAction> | undefined => {
  const [first, ...rest] = actions;
  return first === undefined ? undefined : [first, ...rest];
};

const baselineEntry = (
  actions: NonEmpty<RecordAction>,
): ResourcePermissions => ({ [UNMARKED_CATEGORY]: { record: [...actions] } });

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
  { globalCategories, served }: AudiencePolicy,
  baseline: readonly RecordAction[],
): Calculation => {
  const current = served.filter(isCurrent);
  const actions = nonEmpty(baseline);
  const held =
    actions === undefined
      ? []
      : current
          .filter(isOpen)
          .map((resource) => ({ entry: baselineEntry(actions), resource }));
  return {
    globalCategories: globalCategories
      .filter((name) => name !== UNMARKED)
      .map((name): CategoryName => `global.${name}`),
    grantCount: 0,
    permissions: Object.fromEntries(
      held.map(({ entry, resource }) => [resource.externalId, entry]),
    ),
    resourceCategories: Object.fromEntries(
      held.map(({ resource: { externalId, ownCategories } }) => [
        externalId,
        ownCategories.map((name): CategoryName => `resource.${name}`),
      ]),
    ),
    rules: held.length > 0 ? ['baseline'] : [],
    servedResources: current.map(({ externalId }) => externalId),
  };
};
