import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { historyReaches } from './historyReaches.js';
import type { NoticePage, StreamPlace } from './types.js';

const EPOCH = '0d8e2c4a-6f1b-4c3d-9a7e-5b2f1e0c8d6a';

const OTHER_EPOCH = '7f3a9b1c-2d4e-4f6a-8b0c-1d2e3f4a5b6c';

const pageAfter = ({
	createdAtPosition,
	epoch = EPOCH,
	trimmedThrough = 10n,
}: {
	createdAtPosition?: bigint;
	epoch?: string;
	trimmedThrough?: bigint;
}): NoticePage => ({
	createdAtPosition,
	epoch,
	head: { createdAt: 99n, epoch, position: 50n },
	more: false,
	notices: [],
	trimmedThrough,
});

const place = (position: bigint, createdAt?: bigint): StreamPlace => ({
	createdAt,
	epoch: EPOCH,
	position,
});

suite("whether history reaches a cursor's place", () => {
	test('reaches a place above the watermark whose notice is stored as it was read', () => {
		assert.equal(historyReaches(place(20n, 1_000n), pageAfter({ createdAtPosition: 1_000n })), true);
	});

	test('reaches the watermark itself once its notice is trimmed, whether or not the place was read from a notice', () => {
		assert.equal(historyReaches(place(10n, 1_000n), pageAfter({})), true);
		assert.equal(historyReaches(place(10n), pageAfter({})), true);
	});

	test('reaches no place below the watermark, its notices lost to trimming', () => {
		assert.equal(historyReaches(place(9n, 1_000n), pageAfter({})), false);
		assert.equal(historyReaches(place(9n), pageAfter({})), false);
	});

	test('reaches no place of another epoch, whatever it holds', () => {
		assert.equal(
			historyReaches(place(20n, 1_000n), pageAfter({ createdAtPosition: 1_000n, epoch: OTHER_EPOCH })),
			false,
		);
	});

	test('reaches no place above the watermark where no notice is stored: one ahead of head, or lost to a restore', () => {
		assert.equal(historyReaches(place(60n, 1_000n), pageAfter({})), false);
		assert.equal(historyReaches(place(60n), pageAfter({})), false);
	});

	test('reaches no place whose position a restore gave to a notice created at another instant', () => {
		assert.equal(historyReaches(place(20n, 1_000n), pageAfter({ createdAtPosition: 2_000n })), false);
		assert.equal(historyReaches(place(20n), pageAfter({ createdAtPosition: 2_000n })), false);
	});
});
