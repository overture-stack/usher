import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { suite, test } from 'node:test';

import { readSeedFile, readSeedMembers } from './readSeedFile.js';
import { SETTING_DEFINITIONS } from './settingDefinitions.js';

const REQUIRED = '{"eventSource":"usher","issuer":"https://access.example.org/usher"}';

const defaultsWith = (overrides: Readonly<Record<string, unknown>>): Record<string, unknown> => ({
	backChannelLogout: SETTING_DEFINITIONS.backChannelLogout.fallback,
	eventSource: 'usher',
	firstUser: { realmRole: 'usher-first-user' },
	grantAutoAccept: false,
	grantRateThreshold: { operationCount: 10, windowSeconds: 60 },
	grantRules: SETTING_DEFINITIONS.grantRules.fallback,
	heartbeatMilliseconds: 10000,
	issuer: 'https://access.example.org/usher',
	noticePageLimit: 500,
	noticeRereadMilliseconds: 2000,
	retentionGraceSeconds: 60,
	retentionMarginSeconds: 30,
	selfGrantMaximumLifetimeSeconds: 86400,
	signInTokenMaximumLifetimeSeconds: 300,
	stepUpLevel: 'confirmation',
	stepUpWindowSeconds: 300,
	streamLimitPerAudience: 64,
	streamMaximumLifetimeSeconds: 900,
	streamQueueLimit: 1000,
	submitterCategory: 'global.unmarked',
	tokenLifetimeSeconds: 300,
	...overrides,
});

const refusedRulesOf = (text: string): readonly string[] => {
	const reading = readSeedFile(text);
	assert.equal(reading.kind, 'refused', `refuses ${text}`);
	return reading.kind === 'refused' ? reading.rules : [];
};

