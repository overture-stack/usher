import { hkdfSync, timingSafeEqual } from 'node:crypto';

import pg from 'pg';

import { ENVIRONMENT_VARIABLES } from '../configuration/index.js';
import { StartRefusal } from '../failures/index.js';
import type { StoreSettings } from './types.js';

// The HKDF label of the subkey the check value is, apart from every other use of the key.
const CHECK_LABEL = 'usher/v1/key-encryption-key-check';

const CHECK_LENGTH = 32;

const NO_SALT = Buffer.alloc(0);

const INSUFFICIENT_PRIVILEGE = '42501';

const UNDEFINED_TABLE = '42P01';

const codeOf = (error: unknown): string | undefined =>
  error instanceof pg.DatabaseError ? error.code : undefined;

/**
 * The value the store keeps to check the key-encryption key at each start: an HKDF-SHA256 subkey of
 * the key under a label of its own, so it shows nothing of the key, and no other key derived from the
 * key-encryption key can be read from it. The decoded key's bytes are zero-filled once it is derived.
 *
 * @param key the key-encryption key: 43 base64url characters in canonical form.
 */
export const keyEncryptionKeyCheckValue = (key: string): Buffer => {
  const bytes = Buffer.from(key, 'base64url');
  try {
    return Buffer.from(
      hkdfSync('sha256', bytes, NO_SALT, CHECK_LABEL, CHECK_LENGTH),
    );
  } finally {
    bytes.fill(0);
  }
};

const matches = (recorded: Buffer, expected: Buffer): boolean =>
  recorded.length === expected.length && timingSafeEqual(recorded, expected);

const refusal = (variable: string, rule: string): StartRefusal =>
  new StartRefusal([{ rule, variable }]);

const recordedCheckValue = async (
  client: pg.ClientBase,
  table: string,
): Promise<Buffer | undefined> => {
  try {
    const { rows } = await client.query<{ check_value: Buffer }>(
      `SELECT check_value FROM ${table}`,
    );
    return rows[0]?.check_value;
  } catch (error) {
    if (codeOf(error) === UNDEFINED_TABLE) {
      throw refusal(
        ENVIRONMENT_VARIABLES.databaseSchema,
        'names a schema holding no migrated store',
      );
    }
    throw error;
  }
};

const recordCheckValue = async (
  client: pg.ClientBase,
  table: string,
  checkValue: Buffer,
  recordedAt: Date,
): Promise<void> => {
  try {
    await client.query(
      `INSERT INTO ${table} (check_value, recorded_at) VALUES ($1, $2)`,
      [checkValue, recordedAt],
    );
  } catch (error) {
    if (codeOf(error) === INSUFFICIENT_PRIVILEGE) {
      throw refusal(
        ENVIRONMENT_VARIABLES.keyEncryptionKey,
        'has no check value recorded in the store, and the database role may not record one',
      );
    }
    throw error;
  }
};

/**
 * Checks the key-encryption key against the check value the store's first start recorded, or records
 * it when the store holds none. The store holds one check value, so of two first starts under
 * different keys, the one checking second is refused: run the check while holding the lock every
 * start takes.
 *
 * @param client a connection under the controller's role, in the start's transaction.
 * @param settings the key, the schema, and the clock the check value's recording time is read from.
 * @throws {StartRefusal} naming the key's variable when the key is not the recorded one, or when no
 *   check value is recorded and the role may not record one; naming the schema's variable when the
 *   schema holds no migrated store.
 */
export const checkKeyEncryptionKey = async (
  client: pg.ClientBase,
  { clock, databaseSchema, keyEncryptionKey }: StoreSettings,
): Promise<void> => {
  const table = `${pg.escapeIdentifier(databaseSchema)}.key_encryption_key_check`;
  const checkValue = keyEncryptionKeyCheckValue(keyEncryptionKey);
  const recorded = await recordedCheckValue(client, table);
  if (recorded === undefined) {
    await recordCheckValue(client, table, checkValue, new Date(clock.now()));
    return;
  }
  if (matches(recorded, checkValue)) {
    return;
  }
  throw refusal(
    ENVIRONMENT_VARIABLES.keyEncryptionKey,
    "is not the key-encryption key the store's first start recorded a check value for",
  );
};
