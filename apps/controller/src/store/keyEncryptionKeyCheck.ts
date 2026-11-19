import { timingSafeEqual } from 'node:crypto';

import pg from 'pg';

import { ENVIRONMENT_VARIABLES } from '../configuration/index.js';
import { StartRefusal } from '../failures/index.js';
import { keyFingerprint } from './keyFingerprint.js';
import type { StoreSettings } from './types.js';
import { writeOrRefuse } from './writeOrRefuse.js';

const KEY_NAME = 'keyEncryptionKey';

const UNDEFINED_TABLE = '42P01';

const codeOf = (error: unknown): string | undefined =>
  error instanceof pg.DatabaseError ? error.code : undefined;

const matches = (recorded: Buffer, expected: Buffer): boolean =>
  recorded.length === expected.length && timingSafeEqual(recorded, expected);

const refusal = (variable: string, rule: string): StartRefusal =>
  new StartRefusal([{ rule, variable }]);

const recordedFingerprint = async (
  client: pg.ClientBase,
  table: string,
): Promise<Buffer | undefined> => {
  try {
    const { rows } = await client.query<{ fingerprint: Buffer }>(
      `SELECT fingerprint FROM ${table} WHERE key_name = $1`,
      [KEY_NAME],
    );
    return rows[0]?.fingerprint;
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

const recordFingerprint = async (
  client: pg.ClientBase,
  table: string,
  fingerprint: Buffer,
  recordedAt: Date,
): Promise<void> => {
  await writeOrRefuse(
    {
      rule: 'has no fingerprint recorded in the store, and the database role may not record one',
      variable: ENVIRONMENT_VARIABLES.keyEncryptionKey,
    },
    () =>
      client.query(
        `INSERT INTO ${table} (key_name, fingerprint, recorded_at) VALUES ($1, $2, $3)`,
        [KEY_NAME, fingerprint, recordedAt],
      ),
  );
};

/**
 * Checks the key-encryption key against its fingerprint, the key's one-way identifier, recorded under
 * the key's name at the store's first start, or records the key's fingerprint when the store holds
 * none. The store holds one fingerprint under that name, so of two first starts under different keys,
 * the one checking second is refused: run the check while holding the lock taken by every start.
 *
 * @param client a connection under the Controller's role, in the start's transaction.
 * @param settings the key, the schema, and the clock giving the fingerprint's recording time.
 * @throws {StartRefusal} naming the key's variable when the key does not match the recorded
 *   fingerprint, or when no fingerprint is recorded and the role may not record one; naming the
 *   schema's variable when the schema holds no migrated store.
 */
export const checkKeyEncryptionKey = async (
  client: pg.ClientBase,
	{ clock, databaseSchema, keyEncryptionKey }: Pick<StoreSettings, 'clock' | 'databaseSchema' | 'keyEncryptionKey'>,
): Promise<void> => {
  const table = `${pg.escapeIdentifier(databaseSchema)}.key_fingerprints`;
  const fingerprint = keyFingerprint(keyEncryptionKey);
  const recorded = await recordedFingerprint(client, table);
  if (recorded === undefined) {
    await recordFingerprint(client, table, fingerprint, new Date(clock.now()));
    return;
  }
  if (matches(recorded, fingerprint)) {
    return;
  }
  throw refusal(
    ENVIRONMENT_VARIABLES.keyEncryptionKey,
    "does not match the fingerprint recorded at the store's first start",
  );
};