suite('reading the seed file', () => {
	test('reads a file giving only issuer and eventSource, the other settings taking their defaults', () => {
		assert.deepEqual(readSeedFile(REQUIRED), { kind: 'read', settings: defaultsWith({}) });
	});

	test('reads the values the file gives over the defaults', () => {
		const text = JSON.stringify({
			eventSource: 'usher',
			firstUser: { subject: 'a1b2c3' },
			grantAutoAccept: true,
			heartbeatMilliseconds: 5000,
			issuer: 'https://access.example.org/usher',
			submitterCategory: 'global.controlled',
		});

		assert.deepEqual(readSeedFile(text), {
			kind: 'read',
			settings: defaultsWith({
				firstUser: { subject: 'a1b2c3' },
				grantAutoAccept: true,
				heartbeatMilliseconds: 5000,
				submitterCategory: 'global.controlled',
			}),
		});
	});

	test('reads a grant rate threshold the file gives, and refuses one breaking its rule', () => {
		const text = JSON.stringify({
			eventSource: 'usher',
			grantRateThreshold: { operationCount: 3, windowSeconds: 45 },
			issuer: 'https://access.example.org/usher',
		});

		assert.deepEqual(readSeedFile(text), {
			kind: 'read',
			settings: defaultsWith({ grantRateThreshold: { operationCount: 3, windowSeconds: 45 } }),
		});
		assert.equal(
			readSeedFile(
				JSON.stringify({
					eventSource: 'usher',
					grantRateThreshold: { operationCount: 0, windowSeconds: 45 },
					issuer: 'https://access.example.org/usher',
				}),
			).kind,
			'refused',
		);
	});

	test('reads a grant rules list the file gives as it is given', () => {
		const grantRules = [{ resources: [], to: 'signedIn' }];
		const text = JSON.stringify({ eventSource: 'usher', grantRules, issuer: 'https://access.example.org/usher' });

		assert.deepEqual(readSeedFile(text), { kind: 'read', settings: defaultsWith({ grantRules }) });
	});

	test('refuses text that is not JSON', () => {
		assert.match(refusedRulesOf('not json')[0] ?? '', /not JSON/u);
	});

	test('refuses JSON that is not one object of settings', () => {
		['[]', '"usher"', 'null', '7'].forEach((text) => assert.equal(refusedRulesOf(text).length > 0, true, text));
	});

	test('refuses an object naming a member twice', () => {
		assert.match(refusedRulesOf(`{"issuer":"a","issuer":"b","eventSource":"usher"}`).join(' '), /twice/u);
	});

	test('refuses a member named __proto__', () => {
		assert.match(refusedRulesOf(`${REQUIRED.slice(0, -1)},"__proto__":{}}`).join(' '), /__proto__/u);
	});

	test('refuses a member that no setting takes, without quoting it', () => {
		const rules = refusedRulesOf(`${REQUIRED.slice(0, -1)},"usherBaseline":"sekret-value"}`);

		assert.equal(rules.length, 1);
		assert.equal(rules.join(' ').includes('sekret-value'), false);
	});

	test('refuses a setting whose value breaks its rule, naming the setting and never the value', () => {
		const rules = refusedRulesOf(`${REQUIRED.slice(0, -1)},"heartbeatMilliseconds":"sekret-value"}`);

		assert.equal(rules.length, 1);
		assert.match(rules[0] ?? '', /^heartbeatMilliseconds /u);
		assert.equal(rules.join(' ').includes('sekret-value'), false);
	});

	test('refuses a file lacking issuer, and a file lacking eventSource', () => {
		assert.match(refusedRulesOf('{"eventSource":"usher"}').join(' '), /issuer/u);
		assert.match(refusedRulesOf('{"issuer":"https://access.example.org/usher"}').join(' '), /eventSource/u);
	});

	test('lists every rule the file breaks, rather than the first', () => {
		const rules = refusedRulesOf('{"heartbeatMilliseconds":"x","noticePageLimit":0}');

		assert.equal(rules.length, 4);
		assert.match(rules.join(' '), /heartbeatMilliseconds/u);
		assert.match(rules.join(' '), /noticePageLimit/u);
	});

	test('refuses a retention floor past the largest the column holds, on each of its three durations', () => {
		const rules = refusedRulesOf(
			`${REQUIRED.slice(0, -1)},"tokenLifetimeSeconds":2147483647,"retentionGraceSeconds":1}`,
		);

		['retentionGraceSeconds', 'retentionMarginSeconds', 'tokenLifetimeSeconds'].forEach((name) =>
			assert.match(rules.join(' '), new RegExp(name, 'u')),
		);
	});

	test('refuses a firstUser that names both a realm role and a subject', () => {
		assert.match(
			refusedRulesOf(`${REQUIRED.slice(0, -1)},"firstUser":{"realmRole":"a","subject":"b"}}`).join(' '),
			/firstUser/u,
		);
	});
});

suite('the seed file template', () => {
	test('is a seed file the reader reads whole, naming the issuer, event source and first user a first run needs', async () => {
		const text = await readFile(new URL('../../seed.template.json', import.meta.url), 'utf8');

		assert.equal(readSeedFile(text).kind, 'read');
	});
});

suite('the members a seed file holds', () => {
	test('reads the one JSON object the text holds, as written', () => {
		assert.deepEqual(readSeedMembers('{"issuer":"https://usher.example.org","eventSource":"x"}'), {
			kind: 'read',
			members: { eventSource: 'x', issuer: 'https://usher.example.org' },
		});
	});

	test('refuses text that is not one object, naming the rule it breaks and quoting none of the text', () => {
		assert.deepEqual(readSeedMembers('[{"issuer":"marker-value-43"}]'), {
			kind: 'refused',
			rule: 'is not one object of settings',
		});
		assert.deepEqual(readSeedMembers('{"issuer":'), { kind: 'refused', rule: 'is not JSON' });
		assert.deepEqual(readSeedMembers('{"issuer":"a","issuer":"b"}'), {
			kind: 'refused',
			rule: 'names a member twice in one object',
		});
	});
});
