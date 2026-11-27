import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { SETTING_DEFINITIONS } from './settingDefinitions.js';
import type { SettingName } from './types.js';

const ALL_NAMES: readonly SettingName[] = [
	'backChannelLogout',
	'eventSource',
	'firstUser',
	'grantAutoAccept',
	'grantRateThreshold',
	'grantRules',
	'heartbeatMilliseconds',
	'issuer',
	'noticePageLimit',
	'noticeRereadMilliseconds',
	'retentionGraceSeconds',
	'retentionMarginSeconds',
	'selfGrantMaximumLifetimeSeconds',
	'signInTokenMaximumLifetimeSeconds',
	'stepUpLevel',
	'stepUpWindowSeconds',
	'streamLimitPerAudience',
	'streamMaximumLifetimeSeconds',
	'streamQueueLimit',
	'submitterCategory',
	'tokenLifetimeSeconds',
];

const FIXED: readonly SettingName[] = ['eventSource', 'firstUser', 'issuer', 'stepUpLevel'];

const CRITICAL: readonly SettingName[] = [
	'backChannelLogout',
	'grantAutoAccept',
	'grantRules',
	'retentionGraceSeconds',
	'retentionMarginSeconds',
	'selfGrantMaximumLifetimeSeconds',
	'signInTokenMaximumLifetimeSeconds',
	'stepUpWindowSeconds',
	'submitterCategory',
	'tokenLifetimeSeconds',
];

const WARNING: readonly SettingName[] = [
	'grantRateThreshold',
	'heartbeatMilliseconds',
	'noticePageLimit',
	'noticeRereadMilliseconds',
	'streamLimitPerAudience',
	'streamMaximumLifetimeSeconds',
	'streamQueueLimit',
];

const valueOf = (name: SettingName, value: unknown) => {
	const reading = SETTING_DEFINITIONS[name].read(value);
	assert.equal(reading.kind, 'read', `${name} reads ${JSON.stringify(value)}`);
	return reading.kind === 'read' ? reading.value : undefined;
};

const refusedBy = (name: SettingName, value: unknown): boolean =>
	SETTING_DEFINITIONS[name].read(value).kind === 'refused';

