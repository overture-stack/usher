import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

import type { CursorCipher, StreamPlace } from '../noticeChannel/index.js';

// The HKDF label each cursor's own key is derived under, apart from every other use of a key.
const CURSOR_LABEL = 'usher/v1/cursor';

// The first byte of every sealed place, naming this form, so a later form can be told from it.
const FORM = 1;

const SALT_BYTES = 16;

const TAG_BYTES = 16;

const EPOCH_BYTES = 16;

// The form, the epoch, the position and the creation instant.
const PLACE_BYTES = 1 + EPOCH_BYTES + 8 + 8;

const CURSOR_BYTES = SALT_BYTES + PLACE_BYTES + TAG_BYTES;

// Each key encrypts one cursor alone, so one nonce serves them all.
const NONCE = Buffer.alloc(12);

// The creation instant a place no notice holds carries in its place.
const NO_INSTANT = -1n;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const epochText = (bytes: Buffer): string => {
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
};

const placeBytes = ({ createdAt, epoch, position }: StreamPlace): Buffer => {
  if (!UUID.test(epoch)) {
    throw new RangeError('an epoch is a uuid in lower case');
  }
  const bytes = Buffer.alloc(PLACE_BYTES);
  bytes.writeUInt8(FORM, 0);
  Buffer.from(epoch.replaceAll('-', ''), 'hex').copy(bytes, 1);
  bytes.writeBigInt64BE(position, 1 + EPOCH_BYTES);
  bytes.writeBigInt64BE(createdAt ?? NO_INSTANT, 1 + EPOCH_BYTES + 8);
  return bytes;
};

const placeOf = (bytes: Buffer): StreamPlace | undefined => {
  if (bytes.length !== PLACE_BYTES || bytes.readUInt8(0) !== FORM) {
    return undefined;
  }
  const createdAt = bytes.readBigInt64BE(1 + EPOCH_BYTES + 8);
  return {
    createdAt: createdAt === NO_INSTANT ? undefined : createdAt,
    epoch: epochText(bytes.subarray(1, 1 + EPOCH_BYTES)),
    position: bytes.readBigInt64BE(1 + EPOCH_BYTES),
  };
};

/**
 * Creates the cipher cursors are sealed under. A cursor is a fresh 128-bit salt, then the place
 * encrypted with AES-256-GCM under a key derived from the cursor key by HKDF-SHA256 with that salt,
 * then the tag, all base64url without padding: so every cursor differs, even two for one place, and
 * none shows its position, while a key used once lifts the bound a random nonce would put on how
 * many cursors one cursor key may seal. Every cursor is 87 characters long. The decoded cursor key's
 * bytes are kept for the derivations and never leave the cipher.
 *
 * @param cursorKey the cursor key: 43 base64url characters in canonical form.
 */
export const createCursorCipher = (cursorKey: string): CursorCipher => {
  const keyBytes = Buffer.from(cursorKey, 'base64url');
  const keyFor = (salt: Uint8Array): Buffer =>
    Buffer.from(hkdfSync('sha256', keyBytes, salt, CURSOR_LABEL, 32));

  return {
    open: (cursor) => {
      const sealed = Buffer.from(cursor, 'base64url');
      // Anything decoding to the right length but written otherwise is no cursor of the controller's.
      if (
        sealed.length !== CURSOR_BYTES ||
        sealed.toString('base64url') !== cursor
      ) {
        return undefined;
      }
      const key = keyFor(sealed.subarray(0, SALT_BYTES));
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, NONCE, {
          authTagLength: TAG_BYTES,
        }).setAuthTag(sealed.subarray(-TAG_BYTES));
        return placeOf(
          Buffer.concat([
            decipher.update(sealed.subarray(SALT_BYTES, -TAG_BYTES)),
            decipher.final(),
          ]),
        );
      } catch {
        return undefined;
      } finally {
        key.fill(0);
      }
    },

    seal: (place) => {
      const salt = randomBytes(SALT_BYTES);
      const key = keyFor(salt);
      try {
        const cipher = createCipheriv('aes-256-gcm', key, NONCE, {
          authTagLength: TAG_BYTES,
        });
        return Buffer.concat([
          salt,
          cipher.update(placeBytes(place)),
          cipher.final(),
          cipher.getAuthTag(),
        ]).toString('base64url');
      } finally {
        key.fill(0);
      }
    },
  };
};
