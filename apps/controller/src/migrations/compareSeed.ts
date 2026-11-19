import { createHash } from 'node:crypto';

import pg from 'pg';

import { canonicalJson } from '../settings/index.js';
import type { SeedFileOutcome } from './types.js';

/**
 * Compares the members a later run's seed file holds with the ones the first run stored, changing nothing. When
 * their canonical forms have the same SHA-256 digest, the file is unchanged. Otherwise each top-level key is
 * named by the part it differs in: added when only the file holds it, removed when only the stored members hold
 * it, and changed when both hold it with different values. No value is returned. A store holding no row
 * compares as holding no members.
 *
 * @param client a connection under the schema migration role, which holds the run's lock.
 * @param schema the schema the seed row lives in.
 * @param members the members the file holds, as {@link readSeedMembers} reads them.
 * @returns whether the file is unchanged, or each key that differs, each list sorted.
 */
export const compareSeed = async (
	client: pg.ClientBase,
	schema: string,
	members: Readonly<Record<string, unknown>>,
): Promise<SeedFileOutcome> => {
	const { rows } = await client.query<{
		content: Readonly<Record<string, unknown>>;
		digest: Buffer;
	}>(`SELECT content, digest FROM ${pg.escapeIdentifier(schema)}.settings_seed`);
	const [stored] = rows;
	if (stored !== undefined && stored.digest.equals(createHash('sha256').update(canonicalJson(members)).digest())) {
		return { kind: 'unchanged' };
	}
	const held = stored?.content ?? {};
	return {
		added: Object.keys(members)
			.filter((key) => !Object.hasOwn(held, key))
			.sort(),
		changed: Object.keys(members)
			.filter((key) => Object.hasOwn(held, key) && canonicalJson(members[key]) !== canonicalJson(held[key]))
			.sort(),
		kind: 'changed',
		removed: Object.keys(held)
			.filter((key) => !Object.hasOwn(members, key))
			.sort(),
	};
};
