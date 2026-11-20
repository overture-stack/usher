import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { readHeldSettings, readStoredSettings, type StoredSetting } from './readStoredSettings.js';
import { DEFAULT_GRANT_RULES } from './readGrantRules.js';
import { SETTING_DEFINITIONS } from './settingDefinitions.js';
import type { SettingName, Settings } from './types.js';

const SETTING_NAMES = Object.keys(SETTING_DEFINITIONS) as readonly SettingName[];

const DEFAULT_VALUES: Readonly<Record<string, unknown>> = {
	backChannelLogout: true,
	eventSource: 'usher',
	firstUser: { realmRole: 'usher-first-user' },
	grantAutoAccept: false,
	grantRateThreshold: { operationCount: 10, windowSeconds: 60 },
	grantRules: DEFAULT_GRANT_RULES,
	heartbeatMilliseconds: 10000,
	issuer: 'https://access.example.org/usher',
	noticePageLimit: 500,
	noticeRereadMilliseconds: 2000,
	retentionGraceSeconds: 60,
	retentionMarginSeconds: 30,
	selfGrantMaximumLifetimeSeconds: 86400,
	signInTokenMaximumLifetimeSeconds: 300,
	streamLimitPerAudience: 64,
	streamMaximumLifetimeSeconds: 900,
	streamQueueLimit: 1000,
	submitterCategory: 'global.unmarked',
	tokenLifetimeSeconds: 300,
};

const rowsWith = (
	overrides: Readonly<Record<string, unknown>>,
	omitted: readonly string[] = [],
): readonly StoredSetting[] =>
	SETTING_NAMES.filter((name) => !omitted.includes(name)).map((name) => ({
		name,
		value: Object.hasOwn(overrides, name) ? overrides[name] : DEFAULT_VALUES[name],
	}));

const settingsOfDefaults = (): Settings => ({
	backChannelLogout: true,
	eventSource: 'usher',
	firstUser: { realmRole: 'usher-first-user' },
	grantAutoAccept: false,
	grantRateThreshold: { operationCount: 10, windowSeconds: 60 },
	grantRules: DEFAULT_GRANT_RULES,
	heartbeatMilliseconds: 10000,
	issuer: 'https://access.example.org/usher',
	noticePageLimit: 500,
	noticeRereadMilliseconds: 2000,
	retentionGraceSeconds: 60,
	retentionMarginSeconds: 30,
	selfGrantMaximumLifetimeSeconds: 86400,
	signInTokenMaximumLifetimeSeconds: 300,
	streamLimitPerAudience: 64,
	streamMaximumLifetimeSeconds: 900,
	streamQueueLimit: 1000,
	submitterCategory: 'global.unmarked',
	tokenLifetimeSeconds: 300,
});

suite('reading the settings the store holds', () => {
	test('reads every setting from its row', () => {
		assert.deepEqual(readStoredSettings(rowsWith({})), { kind: 'read', settings: settingsOfDefaults() });
	});

	test('names a setting whose row is missing, as a problem of its own', () => {
		assert.deepEqual(readStoredSettings(rowsWith({}, ['noticePageLimit'])), {
			kind: 'refused',
			problems: [{ rule: 'is missing from the store', setting: 'noticePageLimit' }],
		});
	});

	test('names the setting whose value breaks its rule, with the rule', () => {
		assert.deepEqual(readStoredSettings(rowsWith({ noticePageLimit: 0 })), {
			kind: 'refused',
			problems: [{ rule: 'is not a whole number of at least 1', setting: 'noticePageLimit' }],
		});
	});

	test('never quotes a stored value in a problem', () => {
		const reading = readStoredSettings(rowsWith({ submitterCategory: 'stored-value-not-quoted' }));
		assert.equal(reading.kind, 'refused');
		assert.equal(JSON.stringify(reading).includes('stored-value-not-quoted'), false);
	});

	test('refuses a stored grant rules value that breaks the grant rules rule', () => {
		const reading = readStoredSettings(rowsWith({ grantRules: [{ resources: [], to: 'nobody' }] }));
		assert.equal(reading.kind, 'refused');
		assert.equal(reading.kind === 'refused' && reading.problems[0]?.setting, 'grantRules');
	});

	test('lays the retention floor rule on each duration the sum passes', () => {
		const largest = 2147483647;
		assert.deepEqual(
			readStoredSettings(
				rowsWith({ retentionGraceSeconds: largest, retentionMarginSeconds: 1, tokenLifetimeSeconds: 1 }),
			),
			{
				kind: 'refused',
				problems: [
					{
						rule: `adds to a retention floor of more than ${largest} seconds, the most one may be`,
						setting: 'retentionGraceSeconds',
					},
					{
						rule: `adds to a retention floor of more than ${largest} seconds, the most one may be`,
						setting: 'retentionMarginSeconds',
					},
					{
						rule: `adds to a retention floor of more than ${largest} seconds, the most one may be`,
						setting: 'tokenLifetimeSeconds',
					},
				],
			},
		);
	});

	test('reads the held settings without requiring a grant rules row', () => {
		const held = readHeldSettings(rowsWith({}, ['grantRules']));
		assert.deepEqual(held, {
			kind: 'read',
			settings: Object.fromEntries(
				Object.entries(settingsOfDefaults()).filter(([name]) => name !== 'grantRules'),
			),
		});
	});
});
