import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import type { StreamPlace } from '../noticeChannel/index.js';
import { createCursorCipher } from './createCursorCipher.js';

const freshKey = (): string => randomBytes(32).toString('base64url');

const PLACE: StreamPlace = Object.freeze({
	createdAt: 1_762_300_000_123_456n,
	epoch: randomUUID(),
	position: 4_200n,
});

// What travels unchanged as a query value, an SSE id and an HTTP header.
const TRAVELLING = /^[A-Za-z0-9_-]+$/u;

suite('the cursor cipher', () => {
	test('opens a cursor to the place it sealed, a place no notice holds included', () => {
		const cipher = createCursorCipher(freshKey());
		const watermark: StreamPlace = {
			createdAt: undefined,
			epoch: randomUUID(),
			position: 0n,
		};

		assert.deepEqual(cipher.open(cipher.seal(PLACE)), PLACE);
		assert.deepEqual(cipher.open(cipher.seal(watermark)), watermark);
	});

	test('seals one place to a new cursor each time, every cursor of one length and travelling unchanged', () => {
		const cipher = createCursorCipher(freshKey());
		const places: readonly StreamPlace[] = [
			PLACE,
			PLACE,
			{ createdAt: undefined, epoch: PLACE.epoch, position: 1n },
			{ ...PLACE, position: 9_007_199_254_740_993n },
		];

		const cursors = places.map((place) => cipher.seal(place));

		assert.equal(new Set(cursors).size, cursors.length);
		cursors.forEach((cursor) => {
			assert.equal(cursor.length, 87);
			assert.match(cursor, TRAVELLING);
		});
		assert.deepEqual(cipher.open(cursors[3] ?? ''), places[3]);
	});

	test('opens no cursor altered, cut short, lengthened, invented or sealed under another key', () => {
		const cipher = createCursorCipher(freshKey());
		const issued = cipher.seal(PLACE);
		const middle = Math.floor(issued.length / 2);
		const altered = `${issued.slice(0, middle)}${issued[middle] === 'A' ? 'B' : 'A'}${issued.slice(middle + 1)}`;
		const cursors = [
			altered,
			issued.slice(0, -4),
			`${issued}AAAA`,
			'invented-cursor-0001',
			'head',
			'',
			createCursorCipher(freshKey()).seal(PLACE),
			`${issued.slice(0, -1)}=`,
		];

		cursors.forEach((cursor) => {
			assert.equal(cipher.open(cursor), undefined, cursor);
		});
	});

	test('opens on every instance holding the cursor key the cursors any of them sealed', () => {
		const key = freshKey();
		const sealing = createCursorCipher(key);
		const opening = createCursorCipher(key);

		assert.deepEqual(opening.open(sealing.seal(PLACE)), PLACE);
	});

	test('refuses to seal a place whose epoch is no uuid', () => {
		const cipher = createCursorCipher(freshKey());

		assert.throws(() => cipher.seal({ ...PLACE, epoch: 'not-an-epoch' }), {
			name: 'RangeError',
		});
	});
});
