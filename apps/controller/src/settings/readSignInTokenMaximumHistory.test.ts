import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { readSignInTokenMaximumHistory, signInTokenMaximumHistoryStatement } from './readSignInTokenMaximumHistory.js';

const SETTING = 'signInTokenMaximumLifetimeSeconds';

suite('reading the history of the sign-in token maximum', () => {
	test('reads each recorded change, oldest first, with its instant and its maximum', () => {
		const reading = readSignInTokenMaximumHistory([
			{ recordedAt: 100, value: 300 },
			{ recordedAt: 1000, value: 600 },
		]);
		assert.deepEqual(reading, {
			history: [
				{ recordedAt: 100, seconds: 300 },
				{ recordedAt: 1000, seconds: 600 },
			],
			kind: 'read',
		});
	});

	test('refuses a history holding no change, naming the setting as missing', () => {
		assert.deepEqual(readSignInTokenMaximumHistory([]), {
			kind: 'refused',
			problems: [{ rule: 'is missing from the store', setting: SETTING }],
		});
	});

	test('refuses a recorded value that breaks its rule, naming the setting and never the value', () => {
		const reading = readSignInTokenMaximumHistory([{ recordedAt: 100, value: 0 }]);
		assert.deepEqual(reading, {
			kind: 'refused',
			problems: [{ rule: 'is not a whole number of at least 1', setting: SETTING }],
		});
		assert.equal(JSON.stringify(reading).includes('"0"'), false);
	});

	test('reads the changes of the one setting, in the schema given, ordered by their instant', () => {
		const statement = signInTokenMaximumHistoryStatement('usher');
		assert.match(statement, /FROM "usher"\.change_records/);
		assert.match(statement, /table_name = 'settings'/);
		assert.match(statement, /row_key = '\{"name": "signInTokenMaximumLifetimeSeconds"\}'::jsonb/);
		assert.match(statement, /ORDER BY recorded_at/);
	});
});
