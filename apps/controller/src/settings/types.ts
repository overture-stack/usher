/** Every setting an instance holds in its store, by name. */
export type SettingName =
	| 'backChannelLogout'
	| 'eventSource'
	| 'firstUser'
	| 'grantAutoAccept'
	| 'grantRules'
	| 'heartbeatMilliseconds'
	| 'issuer'
	| 'noticePageLimit'
	| 'noticeRereadMilliseconds'
	| 'retentionGraceSeconds'
	| 'retentionMarginSeconds'
	| 'selfGrantMaximumLifetimeSeconds'
	| 'signInTokenMaximumLifetimeSeconds'
	| 'streamLimitPerAudience'
	| 'streamMaximumLifetimeSeconds'
	| 'streamQueueLimit'
	| 'submitterCategory'
	| 'tokenLifetimeSeconds';

/** A setting fixed after the first run: a change to it is refused, and no change to it is recorded. */
export type FixedSettingName = 'eventSource' | 'firstUser' | 'issuer';

/** A setting an admin changes through the Management API. */
export type ChangeableSettingName = Exclude<SettingName, FixedSettingName>;

/** A category name with its scope: `global.` and a name, such as `global.unmarked`. */
export type ScopedCategoryName = string;

/** Who a grant rule confers on: everyone, or everyone signed in. */
export type GrantRuleRecipient = 'everyone' | 'signedIn';

/** A record action a grant rule may confer: reading records, never writing them. */
export type GrantRuleAction = 'count' | 'export' | 'view';

/** One category a grant rule confers actions on. */
export type GrantRuleCategory = {
	/** The actions conferred, each named once; empty confers none. */
	actions: readonly GrantRuleAction[];

	/** The category, which only `global.unmarked` may be for now. */
	name: ScopedCategoryName;
};

/** The categories a grant rule confers on one access level of resources. */
export type GrantRuleResource = {
	/** Which resources, by access level: `open` or `registered`. */
	accessLevel: 'open' | 'registered';

	/** The categories conferred, each named once. */
	categories: readonly GrantRuleCategory[];
};

/** One recipient's grant rule. */
export type GrantRule = {
	/** Who it confers on, given once across the rules. */
	to: GrantRuleRecipient;

	/** What it confers, by access level. */
	resources: readonly GrantRuleResource[];
};

/** The grant rules an instance holds: a list of entries, each recipient named at most once. */
export type GrantRules = readonly GrantRule[];

/** Who the first user is: a realm role, or one subject at the identity provider, and exactly one of them. */
export type FirstUser = { realmRole: string } | { subject: string };

/** Every setting's value, one member per setting. */
export interface Settings {
	/** Whether a back-channel logout from the identity provider is relayed. */
	backChannelLogout: boolean;

	/** The source named on every audit event. Fixed after the first run. */
	eventSource: string;

	/** The first user nominating the first administrator. Fixed after the first run. */
	firstUser: FirstUser;

	/** Whether a grant request is accepted without review. */
	grantAutoAccept: boolean;

	/** The grant rules, held in the store and never read from the environment. */
	grantRules: GrantRules;

	/** The interval between heartbeats on a notice stream, in milliseconds. */
	heartbeatMilliseconds: number;

	/** The issuer of the tokens Usher returns. Fixed after the first run. */
	issuer: string;

	/** The most notices one page holds. */
	noticePageLimit: number;

	/** The interval between rereads of the notice stream, in milliseconds. */
	noticeRereadMilliseconds: number;

	/** The grace period a notice is kept beyond the token lifetime, in seconds. */
	retentionGraceSeconds: number;

	/** The margin a notice is kept beyond the grace period, in seconds. */
	retentionMarginSeconds: number;

	/**
	 * The longest a self-grant lives, in seconds, from the instant it is asked for; it bounds an owner extending or
	 * widening a grant they hold too, measured from the change.
	 */
	selfGrantMaximumLifetimeSeconds: number;

	/** The longest a sign-in token may live, in seconds. */
	signInTokenMaximumLifetimeSeconds: number;

	/** The most open notice streams one audience may hold. */
	streamLimitPerAudience: number;

	/** The longest a notice stream stays open, in seconds. */
	streamMaximumLifetimeSeconds: number;

	/** The most notices one stream may queue. */
	streamQueueLimit: number;

	/** The category a grant request from a submitter is recorded under. */
	submitterCategory: ScopedCategoryName;

	/** How long an issued token lives, in seconds. */
	tokenLifetimeSeconds: number;
}

/** What reading one setting's value gave: the value, or the rule it broke, which never quotes the value. */
export type SettingReading<Value> = { kind: 'read'; value: Value } | { kind: 'refused'; rule: string };

/** The three durations a notice retention floor is made of. */
export type RetentionDurations = Pick<
	Settings,
	'retentionGraceSeconds' | 'retentionMarginSeconds' | 'tokenLifetimeSeconds'
>;

/** A rule laid across settings read together, naming the setting it is laid on. */
export interface SettingsProblem {
	/** The rule, worded to follow the setting's name. */
	rule: string;

	/** The setting the rule is laid on. */
	setting: SettingName;
}
