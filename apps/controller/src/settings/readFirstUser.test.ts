import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { readFirstUser } from './readFirstUser.js';

suite('reading the first user', () => {
	test('reads a realm role alone', () => {
		assert.deepEqual(readFirstUser({ realmRole: 'usher-first-user' }), {
			kind: 'read',
			value: { realmRole: 'usher-first-user' },
		});
	});

	test('reads a subject alone', () => {
		assert.deepEqual(readFirstUser({ subject: 'a1b2c3' }), { kind: 'read', value: { subject: 'a1b2c3' } });
	});

	test('refuses both a realm role and a subject', () => {
		const reading = readFirstUser({ realmRole: 'usher-first-user', subject: 'a1b2c3' });

		assert.equal(reading.kind, 'refused');
		assert.match(reading.kind === 'refused' ? reading.rule : '', /both/u);
	});

	test('refuses neither a realm role nor a subject', () => {
		const reading = readFirstUser({});

		assert.equal(reading.kind, 'refused');
		assert.match(reading.kind === 'refused' ? reading.rule : '', /neither/u);
	});

	test('refuses a member other than realmRole or subject', () => {
		const reading = readFirstUser({ realmRole: 'usher-first-user', group: 'staff' });

		assert.equal(reading.kind, 'refused');
	});

	test('refuses an empty realm role or subject', () => {
		assert.equal(readFirstUser({ realmRole: '' }).kind, 'refused');
		assert.equal(readFirstUser({ subject: '' }).kind, 'refused');
	});

	test('refuses a realm role or subject that is not text', () => {
		assert.equal(readFirstUser({ realmRole: 4 }).kind, 'refused');
		assert.equal(readFirstUser({ subject: ['a'] }).kind, 'refused');
	});

	test('refuses a value that is not an object', () => {
		['usher-first-user', ['usher-first-user'], null, 3].forEach((value) =>
			assert.equal(readFirstUser(value).kind, 'refused'),
		);
	});

	test('never quotes the value it refuses', () => {
		const reading = readFirstUser({ realmRole: '', extra: 'sekret-value' });

		assert.equal(JSON.stringify(reading).includes('sekret-value'), false);
	});
});
