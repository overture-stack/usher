import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type pg from 'pg';

import type { AdminResponse } from '../../testing/harness/admin.js';
import {
	administratorCaller,
	assertSucceeded,
	categoriesOf,
	decideNomination,
	firstUserCaller,
	listCategories,
	nominate,
	personCaller,
	registerCategory,
	removeAdministrator,
	updateCategory,
} from '../../testing/harness/admin.js';
import { AUDIT_EVENT_TYPES, auditRows, dataOf, emittedType } from '../../testing/harness/auditEvents.js';
import { PEOPLE, type Person, SYSTEM_CLOCK } from '../../testing/harness/exchange.js';
import { ANA_ACTING, BASE_FIXTURE, openSeededDatabase, SUBJECTS } from '../../testing/fixtures/database.js';
import { type Harness, type HarnessOptions, withHarness } from '../../testing/harness/harness.js';
import { DEFAULT_FIXTURE_ISSUER, inTransactionAs, type PolicyFixture } from '../../testing/harness/policy.js';
import { type Actor, type AuditTrail, createAuditTrail } from '../eventLog/index.js';
import { confirmAdministratorAuthority } from '../administrators/index.js';
import { AdministratorStatusWithdrawn, withAdministratorAuthority } from '../managementApi/index.js';
import { isCountedOwner, listGlobalCategories } from './categoryStore.js';
import { sqlCategoryStore } from './categoryStore.js';

// The base policy, with Bo's owner grant accepted, so Bo is a counted owner, and each person met under the
// trusted issuer, so their identity is the one the counted-owner check reads.
const OWNED_FIXTURE: PolicyFixture = {
	...BASE_FIXTURE,
	decisions: [
		{ decision: 'accepted', grant: 'anaViews' },
		{ decision: 'accepted', grant: 'boOwns' },
	],
	users: {
		ana: { subject: SUBJECTS.ana },
		bo: { subject: SUBJECTS.bo },
		cy: { subject: SUBJECTS.cy },
	},
};

// A connection the store reads and writes over, read as the runtime role the Controller holds.
type Connection = pg.Client & { release(destroy?: boolean): void };

const readerOf = (client: pg.ClientBase) => ({
	query: <Row extends pg.QueryResultRow>(text: string, values: readonly unknown[] = []) =>
		client.query<Row>(text, [...values]),
});

const globalNames = async (client: pg.ClientBase, schema: string): Promise<readonly string[]> =>
	(
		await client.query<{ name: string }>(
			`SELECT name FROM ${schema}.categories WHERE scope = 'global' ORDER BY name COLLATE "C"`,
		)
	).rows.map(({ name }) => name);

suite('the global categories in the store', () => {
	test('writes a registered category in its transaction, and a transaction failing after the insert writes none of it', async (context) => {
		const { database, owner } = await openSeededDatabase(context, OWNED_FIXTURE);
		const client = await database.connect('runtime');
		const schema = database.schema;
		const store = sqlCategoryStore(client, schema);

		await assert.rejects(
			inTransactionAs(client, ANA_ACTING, async () => {
				await store.insertGlobal({ description: 'Pending', name: 'rolled-back' });
				throw new Error('the change failed after its insert');
			}),
			/after its insert/u,
		);
		assert.deepEqual(await globalNames(owner, schema), ['controlled', 'unmarked']);
		await inTransactionAs(client, ANA_ACTING, () => store.insertGlobal({ description: 'Kept', name: 'kept' }));
		assert.deepEqual(await globalNames(owner, schema), ['controlled', 'kept', 'unmarked']);
	});

	test('writes one row when two registrations of one name in different letter cases run at once, the other finding the name taken under the spelling written', async (context) => {
		const { database, owner } = await openSeededDatabase(context, OWNED_FIXTURE);
		const first = await database.connect('runtime');
		const second = await database.connect('runtime');
		const schema = database.schema;

		const insertions = await Promise.all(
			[
				{ client: first, name: 'Race' },
				{ client: second, name: 'race' },
			].map(({ client, name }) =>
				inTransactionAs(client, ANA_ACTING, () =>
					sqlCategoryStore(client, schema).insertGlobal({ description: null, name }),
				),
			),
		);

		const written = (await globalNames(owner, schema)).filter((name) => name.toLowerCase() === 'race');
		assert.equal(written.length, 1);
		assert.deepEqual(
			insertions.map((insertion) => (insertion.kind === 'taken' ? insertion.existing : 'inserted')).toSorted(),
			[...written, 'inserted'].toSorted(),
		);
	});

	test('finds a global category by its name in any letter case, under the spelling it was registered in', async (context) => {
		const { database } = await openSeededDatabase(context, OWNED_FIXTURE);
		const client = await database.connect('runtime');
		const store = sqlCategoryStore(client, database.schema);

		const found = await inTransactionAs(client, ANA_ACTING, () => store.findGlobal('CONTROLLED'));

		assert.equal(found?.name, 'controlled');
	});

	test('sets a description by the stored row, and lists the global categories by scoped name in byte order, unmarked included', async (context) => {
		const { database } = await openSeededDatabase(context, OWNED_FIXTURE);
		const client = await database.connect('runtime');
		const schema = database.schema;
		const store = sqlCategoryStore(client, schema);

		const stored = await store.findGlobal('controlled');
		assert.ok(stored);
		await inTransactionAs(client, ANA_ACTING, () => store.setDescription(stored.id, 'Reviewed'));

		assert.equal(await store.findGlobal('absent'), undefined);
		assert.deepEqual(await listGlobalCategories(readerOf(client), schema), [
			{ description: 'Reviewed', name: 'global.controlled' },
			{ description: null, name: 'global.unmarked' },
		]);
	});

	test('counts a person holding a live accepted owner grant, and not one holding a viewer grant or no grant at all', async (context) => {
		const { database } = await openSeededDatabase(context, OWNED_FIXTURE);
		const client = await database.connect('runtime');
		const schema = database.schema;
		const now = new Date(SYSTEM_CLOCK.now());
		const check = (subject: string) =>
			isCountedOwner(readerOf(client), schema, { issuer: DEFAULT_FIXTURE_ISSUER, subject }, now);

		assert.equal(await check(SUBJECTS.bo), true);
		assert.equal(await check(SUBJECTS.ana), false);
		assert.equal(await check(SUBJECTS.cy), false);
		assert.equal(await check('nobody-met'), false);
	});
});

