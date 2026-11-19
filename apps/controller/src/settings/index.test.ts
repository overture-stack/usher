import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as settings from './index.js';

suite('the settings module', () => {
	test('exports at run time exactly the values its surface names', () => {
		assert.deepEqual(Object.keys(settings).toSorted(), [
			'LARGEST_RETENTION_FLOOR_SECONDS',
			'SETTING_DEFINITIONS',
			'canonicalJson',
			'createSettingsRoutes',
			'createSettingsSource',
			'liveSettingsOf',
			'readHeldSettings',
			'readSeedFile',
			'readSeedMembers',
			'readSignInTokenMaximumHistory',
			'readStoredSettings',
			'signInTokenMaximumHistoryStatement',
			'signInTokenMaximumOf',
		]);
	});
});
