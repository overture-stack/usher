import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type pg from 'pg';

import type { AuditTrail } from '../eventLog/index.js';
import { StartRefusal } from '../failures/index.js';
import { CommitUnconfirmed, StoreTimeout } from '../storeTimeout/index.js';
import { checkStatementLimits, prepareStore } from './prepareStore.js';
import type { StoreSettings } from './types.js';

const SETTINGS: StoreSettings = {
	apiDocsClient: 'usher-ui',
	backChannelLogoutAudiences: ['portal-ui'],
	clock: { now: () => Date.UTC(2026, 10, 5) },
	databaseSchema: 'usher',
	identityProviderIssuer: 'https://auth.example.org/realms/usher',
	keyEncryptionKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
	managementAudience: 'usher-management',
	managementClients: ['usher-ui'],
	serviceAccountRole: 'usher-service-account',
	storeTimeoutMilliseconds: 5000,
};

const QUIET = Object.freeze({
	error: () => undefined,
	warning: () => undefined,
});

// The release's migrations, none here: every trail below fails before the record is read.
const MIGRATIONS = Object.freeze([]);

// The source the start holds the settings in: none is read here, since every trail below fails first.
const SOURCE = { hold: () => undefined };

// A trail whose every transaction fails as given, before any statement.
const failingTrail = (failure: unknown): Pick<AuditTrail<pg.ClientBase>, 'inTransaction'> => ({
	inTransaction: () => Promise.reject(failure),
});

suite("preparing the store at the controller's start", () => {
	test('refuses the start, naming the database URL as the variable at fault and the store timeout in the rule, when the store does not answer it within the store timeout', async () => {
		const refusal = await prepareStore(failingTrail(new StoreTimeout()), SETTINGS, QUIET, MIGRATIONS, SOURCE).catch(
			(failure: unknown) => failure,
		);

		assert.ok(refusal instanceof StartRefusal);
		assert.deepEqual(refusal.variables, ['USHER_DATABASE_URL']);
		assert.equal(
			refusal.message,
			'the controller refuses to start: USHER_DATABASE_URL names a store that did not answer the start within the time USHER_STORE_TIMEOUT_MILLISECONDS allows',
		);
	});

	test("refuses the start, naming the database URL, when the store does not confirm the start's commit", async () => {
		const refusal = await prepareStore(
			failingTrail(new CommitUnconfirmed()),
			SETTINGS,
			QUIET,
			MIGRATIONS,
			SOURCE,
		).catch((failure: unknown) => failure);

		assert.ok(refusal instanceof StartRefusal);
		assert.equal(
			refusal.message,
			"the controller refuses to start: USHER_DATABASE_URL names a store that did not confirm the start's commit within the time USHER_STORE_TIMEOUT_MILLISECONDS allows",
		);
	});

	test('refuses the start, naming the variable at fault, when the store cannot be reached or signed in to', async () => {
		const refusals = await Promise.all(
			['ECONNREFUSED', '28P01'].map((code) =>
				prepareStore(
					failingTrail(Object.assign(new Error(`refused at 10.0.0.5: ${code}`), { code })),
					SETTINGS,
					QUIET,
					MIGRATIONS,
					SOURCE,
				).catch((failure: unknown) => failure),
			),
		);

		assert.deepEqual(
			refusals.map((refusal) => (refusal instanceof StartRefusal ? refusal.variables : refusal)),
			[['USHER_DATABASE_URL'], ['USHER_DATABASE_PASSWORD']],
		);
		assert.equal(JSON.stringify(refusals.map(String)).includes('10.0.0.5'), false);
	});

	test("passes on any other failure of the start's transaction as it was thrown", async () => {
		const reset = Object.assign(new Error('read ECONNRESET'), {
			code: 'ECONNRESET',
		});

		await assert.rejects(
			prepareStore(failingTrail(reset), SETTINGS, QUIET, MIGRATIONS, SOURCE),
			(thrown) => thrown === reset,
		);
	});
});

// A pool's reader answering the read of the limits with the rows given, or failing as given.
const limitsReader = (
	answer: readonly Readonly<Record<string, unknown>>[] | Error,
): Parameters<typeof checkStatementLimits>[0] => ({
	query: async <Row extends pg.QueryResultRow>(): Promise<pg.QueryResult<Row>> => {
		if (answer instanceof Error) {
			throw answer;
		}
		return { rows: [...answer] } as unknown as pg.QueryResult<Row>;
	},
});

suite("checking the limits on another of the controller's pools at its start", () => {
	test('passes a pool whose sessions carry both limits at the store timeout', async () => {
		await checkStatementLimits(
			limitsReader([
				{
					name: 'idle_in_transaction_session_timeout',
					setting: '5',
					unit: 's',
				},
				{ name: 'statement_timeout', setting: '5000', unit: 'ms' },
			]),
			SETTINGS,
		);
	});

	test('refuses the start, naming the database URL, for a pool whose sessions lack either limit, as through a pooler dropping them', async () => {
		const refusal = await checkStatementLimits(
			limitsReader([{ name: 'statement_timeout', setting: '0', unit: 'ms' }]),
			SETTINGS,
		).catch((failure: unknown) => failure);

		assert.ok(refusal instanceof StartRefusal);
		assert.deepEqual(refusal.variables, ['USHER_DATABASE_URL']);
	});

	test("refuses the start as the start's own transaction does when the pool cannot reach the store or the store does not answer", async () => {
		const refusals = await Promise.all(
			[new StoreTimeout(), Object.assign(new Error('refused at 10.0.0.5'), { code: '28P01' })].map((failure) =>
				checkStatementLimits(limitsReader(failure), SETTINGS).catch((thrown: unknown) => thrown),
			),
		);

		assert.deepEqual(
			refusals.map((refusal) => (refusal instanceof StartRefusal ? refusal.variables : refusal)),
			[['USHER_DATABASE_URL'], ['USHER_DATABASE_PASSWORD']],
		);
	});
});
