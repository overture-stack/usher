import { createCipheriv, createDecipheriv, createSecretKey, hkdfSync, randomBytes } from 'node:crypto';

import type { ApplicationKeyCipher, ApplicationKeyIdentity } from './types.js';

// The HKDF label of the subkey stored keys are encrypted under, apart from every other use of the
// key-encryption key, its fingerprint's among them.
const SEAL_LABEL = 'usher/v1/application-key-seal';

// The first byte of every sealed key, naming this form, so a later form can be told from it.
const FORM = 1;

const NONCE_BYTES = 12;

const TAG_BYTES = 16;

/** An application key's length, in bytes: 32, which 43 base64url characters hold. */
export const APPLICATION_KEY_BYTES = 32;

const SEALED_BYTES = 1 + NONCE_BYTES + APPLICATION_KEY_BYTES + TAG_BYTES;

const NO_SALT = Buffer.alloc(0);

// What the encryption authenticates beside the key: the application's id and the key's own, so a
// sealed key copied onto another row fails to open rather than letting one application pass as
// another.
const boundTo = ({ applicationId, keyId }: ApplicationKeyIdentity): Buffer =>
	Buffer.from(`${SEAL_LABEL}\n${applicationId}\n${keyId}`, 'utf8');

/**
 * Creates the cipher stored application keys are sealed under: AES-256-GCM, under an HKDF-SHA256
 * subkey of the key-encryption key with a label of its own, a fresh 96-bit nonce per key, and the
 * application's id and the key's own authenticated beside it. A sealed key is one byte naming its
 * form, the nonce, the encrypted key and the tag. The decoded key-encryption key's bytes are
 * zero-filled once the subkey is derived.
 *
 * @param keyEncryptionKey the key-encryption key: 43 base64url characters in canonical form.
 */
export const createApplicationKeyCipher = (keyEncryptionKey: string): ApplicationKeyCipher => {
	const bytes = Buffer.from(keyEncryptionKey, 'base64url');
	const derived = Buffer.from(hkdfSync('sha256', bytes, NO_SALT, SEAL_LABEL, 32));
	const subkey = createSecretKey(derived);
	bytes.fill(0);
	derived.fill(0);
	return {
		open: (identity, sealed) => {
			if (sealed.length !== SEALED_BYTES || sealed[0] !== FORM) {
				return undefined;
			}
			const nonce = sealed.subarray(1, 1 + NONCE_BYTES);
			const encrypted = sealed.subarray(1 + NONCE_BYTES, -TAG_BYTES);
			try {
				const decipher = createDecipheriv('aes-256-gcm', subkey, nonce, {
					authTagLength: TAG_BYTES,
				})
					.setAAD(boundTo(identity))
					.setAuthTag(sealed.subarray(-TAG_BYTES));
				return Buffer.concat([decipher.update(encrypted), decipher.final()]);
			} catch {
				return undefined;
			}
		},
		seal: (identity, key) => {
			if (key.length !== APPLICATION_KEY_BYTES) {
				throw new RangeError(`an application key is ${APPLICATION_KEY_BYTES} bytes`);
			}
			const nonce = randomBytes(NONCE_BYTES);
			const cipher = createCipheriv('aes-256-gcm', subkey, nonce, {
				authTagLength: TAG_BYTES,
			}).setAAD(boundTo(identity));
			const encrypted = Buffer.concat([cipher.update(key), cipher.final()]);
			return Buffer.concat([Buffer.of(FORM), nonce, encrypted, cipher.getAuthTag()]);
		},
	};
};
