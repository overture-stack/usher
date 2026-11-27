import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type { ControllerConfiguration } from '../configuration/index.js';
import { liveSettingsOf } from './liveSettings.js';
import type { HeldSettings } from './readStoredSettings.js';
import type { SignInTokenMaximumHistory } from './signInTokenMaximum.js';

const HISTORY = [{ recordedAt: 100, seconds: 300 }] as unknown as SignInTokenMaximumHistory;

const HELD: HeldSettings = {
	backChannelLogout: true,
	eventSource: 'https://usher.example.org/controller',
	firstUser: { realmRole: 'usher-first-user' },
	grantAutoAccept: false,
	grantRateThreshold: { operationCount: 10, windowSeconds: 60 },
	heartbeatMilliseconds: 10_000,
	issuer: 'https://usher.example.org',
	noticePageLimit: 100,
	noticeRereadMilliseconds: 1000,
	retentionGraceSeconds: 60,
	retentionMarginSeconds: 60,
	selfGrantMaximumLifetimeSeconds: 86400,
	signInTokenMaximumLifetimeSeconds: 300,
	stepUpLevel: 'confirmation',
	stepUpWindowSeconds: 300,
	streamLimitPerAudience: 64,
	streamMaximumLifetimeSeconds: 3600,
	streamQueueLimit: 64,
	submitterCategory: 'global.unmarked',
	tokenLifetimeSeconds: 300,
};

suite('the live settings', () => {
	test('read each setting from the source at the moment it is read', () => {
		const configuration = { host: '127.0.0.1', port: 3000 } as unknown as ControllerConfiguration;
		let current: HeldSettings = HELD;
		const live = liveSettingsOf(configuration, { current: () => current, maximumHistory: () => HISTORY });
		assert.equal(live.issuer, 'https://usher.example.org');
		current = { ...HELD, issuer: 'https://usher.example.net' };
		assert.equal(live.issuer, 'https://usher.example.net');
	});

	test("judges a token's lifetime by the maximum in force at its issue, read from the source as each judgement is made", () => {
		const configuration = { host: '127.0.0.1', port: 3000 } as unknown as ControllerConfiguration;
		let history: SignInTokenMaximumHistory = HISTORY;
		const live = liveSettingsOf(configuration, { current: () => HELD, maximumHistory: () => history });
		assert.equal(live.signInTokenMaximumFor(500), 300);
		history = [...HISTORY, { recordedAt: 1000, seconds: 60 }] as unknown as SignInTokenMaximumHistory;
		assert.equal(live.signInTokenMaximumFor(500), 60);
	});

	test('keep the configuration the environment gave, and no setting it lacks', () => {
		const configuration = { host: '127.0.0.1', port: 3000 } as unknown as ControllerConfiguration;
		const live = liveSettingsOf(configuration, { current: () => HELD, maximumHistory: () => HISTORY });
		assert.equal(live.host, '127.0.0.1');
		assert.equal(live.port, 3000);
		assert.deepEqual(Object.keys(live).includes('grantRules'), false);
	});
});
