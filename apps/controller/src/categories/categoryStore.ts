import pg from 'pg';

import { countedOwnerCondition } from '../resourceStanding/index.js';
import type { StoreReader } from '../managementApi/index.js';
import { letterCaseKey } from '../store/index.js';
import type { CategoryRegistration, CategoryStore, CategoryView, Insertion, StoredCategory } from './types.js';

const tableIn =
	(schema: string) =>
	(name: string): string =>
		`${pg.escapeIdentifier(schema)}.${name}`;

/**
 * Creates the SQL store of the global categories, over one transaction's connection. A name is compared in any
 * letter case, as the unique index on it compares it. A registration is written with `ON CONFLICT` on that
 * index, so the store itself refuses a second row of the same name in any letter case, even one a concurrent
 * registration is still writing.
 *
 * @param connection the transaction's connection.
 * @param schema the Controller's schema.
 */
export const sqlCategoryStore = (connection: pg.ClientBase, schema: string): CategoryStore => {
	const table = tableIn(schema)('categories');
	const findGlobal = async (name: string): Promise<StoredCategory | undefined> => {
		const { rows } = await connection.query<StoredCategory>(
			`SELECT id, name, description FROM ${table}
             WHERE scope = 'global' AND resource_id IS NULL AND ${letterCaseKey('name')} = ${letterCaseKey('$1::text')}
             FOR UPDATE`,
			[name],
		);
		return rows[0];
	};
	return {
		findGlobal,
		insertGlobal: async ({ description, name }: CategoryRegistration): Promise<Insertion> => {
			const { rows } = await connection.query<{ id: string }>(
				`INSERT INTO ${table} (scope, name, description) VALUES ('global', $1, $2)
                 ON CONFLICT (scope, resource_id, ${letterCaseKey('name')}) DO NOTHING
                 RETURNING id`,
				[name, description],
			);
			const inserted = rows[0];
			if (inserted !== undefined) {
				return { id: inserted.id, kind: 'inserted' };
			}
			const existing = await findGlobal(name);
			return { existing: existing?.name ?? name, kind: 'taken' };
		},
		setDescription: async (id, description) => {
			await connection.query(`UPDATE ${table} SET description = $2 WHERE id = $1`, [id, description]);
		},
	};
};

/**
 * Reads every global category, ordered by name in byte order, each with its scoped name. A resource's own
 * categories are never among them.
 *
 * @param store the store reader.
 * @param schema the Controller's schema.
 */
export const listGlobalCategories = async (store: StoreReader, schema: string): Promise<readonly CategoryView[]> => {
	const { rows } = await store.query<{ description: string | null; name: string }>(
		`SELECT name, description FROM ${tableIn(schema)('categories')}
         WHERE scope = 'global'
         ORDER BY name COLLATE "C"`,
	);
	return rows.map(({ description, name }) => ({ description, name: `global.${name}` }));
};

/**
 * Whether the person holding a subject under the trusted issuer is a counted owner of at least one resource: holds
 * a live grant of the owner role, which their latest answer accepted.
 *
 * @param store the store reader.
 * @param schema the Controller's schema.
 * @param identity the trusted issuer and the principal's subject.
 * @param now the instant the grant must still be live at.
 */
export const isCountedOwner = async (
	store: StoreReader,
	schema: string,
	{ issuer, subject }: { issuer: string; subject: string },
	now: Date,
): Promise<boolean> => {
	const { rows } = await store.query<{ owns: boolean }>(
		`SELECT EXISTS (
           SELECT 1 FROM ${tableIn(schema)('grants')} owned
           WHERE owned.holder_user_id = (
                   SELECT identity.user_id FROM ${tableIn(schema)('user_identities')} identity
                   WHERE identity.idp_issuer = $1 AND identity.idp_subject_id = $2
                   ORDER BY identity.added_at, identity.id LIMIT 1)
             AND ${countedOwnerCondition(schema, 'owned', '$3::timestamptz')}) AS "owns"`,
		[issuer, subject, now],
	);
	return rows[0]?.owns === true;
};
