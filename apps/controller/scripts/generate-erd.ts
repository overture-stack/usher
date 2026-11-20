// Writes Mermaid entity-relationship diagrams of the Controller's schema to standard output, one per
// area in erd/areas.ts. It runs every migration on a PostgreSQL of its own in Docker, reads the
// tables, columns and keys from the migrated database's catalogue, then removes that PostgreSQL, so
// the diagrams show the schema the migrations make rather than one described by hand. It needs
// Docker, as the Controller's tests do. Run it from apps/controller:
//
//     pnpm exec tsx --conditions=@overture-stack/source scripts/generate-erd.ts > schema-diagrams.md
import type pg from 'pg';

import { startDedicatedPostgresql } from '../testing/harness/containers.js';
import { createTestDatabase, USHER_SCHEMA, USHER_TEMPLATE } from '../testing/harness/database.js';
import { SCHEMA_AREAS } from './erd/areas.js';
import { type CatalogueTable, renderAreas } from './erd/diagram.js';

interface ColumnRow {
	name: string;
	notNull: boolean;
	table: string;
	type: string;
}

interface ConstraintRow {
	columns: string[];
	kind: 'f' | 'p';
	name: string;
	referencedColumns: string[] | null;
	referencedTable: string | null;
	table: string;
}

interface UniqueRow {
	columns: string[];
	table: string;
}

const COLUMNS_QUERY = `
  SELECT c.relname::text AS "table", a.attname::text AS name,
         format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS "notNull"
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
   ORDER BY c.relname, a.attnum`;

// Each key's columns in the key's own order, which a composite foreign key pairs with the
// referenced columns by position.
const CONSTRAINTS_QUERY = `
  SELECT con.contype::text AS kind, con.conname::text AS name, c.relname::text AS "table",
         ref.relname::text AS "referencedTable",
         ARRAY(SELECT a.attname::text
                 FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, position)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                ORDER BY k.position) AS columns,
         CASE WHEN con.contype = 'f' THEN
           ARRAY(SELECT a.attname::text
                   FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, position)
                   JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
                  ORDER BY k.position)
         END AS "referencedColumns"
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_class ref ON ref.oid = con.confrelid
   WHERE n.nspname = $1 AND con.contype IN ('f', 'p')
   ORDER BY c.relname, con.conname`;

// A unique index restricted by a WHERE clause, or over an expression, says nothing about a foreign
// key's columns across every row, so only whole-table indexes on plain columns count.
const UNIQUE_QUERY = `
  SELECT c.relname::text AS "table",
         ARRAY(SELECT a.attname::text
                 FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, position)
                 JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                ORDER BY k.position) AS columns
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1 AND i.indisunique AND i.indpred IS NULL
     AND NOT (0 = ANY (i.indkey::int2[]))`;

const readCatalogue = async (client: pg.ClientBase, schema: string): Promise<CatalogueTable[]> => {
	const columns = await client.query<ColumnRow>(COLUMNS_QUERY, [schema]);
	const constraints = await client.query<ConstraintRow>(CONSTRAINTS_QUERY, [schema]);
	const uniques = await client.query<UniqueRow>(UNIQUE_QUERY, [schema]);
	const names = [...new Set(columns.rows.map((row) => row.table))];
	return names.map((name) => {
		const own = constraints.rows.filter((row) => row.table === name);
		return {
			columns: columns.rows
				.filter((row) => row.table === name)
				.map((row) => ({
					name: row.name,
					notNull: row.notNull,
					type: row.type,
				})),
			foreignKeys: own
				.filter((row) => row.kind === 'f')
				.map((row) => ({
					columns: row.columns,
					name: row.name,
					referencedColumns: row.referencedColumns ?? [],
					referencedTable: row.referencedTable ?? '',
				})),
			name,
			primaryKey: own.find((row) => row.kind === 'p')?.columns ?? [],
			uniqueColumnSets: uniques.rows.filter((row) => row.table === name).map((row) => row.columns),
		};
	});
};

const postgresql = await startDedicatedPostgresql();
try {
	const database = await createTestDatabase(USHER_TEMPLATE, {
		superuserUrl: postgresql.container.url,
	});
	try {
		const client = await database.connect('migration');
		const tables = await readCatalogue(client, USHER_SCHEMA);
		process.stdout.write(renderAreas(tables, SCHEMA_AREAS));
	} finally {
		await database.close();
	}
} catch (failure) {
	process.stderr.write(`${failure instanceof Error ? failure.message : String(failure)}\n`);
	process.exitCode = 1;
} finally {
	await postgresql.remove();
}
