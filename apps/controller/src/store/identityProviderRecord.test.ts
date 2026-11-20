import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type pg from 'pg';

import type { AuditTransaction } from '../eventLog/index.js';
import { OVERLAPPING_QUERY_REFUSAL } from '../../testing/harness/serialQueries.js';
import { IDENTIFIER_NAMES, recordIdentityProvider } from './identityProviderRecord.js';

type Settings = Parameters<typeof recordIdentityProvider>[1];

const CLOCK = { now: () => Date.parse('2026-11-19T12:00:00Z') };

const SETTINGS: Settings = {
	apiDocsClient: 'usher-docs',
	backChannelLogoutAudiences: ['usher-controller', 'usher-bridge'],
	clock: CLOCK,
	databaseSchema: 'usher',
	identityProviderIssuer: 'https://idp.example.org/realms/usher',
	managementAudience: 'usher-management',
	managementClients: ['usher-admin'],
	serviceAccountRole: 'usher-service',
};

interface Asked {
	text: string;
	values: readonly unknown[] | undefined;
}

// A connection as pg 9 will answer: a query issued while another query on it is still in flight is
// rejected. The store's rows are read as all six unfilled, a fresh store, and each query takes a turn
// in the event loop so that overlapping queries are seen overlapping.
const serialConnection = (): { asked: Asked[]; connection: pg.ClientBase } => {
	const asked: Asked[] = [];
	let inFlight = 0;
	const connection = {
		query: async (text: string, values?: readonly unknown[]) => {
			asked.push({ text, values });
			if (inFlight > 0) {
				throw new Error(OVERLAPPING_QUERY_REFUSAL);
			}
			inFlight += 1;
			await new Promise<void>((resolve) => setImmediate(resolve));
			inFlight -= 1;
			return text.startsWith('SELECT')
				? { rows: IDENTIFIER_NAMES.map((name) => ({ name, value: null })) }
				: { rows: [] };
		},
	};
	return { asked, connection: connection as unknown as pg.ClientBase };
};

const transactionOn = (connection: pg.ClientBase): AuditTransaction<pg.ClientBase> => ({
	connection,
	record: async () => {
		throw new Error('a fresh store records no change event');
	},
});

suite("recording the identity provider's identifiers", () => {
	test('writes each unfilled identifier one query after another on the start connection, never two at once', async () => {
		const { asked, connection } = serialConnection();

		await recordIdentityProvider(transactionOn(connection), SETTINGS);

		const updates = asked.filter(({ text }) => text.startsWith('UPDATE'));
		assert.deepEqual(
			updates.map(({ values }) => values?.[2]),
			IDENTIFIER_NAMES,
		);
	});
});