suite('setting definitions', () => {
	test('defines exactly the settings the settings table names', () => {
		assert.deepEqual(Object.keys(SETTING_DEFINITIONS).toSorted(), [...ALL_NAMES].toSorted());
	});

	test('gives each setting its default as the Controller applies it today, and the spec for the new ones', () => {
		assert.equal(SETTING_DEFINITIONS.signInTokenMaximumLifetimeSeconds.fallback, 300);
		assert.equal(SETTING_DEFINITIONS.tokenLifetimeSeconds.fallback, 300);
		assert.equal(SETTING_DEFINITIONS.retentionGraceSeconds.fallback, 60);
		assert.equal(SETTING_DEFINITIONS.retentionMarginSeconds.fallback, 30);
		assert.equal(SETTING_DEFINITIONS.heartbeatMilliseconds.fallback, 10000);
		assert.equal(SETTING_DEFINITIONS.noticePageLimit.fallback, 500);
		assert.equal(SETTING_DEFINITIONS.noticeRereadMilliseconds.fallback, 2000);
		assert.equal(SETTING_DEFINITIONS.streamLimitPerAudience.fallback, 64);
		assert.equal(SETTING_DEFINITIONS.streamMaximumLifetimeSeconds.fallback, 900);
		assert.equal(SETTING_DEFINITIONS.streamQueueLimit.fallback, 1000);
		assert.equal(SETTING_DEFINITIONS.grantAutoAccept.fallback, false);
		assert.equal(SETTING_DEFINITIONS.backChannelLogout.fallback, true);
		assert.equal(SETTING_DEFINITIONS.submitterCategory.fallback, 'global.unmarked');
		assert.deepEqual(SETTING_DEFINITIONS.firstUser.fallback, { realmRole: 'usher-first-user' });
		assert.equal(SETTING_DEFINITIONS.stepUpLevel.fallback, 'confirmation');
		assert.equal(SETTING_DEFINITIONS.stepUpWindowSeconds.fallback, 300);
	});

	test('gives issuer and eventSource no default, so a first run must name them', () => {
		assert.equal(SETTING_DEFINITIONS.issuer.fallback, undefined);
		assert.equal(SETTING_DEFINITIONS.eventSource.fallback, undefined);
	});

	test('marks eventSource, firstUser, issuer and stepUpLevel as fixed after the first run, and the rest as changeable', () => {
		ALL_NAMES.forEach((name) => assert.equal(SETTING_DEFINITIONS[name].changeable, !FIXED.includes(name), name));
	});

	test('gives each changeable setting the severity its settings.change event records', () => {
		CRITICAL.forEach((name) => assert.equal(SETTING_DEFINITIONS[name].severity, 'critical', name));
		WARNING.forEach((name) => assert.equal(SETTING_DEFINITIONS[name].severity, 'warning', name));
	});

	test('gives a fixed setting no severity, since no change to it is recorded', () => {
		FIXED.forEach((name) => assert.equal(SETTING_DEFINITIONS[name].severity, undefined, name));
	});

	test("reads a whole number of seconds within the Controller's bounds, and refuses anything else", () => {
		assert.equal(valueOf('signInTokenMaximumLifetimeSeconds', 1), 1);
		assert.equal(refusedBy('signInTokenMaximumLifetimeSeconds', 0), true);
		assert.equal(valueOf('retentionGraceSeconds', 0), 0);
		assert.equal(refusedBy('retentionGraceSeconds', -1), true);
		assert.equal(refusedBy('tokenLifetimeSeconds', 0), true);
		assert.equal(refusedBy('noticePageLimit', 0), true);
		assert.equal(refusedBy('streamLimitPerAudience', 0), true);
		assert.equal(refusedBy('streamQueueLimit', 0), true);
	});

	test('refuses a number that is not a whole number, a string holding digits, or a boolean', () => {
		assert.equal(refusedBy('noticePageLimit', 1.5), true);
		assert.equal(refusedBy('noticePageLimit', '500'), true);
		assert.equal(refusedBy('noticePageLimit', true), true);
		assert.equal(refusedBy('noticePageLimit', null), true);
	});

	test('bounds each timer in milliseconds to the longest Node timers accept', () => {
		assert.equal(valueOf('heartbeatMilliseconds', 2147483647), 2147483647);
		assert.equal(refusedBy('heartbeatMilliseconds', 2147483648), true);
		assert.equal(valueOf('noticeRereadMilliseconds', 1), 1);
		assert.equal(refusedBy('noticeRereadMilliseconds', 2147483648), true);
	});

	test('bounds the stream lifetime at least at 60 seconds and at most at 2,147,483 seconds', () => {
		assert.equal(valueOf('streamMaximumLifetimeSeconds', 60), 60);
		assert.equal(valueOf('streamMaximumLifetimeSeconds', 2147483), 2147483);
		assert.equal(refusedBy('streamMaximumLifetimeSeconds', 59), true);
		assert.equal(refusedBy('streamMaximumLifetimeSeconds', 2147484), true);
	});

	test('reads a switch only as a JSON boolean', () => {
		assert.equal(valueOf('grantAutoAccept', true), true);
		assert.equal(valueOf('backChannelLogout', false), false);
		assert.equal(refusedBy('grantAutoAccept', 'true'), true);
		assert.equal(refusedBy('backChannelLogout', 1), true);
	});

	test('reads a submitter category only as global. followed by a name holding no dot', () => {
		assert.equal(valueOf('submitterCategory', 'global.controlled'), 'global.controlled');
		assert.equal(refusedBy('submitterCategory', 'controlled'), true);
		assert.equal(refusedBy('submitterCategory', 'global.a.b'), true);
		assert.equal(refusedBy('submitterCategory', 'global.'), true);
	});

	test('reads issuer and eventSource as non-empty text', () => {
		assert.equal(valueOf('issuer', 'https://access.example.org/usher'), 'https://access.example.org/usher');
		assert.equal(valueOf('eventSource', 'usher'), 'usher');
		assert.equal(refusedBy('issuer', ''), true);
		assert.equal(refusedBy('eventSource', 3), true);
	});

	test('reads the first user through the first-user reader', () => {
		assert.deepEqual(valueOf('firstUser', { subject: 'a1b2c3' }), { subject: 'a1b2c3' });
		assert.equal(refusedBy('firstUser', { realmRole: 'a', subject: 'b' }), true);
	});

	test('bounds the step-up window from 1 second to an hour', () => {
		assert.equal(valueOf('stepUpWindowSeconds', 1), 1);
		assert.equal(valueOf('stepUpWindowSeconds', 3600), 3600);
		assert.equal(refusedBy('stepUpWindowSeconds', 0), true);
		assert.equal(refusedBy('stepUpWindowSeconds', 3601), true);
	});

	test('reads a step-up level as printable ASCII text', () => {
		assert.equal(valueOf('stepUpLevel', 'confirmation'), 'confirmation');
		assert.equal(valueOf('stepUpLevel', 'urn:example:loa:2'), 'urn:example:loa:2');
	});

	test("refuses a step-up level that is empty, not text, or an ordinary sign-in's level", () => {
		assert.deepEqual(
			['', 2, null, '0', '1', 'signin'].map((value) => refusedBy('stepUpLevel', value)),
			[true, true, true, true, true, true],
		);
	});

	test("refuses a step-up level that cannot stand in a challenge's quoted acr_values", () => {
		assert.deepEqual(
			['mfa two', 'mfa"', 'mfa\\', 'mfa\t', 'mfa\u0000', 'niveau-é'].map((value) =>
				refusedBy('stepUpLevel', value),
			),
			[true, true, true, true, true, true],
		);
	});

	test('reads the grant rules through the grant rules reader', () => {
		assert.deepEqual(valueOf('grantRules', []), []);
		assert.equal(refusedBy('grantRules', {}), true);
	});
});
