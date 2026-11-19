import { hkdfSync } from 'node:crypto';

// The fingerprint's HKDF label, setting its subkey apart from every other use of the key. A store
// keeps the fingerprint derived at its first start, so every release must derive it under this label.
const FINGERPRINT_LABEL = 'usher/v1/key-encryption-key-fingerprint';

const FINGERPRINT_LENGTH = 32;

const NO_SALT = Buffer.alloc(0);

/**
 * The key-encryption key's fingerprint, the key's one-way identifier, kept by the store to check the
 * key at each start: an HKDF-SHA256 subkey of the key under a label of its own, so it shows nothing
 * of the key, and no other key derived from the key-encryption key can be read from it. The decoded
 * key's bytes are zero-filled once it is derived.
 *
 * @param key the key-encryption key: 43 base64url characters in canonical form.
 */
export const keyFingerprint = (key: string): Buffer => {
	const bytes = Buffer.from(key, 'base64url');
	try {
		return Buffer.from(hkdfSync('sha256', bytes, NO_SALT, FINGERPRINT_LABEL, FINGERPRINT_LENGTH));
	} finally {
		bytes.fill(0);
	}
};
