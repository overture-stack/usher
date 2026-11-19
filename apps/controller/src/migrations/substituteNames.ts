import pg from 'pg';

import type { MigrationNames } from './types.js';

// The placeholders take psql's form for a variable quoted as an identifier.
const RUNTIME_ROLE_PLACEHOLDER = ':"runtime_role"';

const SCHEMA_PLACEHOLDER = ':"schema"';

/**
 * A migration's statements with the schema and the runtime role in place of their placeholders,
 * `:"schema"` and `:"runtime_role"`, each quoted as an identifier. Identifiers cannot travel as bound
 * parameters, so quoting is what keeps a name from being read as SQL.
 *
 * @param sql the migration's statements.
 * @param names the schema and the runtime role.
 */
export const substituteNames = (sql: string, { runtimeRole, schema }: MigrationNames): string => {
	const quotedRole = pg.escapeIdentifier(runtimeRole);
	const quotedSchema = pg.escapeIdentifier(schema);
	// A replacer function, since a replacement string would read `$&` and its kin in a name as patterns.
	return sql
		.replaceAll(RUNTIME_ROLE_PLACEHOLDER, () => quotedRole)
		.replaceAll(SCHEMA_PLACEHOLDER, () => quotedSchema);
};
