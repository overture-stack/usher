import { readStrictJson } from '../strictJson/index.js';
import { readTogether } from './readTogether.js';
import { SETTING_DEFINITIONS } from './settingDefinitions.js';
import { type Readings, settingsOf } from './settingsOf.js';
import type { SettingName, SettingReading, Settings } from './types.js';

/** What reading the seed file gave: every setting's value, or each rule it broke. */
export type SeedReading = { kind: 'read'; settings: Settings } | { kind: 'refused'; rules: readonly string[] };

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const isSettingName = (name: string): name is SettingName => Object.hasOwn(SETTING_DEFINITIONS, name);

// A setting the file gives is read by its definition; one it omits takes its default, and one with none must be given.
const readSetting = <Name extends SettingName>(
	members: Readonly<Record<string, unknown>>,
	name: Name,
): SettingReading<Settings[Name]> => {
	const definition = SETTING_DEFINITIONS[name];
	if (Object.hasOwn(members, name)) {
		return definition.read(members[name]);
	}
	return definition.fallback === undefined
		? { kind: 'refused', rule: 'is missing, which a first run needs' }
		: { kind: 'read', value: definition.fallback };
};

/** What reading the seed file's text as members gave: the one JSON object it holds, or the rule the text breaks. */
export type SeedMembersReading =
	{ kind: 'read'; members: Readonly<Record<string, unknown>> } | { kind: 'refused'; rule: string };

/**
 * Reads the seed file's text as the one JSON object it holds, its members as written, with no setting read
 * or validated: a later run compares the members a file holds with the ones the first run stored. Text that
 * is not one JSON object is refused with the rule it breaks, quoting none of the text.
 *
 * @param text the file's text.
 * @returns the object's members, or the rule the text breaks.
 */
export const readSeedMembers = (text: string): SeedMembersReading => {
	const json = readStrictJson(text);
	if (json.kind === 'refused') {
		return json;
	}
	return isObject(json.value)
		? { kind: 'read', members: json.value }
		: { kind: 'refused', rule: 'is not one object of settings' };
};

/**
 * Reads the seed file's text, which the schema migration command reads on a first run alone: JSON
 * holding one object, whose members name settings, each read by its definition. A setting the file omits
 * takes its default, and issuer and eventSource have none, so the file must name them. Every rule broken is
 * listed, each opening with the member it is laid on, and no rule quotes a value. The retention durations
 * are then read together.
 *
 * @param text the file's text.
 */
export const readSeedFile = (text: string): SeedReading => {
	const reading = readSeedMembers(text);
	if (reading.kind === 'refused') {
		return { kind: 'refused', rules: [reading.rule] };
	}
	const members = reading.members;
	const unknownMember = Object.keys(members).some((name) => !isSettingName(name));
	const readings: Readings = {
		backChannelLogout: readSetting(members, 'backChannelLogout'),
		eventSource: readSetting(members, 'eventSource'),
		firstUser: readSetting(members, 'firstUser'),
		grantAutoAccept: readSetting(members, 'grantAutoAccept'),
		grantRateThreshold: readSetting(members, 'grantRateThreshold'),
		grantRules: readSetting(members, 'grantRules'),
		heartbeatMilliseconds: readSetting(members, 'heartbeatMilliseconds'),
		issuer: readSetting(members, 'issuer'),
		noticePageLimit: readSetting(members, 'noticePageLimit'),
		noticeRereadMilliseconds: readSetting(members, 'noticeRereadMilliseconds'),
		retentionGraceSeconds: readSetting(members, 'retentionGraceSeconds'),
		retentionMarginSeconds: readSetting(members, 'retentionMarginSeconds'),
		selfGrantMaximumLifetimeSeconds: readSetting(members, 'selfGrantMaximumLifetimeSeconds'),
		signInTokenMaximumLifetimeSeconds: readSetting(members, 'signInTokenMaximumLifetimeSeconds'),
		streamLimitPerAudience: readSetting(members, 'streamLimitPerAudience'),
		streamMaximumLifetimeSeconds: readSetting(members, 'streamMaximumLifetimeSeconds'),
		streamQueueLimit: readSetting(members, 'streamQueueLimit'),
		submitterCategory: readSetting(members, 'submitterCategory'),
		tokenLifetimeSeconds: readSetting(members, 'tokenLifetimeSeconds'),
	};
	const settingRules = Object.entries(readings).flatMap(([name, reading]) =>
		reading.kind === 'refused' ? [`${name} ${reading.rule}`] : [],
	);
	const unknownRules = unknownMember ? ['holds a member that no setting takes'] : [];
	const settings = settingsOf(readings);
	const togetherRules =
		settings === undefined ? [] : readTogether(settings).map(({ rule, setting }) => `${setting} ${rule}`);
	const rules = [...unknownRules, ...settingRules, ...togetherRules];
	if (rules.length > 0 || settings === undefined) {
		return { kind: 'refused', rules };
	}
	return { kind: 'read', settings };
};
