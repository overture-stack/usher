import { readFirstUser } from './readFirstUser.js';
import { readGrantRateThreshold } from './readGrantRateThreshold.js';
import { DEFAULT_GRANT_RULES, readGrantRules } from './readGrantRules.js';
import type { SettingName, SettingReading, Settings } from './types.js';

/** One setting: its default, whether an admin changes it, its severity when changed, and its reader. */
export interface SettingDefinition<Name extends SettingName> {
	/** Whether the Management API changes it. */
	changeable: boolean;

	/** The value when the first run's seed file gives none; absent where the file must give one. */
	fallback?: Settings[Name];

	/** The severity of its `settings.change` event, or of `grantRules.change` for the grant rules; absent when fixed. */
	severity?: 'critical' | 'warning';

	/** Reads the setting's value from a JSON value. */
	read: (value: unknown) => SettingReading<Settings[Name]>;
}

// The largest delay Node's timers accept, in milliseconds.
const LONGEST_TIMER_MILLISECONDS = 2147483647;

// The same bound in seconds, for a duration that a timer runs for.
const LONGEST_TIMER_SECONDS = 2147483;

const refuse = <Value>(rule: string): SettingReading<Value> => ({ kind: 'refused', rule });

const read = <Value>(value: Value): SettingReading<Value> => ({ kind: 'read', value });

const wholeNumber =
	(minimum: number, maximum: number = Number.MAX_SAFE_INTEGER) =>
	(value: unknown): SettingReading<number> => {
		if (typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum) {
			return read(value);
		}
		return refuse(
			maximum === Number.MAX_SAFE_INTEGER
				? `is not a whole number of at least ${minimum}`
				: `is not a whole number from ${minimum} to ${maximum}`,
		);
	};

const switchValue = (value: unknown): SettingReading<boolean> =>
	typeof value === 'boolean' ? read(value) : refuse('is neither true nor false');

const text =
	(emptyRefused: boolean) =>
	(value: unknown): SettingReading<string> => {
		if (typeof value !== 'string') {
			return refuse('is not text');
		}
		if (value === '' && emptyRefused) {
			return refuse('is empty');
		}
		return read(value);
	};

// The levels a realm gives an ordinary sign-in: Keycloak's own `0` and `1`, and `signin` as this
// platform's realms name it. A step-up level equal to one would count every sign-in.
const BASE_LEVELS: ReadonlySet<string> = new Set(['0', '1', 'signin']);

// Anything but a printable ASCII character, and a double quote or a backslash: none can stand in an
// `acr` written into a challenge's quoted `acr_values`, a header's list separated by spaces.
const UNQUOTABLE = /[^\x21-\x7e]|["\\]/u;

const stepUpLevel = (value: unknown): SettingReading<string> => {
	if (typeof value !== 'string' || value === '') {
		return refuse('is not text holding at least one character');
	}
	if (UNQUOTABLE.test(value)) {
		return refuse('holds a character other than printable ASCII, or a space, a double quote or a backslash');
	}
	return BASE_LEVELS.has(value) ? refuse("is an ordinary sign-in's level: 0, 1 or signin") : read(value);
};

// The longest a step-up may count, in seconds: an hour.
const LONGEST_STEP_UP_WINDOW_SECONDS = 3600;

const GLOBAL_CATEGORY = /^global\.[^.]+$/u;

const globalCategory = (value: unknown): SettingReading<string> => {
	if (typeof value === 'string' && GLOBAL_CATEGORY.test(value)) {
		return read(value);
	}
	return refuse('is not global. followed by the name of a category, which holds no dot');
};

const TIMER_MILLISECONDS = wholeNumber(1, LONGEST_TIMER_MILLISECONDS);

/**
 * Every setting an instance holds, by name, each with its default, its changeability, its severity and
 * its reader. Adding a setting name fails to compile until its definition is written here.
 */
export const SETTING_DEFINITIONS: { readonly [Name in SettingName]: SettingDefinition<Name> } = {
	backChannelLogout: { changeable: true, fallback: true, read: switchValue, severity: 'critical' },
	eventSource: { changeable: false, read: text(true) },
	firstUser: { changeable: false, fallback: { realmRole: 'usher-first-user' }, read: readFirstUser },
	grantAutoAccept: { changeable: true, fallback: false, read: switchValue, severity: 'critical' },
	grantRateThreshold: {
		changeable: true,
		fallback: { operationCount: 10, windowSeconds: 60 },
		read: readGrantRateThreshold,
		severity: 'warning',
	},
	grantRules: { changeable: true, fallback: DEFAULT_GRANT_RULES, read: readGrantRules, severity: 'critical' },
	heartbeatMilliseconds: { changeable: true, fallback: 10000, read: TIMER_MILLISECONDS, severity: 'warning' },
	issuer: { changeable: false, read: text(true) },
	noticePageLimit: { changeable: true, fallback: 500, read: wholeNumber(1), severity: 'warning' },
	noticeRereadMilliseconds: { changeable: true, fallback: 2000, read: TIMER_MILLISECONDS, severity: 'warning' },
	retentionGraceSeconds: { changeable: true, fallback: 60, read: wholeNumber(0), severity: 'critical' },
	retentionMarginSeconds: { changeable: true, fallback: 30, read: wholeNumber(0), severity: 'critical' },
	selfGrantMaximumLifetimeSeconds: { changeable: true, fallback: 86_400, read: wholeNumber(1), severity: 'critical' },
	signInTokenMaximumLifetimeSeconds: {
		changeable: true,
		fallback: 300,
		read: wholeNumber(1),
		severity: 'critical',
	},
	stepUpLevel: { changeable: false, fallback: 'confirmation', read: stepUpLevel },
	stepUpWindowSeconds: {
		changeable: true,
		fallback: 300,
		read: wholeNumber(1, LONGEST_STEP_UP_WINDOW_SECONDS),
		severity: 'critical',
	},
	streamLimitPerAudience: { changeable: true, fallback: 64, read: wholeNumber(1), severity: 'warning' },
	streamMaximumLifetimeSeconds: {
		changeable: true,
		fallback: 900,
		read: wholeNumber(60, LONGEST_TIMER_SECONDS),
		severity: 'warning',
	},
	streamQueueLimit: { changeable: true, fallback: 1000, read: wholeNumber(1), severity: 'warning' },
	submitterCategory: { changeable: true, fallback: 'global.unmarked', read: globalCategory, severity: 'critical' },
	tokenLifetimeSeconds: { changeable: true, fallback: 300, read: wholeNumber(1), severity: 'critical' },
};
