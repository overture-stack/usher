import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { cursorAfterId, idOfCursor } from './idCursor.js';

const ID = '6b1f3c2e-8a4d-4f7b-9c1e-2d3a4b5c6d7e';

suite("a grant listing's or a grant request listing's cursor", () => {
	test('names again the id it was written after', () => {
		assert.equal(idOfCursor(cursorAfterId(ID)), ID);
	});

	test('names nothing for text no listing wrote, an id written plainly among it', () => {
		const cursors = [
			'',
			'not a cursor',
			ID,
			cursorAfterId('STUDY-A1'),
			`${cursorAfterId(ID)}=`,
			cursorAfterId(ID.toUpperCase()),
		];

		assert.deepEqual(
			cursors.map(idOfCursor),
			cursors.map(() => undefined),
		);
	});
});