// The first user's nomination of Bo and then Cy, each accepted, so both are administrators in turn.
const BEFORE_THE_FIRST: HarnessOptions = {
	applications: [],
	configuration: { storeTimeoutMilliseconds: 15_000 },
	fixture: {
		users: {
			bo: { subject: PEOPLE.bo.subject },
			cy: { subject: PEOPLE.cy.subject },
		},
	},
	seedsAdministrator: false,
};

const nominationOf = (answer: AdminResponse, label: string): string => {
	assertSucceeded(answer, label);
	return String(Reflect.get(Object(answer.body), 'id'));
};

const acceptedCyByBo = async (harness: Harness): Promise<void> => {
	const toBo = nominationOf(
		await nominate(await firstUserCaller(harness, PEOPLE.ana), { nominee: { subject: PEOPLE.bo.subject } }),
		'nominating Bo',
	);
	assertSucceeded(await decideNomination(await personCaller(harness, PEOPLE.bo), toBo, 'accept'), 'Bo accepting');
	const toCy = nominationOf(
		await nominate(await personCaller(harness, PEOPLE.bo), { nominee: { subject: PEOPLE.cy.subject } }),
		'Bo nominating Cy',
	);
	assertSucceeded(await decideNomination(await personCaller(harness, PEOPLE.cy), toCy, 'accept'), 'Cy accepting');
};

// A trail over the harness's database, its connections taken as the runtime role, with the real confirmation of
// the administrator each change runs under.
const trailOver = (harness: Harness): AuditTrail<Connection> => {
	const store = {
		connect: async (): Promise<Connection> =>
			Object.assign(await harness.database.connect('runtime'), { release: () => undefined }),
	};
	return createAuditTrail({
		confirmAuthority: confirmAdministratorAuthority({ schema: harness.database.schema }),
		eventLog: { error: () => undefined, writeEvent: () => undefined },
		settings: {
			clock: SYSTEM_CLOCK,
			databaseSchema: harness.database.schema,
			eventSource: 'https://usher.example.org/controller',
			instanceName: 'usher-category-test',
			storeTimeoutMilliseconds: 15_000,
		},
		store,
	});
};

const actorOf = (person: Person): Actor => ({ id: person.subject, type: 'human' });

const changeBy = (harness: Harness, trail: AuditTrail<Connection>, person: Person, name: string): Promise<unknown> =>
	withAdministratorAuthority({ issuer: harness.configuration.identityProviderIssuer, subject: person.subject }, () =>
		trail.inTransaction(actorOf(person), async ({ connection }) =>
			sqlCategoryStore(connection, harness.database.schema).insertGlobal({ description: null, name }),
		),
	);

suite('the administrator a category change runs under, confirmed in its own transaction', () => {
	test('lets a change by an administrator commit while they are one, and refuses the same change once a removal of them has committed AdministratorStatusWithdrawn, writing nothing', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				await acceptedCyByBo(harness);
				const trail = trailOver(harness);

				assert.notEqual(await changeBy(harness, trail, PEOPLE.cy, 'while-admin'), undefined);
				assertSucceeded(
					await removeAdministrator(await personCaller(harness, PEOPLE.bo), PEOPLE.cy.subject),
					'the removal',
				);
				await assert.rejects(
					changeBy(harness, trail, PEOPLE.cy, 'after-removal'),
					AdministratorStatusWithdrawn,
				);
				const { rows } = await harness.clients.migration.query<{ name: string }>(
					`SELECT name FROM ${harness.database.schema}.categories WHERE name = 'after-removal'`,
				);
				assert.deepEqual(rows, []);
			},
			context,
		);
	});
});

