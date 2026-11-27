import { readTogether } from './readTogether.js';
import { SETTING_DEFINITIONS } from './settingDefinitions.js';
import { type HeldReadings, heldOf } from './settingsOf.js';
import type { SettingName, SettingReading, Settings, SettingsProblem } from './types.js';

/** One row of the `settings` table: a setting's name and the value the store holds for it. */
export interface StoredSetting {
	/** The setting's name. */
	name: string;

	/** The value as the store holds it. */
	value: unknown;
}

/** Every setting but the grant rules, which an exchange reads with its policy and never holds. */
export type HeldSettings = Omit<Settings, 'grantRules'>;

/** What reading the stored settings gave: every setting's value, or each rule the rows break. */
export type StoredSettingsReading =
	{ kind: 'read'; settings: Settings } | { kind: 'refused'; problems: readonly SettingsProblem[] };

/** What reading the held settings gave: their values, or each rule the rows break. */
export type HeldSettingsReading =
	{ kind: 'read'; settings: HeldSettings } | { kind: 'refused'; problems: readonly SettingsProblem[] };

const MISSING_RULE = 'is missing from the store';

// The stored value of one setting, read by its definition; a setting with no row is refused as missing.
const readStored = <Name extends SettingName>(
	rows: readonly StoredSetting[],
	name: Name,
): SettingReading<Settings[Name]> => {
	const row = rows.find((candidate) => candidate.name === name);
	return row === undefined ? { kind: 'refused', rule: MISSING_RULE } : SETTING_DEFINITIONS[name].read(row.value);
};

// The problems of the readings that refused, each naming its setting. Object keys are setting names here.
const problemsOf = (readings: object): readonly SettingsProblem[] =>
	Object.entries(readings).flatMap(([setting, reading]: [string, SettingReading<unknown>]) =>
		reading.kind === 'refused' ? [{ rule: reading.rule, setting: setting as SettingName }] : [],
	);

/**
 * Reads every setting but the grant rules from the rows of the `settings` table, one row each, by its
 * definition, then applies the rules laid across settings read together. A setting whose row is missing
 * or whose value breaks its rule is a problem naming it, and no problem quotes a stored value.
 *
 * @param rows the rows of the `settings` table, as the store holds them.
 */
export const readHeldSettings = (rows: readonly StoredSetting[]): HeldSettingsReading => {
	const readings: HeldReadings = {
		backChannelLogout: readStored(rows, 'backChannelLogout'),
		eventSource: readStored(rows, 'eventSource'),
		firstUser: readStored(rows, 'firstUser'),
		grantAutoAccept: readStored(rows, 'grantAutoAccept'),
		grantRateThreshold: readStored(rows, 'grantRateThreshold'),
		heartbeatMilliseconds: readStored(rows, 'heartbeatMilliseconds'),
		issuer: readStored(rows, 'issuer'),
		noticePageLimit: readStored(rows, 'noticePageLimit'),
		noticeRereadMilliseconds: readStored(rows, 'noticeRereadMilliseconds'),
		retentionGraceSeconds: readStored(rows, 'retentionGraceSeconds'),
		retentionMarginSeconds: readStored(rows, 'retentionMarginSeconds'),
		selfGrantMaximumLifetimeSeconds: readStored(rows, 'selfGrantMaximumLifetimeSeconds'),
		signInTokenMaximumLifetimeSeconds: readStored(rows, 'signInTokenMaximumLifetimeSeconds'),
		stepUpLevel: readStored(rows, 'stepUpLevel'),
		stepUpWindowSeconds: readStored(rows, 'stepUpWindowSeconds'),
		streamLimitPerAudience: readStored(rows, 'streamLimitPerAudience'),
		streamMaximumLifetimeSeconds: readStored(rows, 'streamMaximumLifetimeSeconds'),
		streamQueueLimit: readStored(rows, 'streamQueueLimit'),
		submitterCategory: readStored(rows, 'submitterCategory'),
		tokenLifetimeSeconds: readStored(rows, 'tokenLifetimeSeconds'),
	};
	const problems = problemsOf(readings);
	const held = heldOf(readings);
	if (problems.length > 0 || held === undefined) {
		return { kind: 'refused', problems };
	}
	const togetherProblems = readTogether(held);
	return togetherProblems.length > 0
		? { kind: 'refused', problems: togetherProblems }
		: { kind: 'read', settings: held };
};

/**
 * Reads every setting the store holds, the grant rules included, from the rows of the `settings` table.
 * A setting whose row is missing or whose value breaks its rule is a problem naming it, and no problem
 * quotes a stored value.
 *
 * @param rows the rows of the `settings` table, as the store holds them.
 */
export const readStoredSettings = (rows: readonly StoredSetting[]): StoredSettingsReading => {
	const held = readHeldSettings(rows);
	const grantRules = readStored(rows, 'grantRules');
	const problems = [
		...(held.kind === 'refused' ? held.problems : []),
		...(grantRules.kind === 'refused' ? [{ rule: grantRules.rule, setting: 'grantRules' as const }] : []),
	];
	if (problems.length > 0 || held.kind === 'refused' || grantRules.kind === 'refused') {
		return { kind: 'refused', problems };
	}
	return { kind: 'read', settings: { ...held.settings, grantRules: grantRules.value } };
};
