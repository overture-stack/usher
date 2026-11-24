import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { AdministratorStatusWithdrawn, type StoreReader, withAdministratorAuthority } from '../managementApi/index.js';
import { ADMINISTRATORS_LOCK } from './administratorStore.js';
import { confirmAdministratorAuthority } from './confirmAdministratorAuthority.js';

const IDENTITY = { issuer: 'https://auth.example.org/realms/usher', subject: 'subject-ana' };

const SCHEMA = 'usher';

interface Query {
	text: string;
	values: readonly unknown[] | undefined;
}

// A connection that answers the status reading with whether the identity is an administrator, and
// records every statement it is sent.
const connectionAnswering = (administrator: boolean): { connection: StoreReader; queries: Query[] } => {
	const queries: Query[] = [];
	const connection = {
		query: async (text: string, values?: readonly unknown[]) => {
			queries.push({ text, values });
			const rows = text.includes('AS administrator') ? [{ administrator, anyAdministrator: true }] : [];
			return { command: 'SELECT', fields: [], oid: 0, rowCount: rows.length, rows };
		},
	} as unknown as StoreReader;
	return { connection, queries };
};

suite('the administrator authority a change confirms within its transaction', () => {
	test('sends no statement for a change begun outside any request, which has no identity to confirm', async () => {
		const { connection, queries } = connectionAnswering(false);

		await confirmAdministratorAuthority({ schema: SCHEMA })(connection, { exclusive: false });

		assert.deepEqual(queries, []);
	});

	test('takes the administrators lock shared for a change that leaves who is an administrator as it is', async () => {
		const { connection, queries } = connectionAnswering(true);

		await withAdministratorAuthority(IDENTITY, () =>
			confirmAdministratorAuthority({ schema: SCHEMA })(connection, { exclusive: false }),
		);

		assert.deepEqual(queries[0], {
			text: 'SELECT pg_advisory_xact_lock_shared($1)',
			values: [ADMINISTRATORS_LOCK],
		});
	});

	test('takes the administrators lock exclusively for a change that alters who is an administrator', async () => {
		const { connection, queries } = connectionAnswering(true);

		await withAdministratorAuthority(IDENTITY, () =>
			confirmAdministratorAuthority({ schema: SCHEMA })(connection, { exclusive: true }),
		);

		assert.deepEqual(queries[0], {
			text: 'SELECT pg_advisory_xact_lock($1)',
			values: [ADMINISTRATORS_LOCK],
		});
	});

	test('reads the status of the identity the request was admitted as, after taking the lock', async () => {
		const { connection, queries } = connectionAnswering(true);

		await withAdministratorAuthority(IDENTITY, () =>
			confirmAdministratorAuthority({ schema: SCHEMA })(connection, { exclusive: false }),
		);

		assert.equal(queries.length, 2);
		assert.deepEqual(queries[1]?.values, [IDENTITY.issuer, IDENTITY.subject]);
		assert.match(queries[1]?.text ?? '', /"usher"\.administrators/u);
	});

	test('lets the change proceed while the identity is still an administrator', async () => {
		const { connection } = connectionAnswering(true);

		await assert.doesNotReject(
			withAdministratorAuthority(IDENTITY, () =>
				confirmAdministratorAuthority({ schema: SCHEMA })(connection, { exclusive: false }),
			),
		);
	});

	test('throws AdministratorStatusWithdrawn once the identity is no longer an administrator', async () => {
		const { connection } = connectionAnswering(false);

		await assert.rejects(
			withAdministratorAuthority(IDENTITY, () =>
				confirmAdministratorAuthority({ schema: SCHEMA })(connection, { exclusive: false }),
			),
			AdministratorStatusWithdrawn,
		);
	});
});
