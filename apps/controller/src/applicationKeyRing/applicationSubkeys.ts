import { createSecretKey, hkdfSync, type KeyObject } from 'node:crypto';

import type { ApplicationSubkeys } from './types.js';

/** The HKDF label of each subkey derived from an application key, as the Bridge labels them. */
export const SUBKEY_LABELS: Readonly<Record<keyof ApplicationSubkeys, string>> = Object.freeze({
	channelAssertion: 'usher/v1/channel-assertion',
	notice: 'usher/v1/notice-encryption',
	pollAnswer: 'usher/v1/poll-answer',
	subjectTag: 'usher/v1/subject-tag',
	token: 'usher/v1/token-encryption',
});

const NO_SALT = Buffer.alloc(0);

const SUBKEY_BYTES = 32;

/**
 * Derives the subkeys of an application key: for each label in {@link SUBKEY_LABELS}, 32 bytes of
 * HKDF-SHA256 over the key with an empty salt and the label as info. Each derived byte is zero-filled
 * once held as a key object. The application key is only ever this HKDF input: it encrypts and
 * signs nothing itself, Usher tokens included, so no key serves two uses.
 *
 * @param key the application key's bytes.
 */
export const applicationSubkeys = (key: Uint8Array): ApplicationSubkeys => {
	const derived = (label: string): KeyObject => {
		const bytes = Buffer.from(hkdfSync('sha256', key, NO_SALT, label, SUBKEY_BYTES));
		const subkey = createSecretKey(bytes);
		bytes.fill(0);
		return subkey;
	};
	return {
		channelAssertion: derived(SUBKEY_LABELS.channelAssertion),
		notice: derived(SUBKEY_LABELS.notice),
		pollAnswer: derived(SUBKEY_LABELS.pollAnswer),
		subjectTag: derived(SUBKEY_LABELS.subjectTag),
		token: derived(SUBKEY_LABELS.token),
	};
};
