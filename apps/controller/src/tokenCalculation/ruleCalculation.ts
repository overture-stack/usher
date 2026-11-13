import type {
  CategoryName,
  NonEmpty,
  RecordAction,
  ResourcePermissions,
} from '@overture-stack/usher-types';

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

// The global category of the records matching no other, which a payload never lists as concrete.
const UNMARKED = 'unmarked';

const UNMARKED_CATEGORY: CategoryName = `global.${UNMARKED}`;

const isCurrent = ({ retired }: ServedResource): boolean => !retired;

const nonEmpty = (
  actions: readonly RecordAction[],
): NonEmpty<RecordAction> | undefined => {
  const [first, ...rest] = actions;
  return first === undefined ? undefined : [first, ...rest];
};

const unmarkedEntry = (
  actions: NonEmpty<RecordAction>,
): ResourcePermissions => ({ [UNMARKED_CATEGORY]: { record: [...actions] } });

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
  { globalCategories, served }: AudiencePolicy,
  conferrals: readonly Conferral[],
): Calculation => {
  const current = served.filter(isCurrent);
  const conferring = conferrals.flatMap(({ actions, rule, tier }) => {
    const conferred = nonEmpty(actions);
    return conferred === undefined ? [] : [{ actions: conferred, rule, tier }];
  });
  const held = current.flatMap((resource) => {
    const conferral = resource.suppressed
      ? undefined
      : conferring.find(({ tier }) => tier === resource.baseTier);
    return conferral === undefined ? [] : [{ conferral, resource }];
  });
  return {
    globalCategories: globalCategories
      .filter((name) => name !== UNMARKED)
      .map((name): CategoryName => `global.${name}`),
    grantCount: 0,
    permissions: Object.fromEntries(
      held.map(({ conferral, resource }) => [
        resource.externalId,
        unmarkedEntry(conferral.actions),
      ]),
    ),
    resourceCategories: Object.fromEntries(
      held.map(({ resource: { externalId, ownCategories } }) => [
        externalId,
        ownCategories.map((name): CategoryName => `resource.${name}`),
      ]),
    ),
    rules: conferring
      .filter(({ rule }) =>
        held.some(({ conferral }) => conferral.rule === rule),
      )
      .map(({ rule }) => rule),
    servedResources: current.map(({ externalId }) => externalId),
  };
};
