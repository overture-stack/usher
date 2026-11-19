import type { RecordAction } from '@overture-stack/usher-types';

import type { GrantRuleRecipient, GrantRules } from '../settings/index.js';
import { calculationOf, type HeldEntry, nonEmpty, reachableOf, UNMARKED_CATEGORY } from './heldEntries.js';
import type { AudiencePolicy, BaseTier, Calculation, ConferringRule, ServedResource } from './types.js';

/** A grant rule conferring record actions on the unmarked records of every resource at one base tier. */
export interface Conferral {
	/** The record actions it confers, in its order; none confers nothing. */
	actions: readonly RecordAction[];

	/** The recipient the grant rule confers on. */
	rule: ConferringRule;

	/** The base tier of the resources whose unmarked records it reaches. */
	tier: BaseTier;
}

/**
 * The conferrals the grant rules give the recipients named: each category of each resource of each entry
 * for one of them, under the entry's recipient and the resource's access level, in the order the rules
 * are stored.
 *
 * @param rules the grant rules, as the store holds them.
 * @param recipients the recipients whose entries are taken.
 */
export const grantRuleConferrals = (
	rules: GrantRules,
	recipients: readonly GrantRuleRecipient[],
): readonly Conferral[] =>
	rules
		.filter(({ to }) => recipients.includes(to))
		.flatMap(({ resources, to }) =>
			resources.flatMap(({ accessLevel, categories }) =>
				categories.map(({ actions }) => ({
					actions,
					rule: to,
					tier: accessLevel,
				})),
			),
		);

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
export const ruleEntries = (served: readonly ServedResource[], conferrals: readonly Conferral[]): RuleEntries => {
	const conferring = conferrals.flatMap(({ actions, rule, tier }) => {
		const conferred = nonEmpty(actions);
		return conferred === undefined ? [] : [{ actions: conferred, rule, tier }];
	});
	const held = reachableOf(served).flatMap((resource) =>
		conferring.filter(({ tier }) => tier === resource.baseTier).map((conferral) => ({ conferral, resource })),
	);
	return {
		entries: held.map(({ conferral, resource }) => ({
			category: UNMARKED_CATEGORY,
			externalId: resource.externalId,
			permissions: { record: [...conferral.actions] },
		})),
		rules: conferring
			.map(({ rule }) => rule)
			.filter(
				(rule, index, named) =>
					named.indexOf(rule) === index && held.some(({ conferral }) => conferral.rule === rule),
			),
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
export const ruleCalculation = (policy: AudiencePolicy, conferrals: readonly Conferral[]): Calculation => {
	const { entries, rules } = ruleEntries(policy.served, conferrals);
	return calculationOf(policy, entries, { grantCount: 0, rules });
};