suite('the category operations over the Management API, against the store', () => {
	test('registers a category writing its row and its event, refuses a duplicate or a concurrent duplicate 409 writing nothing more, and changes a description recording the change', async (context) => {
		await withHarness(
			{},
			async (harness) => {
				const administrator = await administratorCaller(harness);
				const rowsNamed = async (name: string): Promise<number> =>
					(
						await harness.clients.migration.query<{ count: number }>(
							`SELECT count(*)::int AS count FROM ${harness.database.schema}.categories WHERE scope = 'global' AND name = $1`,
							[name],
						)
					).rows[0]?.count ?? 0;
				const eventsOf = async (type: string): Promise<readonly Readonly<Record<string, unknown>>[]> =>
					(await auditRows(harness.clients.migration))
						.filter((row) => row.type === emittedType(type))
						.map((row) => ({ ...dataOf(row), severity: row.severity }));

				assertSucceeded(await registerCategory(administrator, { name: 'community' }), 'the registration');
				const duplicate = await registerCategory(administrator, { name: 'community' });
				const raced = await Promise.all([
					registerCategory(administrator, { name: 'raced' }),
					registerCategory(administrator, { name: 'raced' }),
				]);

				assert.deepEqual([duplicate.status, ...raced.map(({ status }) => status).toSorted()], [409, 201, 409]);
				assert.deepEqual([await rowsNamed('community'), await rowsNamed('raced')], [1, 1]);
				assert.deepEqual(
					(await eventsOf(AUDIT_EVENT_TYPES.categoryCreation))
						.map(({ category, result }) => `${String(category)} ${String(result)}`)
						.toSorted(),
					[
						'global.community denied',
						'global.community succeeded',
						'global.raced denied',
						'global.raced succeeded',
					],
				);

				assertSucceeded(
					await updateCategory(administrator, 'global.community', { description: 'Under review' }),
					'the description change',
				);
				assertSucceeded(
					await updateCategory(administrator, 'global.community', { description: 'Under review' }),
					'the unchanged patch',
				);
				assert.deepEqual(
					(await eventsOf(AUDIT_EVENT_TYPES.categoryDescriptionChange)).map(
						({ descriptionAfter, descriptionBefore, severity }) => [
							descriptionBefore,
							descriptionAfter,
							severity,
						],
					),
					[[null, 'Under review', 'info']],
				);
				assert.deepEqual(
					categoriesOf(await listCategories(administrator)).map(({ name }) => name),
					['global.community', 'global.raced', 'global.unmarked'],
				);
			},
			context,
		);
	});

	test('refuses a name held in another letter case 409, sequentially or at once, and changes a description by a scoped name in any letter case under the spelling registered', async (context) => {
		await withHarness(
			{},
			async (harness) => {
				const administrator = await administratorCaller(harness);
				const spellingsOf = async (name: string): Promise<readonly string[]> =>
					(
						await harness.clients.migration.query<{ name: string }>(
							`SELECT name FROM ${harness.database.schema}.categories
                              WHERE scope = 'global' AND lower(name) = lower($1) ORDER BY name`,
							[name],
						)
					).rows.map(({ name }) => name);

				assertSucceeded(await registerCategory(administrator, { name: 'Tier' }), 'the registration');
				const variant = await registerCategory(administrator, { name: 'TIER' });
				const raced = await Promise.all([
					registerCategory(administrator, { name: 'Pair' }),
					registerCategory(administrator, { name: 'PAIR' }),
				]);
				const changed = await updateCategory(administrator, 'global.tier', { description: 'Tiered access' });

				assert.equal(variant.status, 409);
				assert.match(JSON.stringify(variant.body), /global\.Tier/u);
				assert.deepEqual(raced.map(({ status }) => status).toSorted(), [201, 409]);
				assert.deepEqual([(await spellingsOf('tier')).length, (await spellingsOf('pair')).length], [1, 1]);
				assert.equal(changed.status, 200);
				assert.deepEqual(changed.body, { description: 'Tiered access', name: 'global.Tier' });
			},
			context,
		);
	});

	test('sends one baseline notice for a registration, and none for a refused duplicate or a change of description', async (context) => {
		await withHarness(
			{},
			async (harness) => {
				const administrator = await administratorCaller(harness);
				const baselineNotices = async (): Promise<number> =>
					(
						await harness.clients.migration.query<{ count: number }>(
							`SELECT count(*)::int AS count FROM ${harness.database.schema}.notices WHERE kind = 'baseline'`,
						)
					).rows[0]?.count ?? 0;
				const before = await baselineNotices();

				assertSucceeded(await registerCategory(administrator, { name: 'controlled' }), 'the registration');
				const afterRegistration = await baselineNotices();
				assert.equal((await registerCategory(administrator, { name: 'controlled' })).status, 409);
				assertSucceeded(
					await updateCategory(administrator, 'global.controlled', { description: 'Reviewed access' }),
					'the description change',
				);

				assert.deepEqual([afterRegistration - before, (await baselineNotices()) - afterRegistration], [1, 0]);
			},
			context,
		);
	});
});
