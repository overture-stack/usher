import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type pg from 'pg';

import { confirmAdministratorAuthority, sqlAdministratorStore } from '../administrators/index.js';
import {
	type AdminResponse,
	assertSucceeded,
	createGrant,
	decideNomination,
	firstUserCaller,
	liftIdentityRevocation,
	listAdministrators,
	nominate,
	personCaller,
	registerResource,
	signOutEveryone,
	revokeIdentity,
} from '../../testing/harness/admin.js';
import { auditRows, dataOf, emittedType } from '../../testing/harness/auditEvents.js';
import { untilBlocked } from '../../testing/harness/database.js';
import { PEOPLE, type Person } from '../../testing/harness/exchange.js';
import {
	committedQuery,
	INTEGRITY,
	openSeededDatabase,
	SUBJECTS,
	selectRows,
	violation,
} from '../../testing/fixtures/database.js';
import { type Harness, type HarnessOptions, withHarness } from '../../testing/harness/harness.js';
import { DEFAULT_FIXTURE_ISSUER, POLICY_TABLES, qualified, seededId } from '../../testing/harness/policy.js';
import { type Actor, type AuditTrail, createAuditTrail } from '../eventLog/index.js';
import { withAdministratorAuthority } from '../managementApi/index.js';
import { readStoredRefusal } from '../signInTokens/index.js';
import { sqlRevocationStore } from './revocationStore.js';

const { everyoneSignOuts, grants, notices, principalRevocations, subjectSignOuts, userIdentities } = POLICY_TABLES;

const FIRST_USER = PEOPLE.ana;

// A store holding no administrator, as before the first user's nomination is accepted; Bo and Cy have met Usher.
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

const outcomeOf = ({ problem, status }: AdminResponse): readonly unknown[] => [status, problem?.code];

const nominationOf = (answer: AdminResponse, label: string): string => {
	assertSucceeded(answer, label);
	const id = Reflect.get(Object(answer.body), 'id');
	return typeof id === 'string' ? id : assert.fail(`${label} named no id`);
};

// Makes Bo the first administrator, by the first user's nomination and Bo's acceptance.
const acceptedBo = async (harness: Harness): Promise<void> => {
	const nomination = nominationOf(
		await nominate(await firstUserCaller(harness, FIRST_USER), { nominee: { subject: PEOPLE.bo.subject } }),
		'the first nomination',
	);
	assertSucceeded(
		await decideNomination(await personCaller(harness, PEOPLE.bo), nomination, 'accept'),
		'the acceptance',
	);
};

// Makes Cy an administrator too, nominated and accepted by Bo.
const acceptedCyByBo = async (harness: Harness): Promise<void> => {
	await acceptedBo(harness);
	const nomination = nominationOf(
		await nominate(await personCaller(harness, PEOPLE.bo), { nominee: { subject: PEOPLE.cy.subject } }),
		'Bo nominating Cy',
	);
	assertSucceeded(
		await decideNomination(await personCaller(harness, PEOPLE.cy), nomination, 'accept'),
		'Cy accepting',
	);
};

// The count of the rows a query selects, over the harness's owner connection.
const countOf = async (harness: Harness, text: string, values: readonly unknown[] = []): Promise<number> =>
	(
		await selectRows<{ count: number }>(
			harness.clients.migration,
			`SELECT count(*)::int AS count FROM (${text}) selected`,
			values,
		)
	)[0]?.count ?? 0;

const principalNoticeCount = (harness: Harness): Promise<number> =>
	countOf(harness, `SELECT 1 FROM ${qualified(notices)} WHERE ${notices.columns.kind} = 'principal'`);

const signOutEveryoneNoticeCount = (harness: Harness): Promise<number> =>
	countOf(harness, `SELECT 1 FROM ${qualified(notices)} WHERE ${notices.columns.kind} = 'signOutEveryone'`);

const revocationCount = (harness: Harness): Promise<number> =>
	countOf(harness, `SELECT 1 FROM ${qualified(principalRevocations)}`);

// The audit events of one type, as their data and severity, the refusals of an operation included.
const eventsOfType = async (
	harness: Harness,
	type: string,
): Promise<readonly { readonly data: Readonly<Record<string, unknown>>; severity: string }[]> =>
	(await auditRows(harness.clients.migration))
		.filter((row) => row.type === emittedType(type))
		.map((row) => ({ data: dataOf(row), severity: String(row.severity) }));

suite('revoking and lifting a principal, through the Management API, against the store', () => {
	test('writes the revocation, its principal notice and its event together, and answers a second revocation of the same person 409 alreadyRevoked, writing nothing', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				await acceptedCyByBo(harness);
				const notified = await principalNoticeCount(harness);

				const answer = await revokeIdentity(await personCaller(harness, PEOPLE.bo), {
					reason: 'credentialCompromise',
					subject: PEOPLE.cy.subject,
				});

				assert.equal(answer.status, 201);
				assert.equal(await revocationCount(harness), 1);
				assert.equal(await principalNoticeCount(harness), notified + 1);
				assert.deepEqual(
					(await eventsOfType(harness, 'identity.revocation')).map(({ severity }) => severity),
					['critical'],
				);

				const again = await revokeIdentity(await personCaller(harness, PEOPLE.bo), {
					reason: 'termsViolation',
					subject: PEOPLE.cy.subject,
				});

				assert.deepEqual(outcomeOf(again), [409, 'alreadyRevoked']);
				assert.equal(await revocationCount(harness), 1);
				assert.equal(await principalNoticeCount(harness), notified + 1);
			},
			context,
		);
	});

	test('keeps one standing revocation of a person when two revocations of them are sent at once', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				await acceptedCyByBo(harness);
				const caller = await personCaller(harness, PEOPLE.bo);

				const answers = await Promise.all([
					revokeIdentity(caller, { reason: 'credentialCompromise', subject: PEOPLE.cy.subject }),
					revokeIdentity(caller, { reason: 'securityIncident', subject: PEOPLE.cy.subject }),
				]);

				assert.deepEqual(answers.map((answer) => answer.status).toSorted(), [201, 409]);
				assert.equal(await revocationCount(harness), 1);
			},
			context,
		);
	});

	test('records a subject Usher has never met, and answers seenBefore false', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				await acceptedBo(harness);

				const answer = await revokeIdentity(await personCaller(harness, PEOPLE.bo), {
					reason: 'accountClosed',
					subject: 'auth0|never-met',
				});

				assert.equal(answer.status, 201);
				assert.equal(Reflect.get(Object(answer.body), 'seenBefore'), false);
				assert.equal(
					await countOf(
						harness,
						`SELECT 1 FROM ${qualified(userIdentities)} WHERE ${userIdentities.columns.idpSubjectId} = 'auth0|never-met'`,
					),
					1,
				);
			},
			context,
		);
	});

	test('lifts a standing revocation keeping its row, writes the lift, a principal notice and its event, and answers a second lift 409 notRevoked', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				await acceptedCyByBo(harness);
				await revokeIdentity(await personCaller(harness, PEOPLE.bo), {
					reason: 'credentialCompromise',
					subject: PEOPLE.cy.subject,
				});
				const notified = await principalNoticeCount(harness);

				const lifted = await liftIdentityRevocation(await personCaller(harness, PEOPLE.bo), PEOPLE.cy.subject);

				assert.equal(lifted.status, 200);
				assert.equal(await revocationCount(harness), 1);
				assert.equal(await principalNoticeCount(harness), notified + 1);
				assert.deepEqual(
					(await eventsOfType(harness, 'identity.revocationLift')).map(({ data, severity }) => [
						severity,
						data['liftedUserSubject'],
						data['reason'],
					]),
					[['critical', PEOPLE.cy.subject, 'credentialCompromise']],
				);

				const again = await liftIdentityRevocation(await personCaller(harness, PEOPLE.bo), PEOPLE.cy.subject);

				assert.deepEqual(outcomeOf(again), [409, 'notRevoked']);
				assert.equal(await principalNoticeCount(harness), notified + 1);
			},
			context,
		);
	});

	test('refuses a lift of a subject Usher has never met 409 notRevoked, writing nothing', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				await acceptedBo(harness);

				const answer = await liftIdentityRevocation(await personCaller(harness, PEOPLE.bo), 'auth0|never-met');

				assert.deepEqual(outcomeOf(answer), [409, 'notRevoked']);
				assert.equal(await revocationCount(harness), 0);
			},
			context,
		);
	});

	test('writes a sign-out of everyone, its signOutEveryone notice and its event at critical', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				await acceptedBo(harness);
				const notified = await signOutEveryoneNoticeCount(harness);

				const answer = await signOutEveryone(await personCaller(harness, PEOPLE.bo), {
					reason: 'credentialCompromise',
				});

				assert.equal(answer.status, 201);
				assert.equal(await countOf(harness, `SELECT 1 FROM ${qualified(everyoneSignOuts)}`), 1);
				assert.equal(await signOutEveryoneNoticeCount(harness), notified + 1);
				assert.deepEqual(
					(await eventsOfType(harness, 'identity.signOutEveryone')).map(({ severity }) => severity),
					['critical'],
				);
			},
			context,
		);
	});

	test('refuses revoking the only live administrator 409 lastAdministrator, and a revoked administrator acts as none', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				await acceptedCyByBo(harness);

				const self = await revokeIdentity(await personCaller(harness, PEOPLE.bo), {
					reason: 'accountClosed',
					subject: PEOPLE.bo.subject,
				});
				assert.equal(self.status, 201);

				const last = await revokeIdentity(await personCaller(harness, PEOPLE.cy), {
					reason: 'accountClosed',
					subject: PEOPLE.cy.subject,
				});
				assert.deepEqual(outcomeOf(last), [409, 'lastAdministrator']);
				assert.equal(await revocationCount(harness), 1);

				const acted = await revokeIdentity(await personCaller(harness, PEOPLE.bo), {
					reason: 'accountClosed',
					subject: PEOPLE.cy.subject,
				});
				assert.equal(acted.status, 401);
			},
			context,
		);
	});

	test('lists a revoked administrator among the administrators, marked revoked, until a removal ends them', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				await acceptedCyByBo(harness);
				assertSucceeded(
					await revokeIdentity(await personCaller(harness, PEOPLE.cy), {
						reason: 'credentialCompromise',
						subject: PEOPLE.bo.subject,
					}),
					'Cy revoking Bo',
				);

				const listing = await listAdministrators(await personCaller(harness, PEOPLE.cy));

				assertSucceeded(listing, 'the listing');
				assert.deepEqual(
					(
						listing.body as { administrators: readonly { revoked: unknown; subject: unknown }[] }
					).administrators.map(({ revoked, subject }) => [subject, revoked]),
					[
						[PEOPLE.bo.subject, true],
						[PEOPLE.cy.subject, false],
					],
				);
			},
			context,
		);
	});

	test('refuses a change in flight when its administrator is revoked behind the gate, 403 administratorOnly, writing no grant', async (context) => {
		await withHarness(
			BEFORE_THE_FIRST,
			async (harness) => {
				await acceptedCyByBo(harness);
				assertSucceeded(
					await registerResource(await personCaller(harness, PEOPLE.bo), {
						accessLevel: 'grant',
						displayName: 'Study STUDY-E1',
						externalId: 'STUDY-E1',
					}),
					'the registration',
				);
				const trail = trailOver(harness);
				const issuer = harness.configuration.identityProviderIssuer;
				const schema = harness.database.schema;
				const entered = gateOf();
				const holding = gateOf();
				const revoking = withAdministratorAuthority({ issuer, subject: PEOPLE.bo.subject }, () =>
					trail.inTransaction(
						actorOf(PEOPLE.bo),
						async ({ connection }) => {
							entered.open();
							await holding.promise;
							const administrators = sqlAdministratorStore(connection, { issuer, schema });
							const revokedBy = (await administrators.findPerson(PEOPLE.bo.subject)) ?? '';
							const userId = (await administrators.findPerson(PEOPLE.cy.subject)) ?? '';
							await sqlRevocationStore(connection, schema).recordPrincipal({
								reason: 'credentialCompromise',
								revokedAt: new Date(),
								revokedBy,
								userId,
							});
						},
						{ exclusiveAuthority: true },
					),
				).then(
					() => 'revoked',
					(failure: unknown) => failure,
				);
				await entered.promise;
				const granting = personCaller(harness, PEOPLE.cy).then((caller) =>
					createGrant(caller, {
						holder: { subject: FIRST_USER.subject },
						resource: 'STUDY-E1',
						role: 'viewer',
					}),
				);
				try {
					assert.equal(await untilBlocked(harness.clients.migration, granting), true);
				} finally {
					holding.open();
				}
				assert.equal(await revoking, 'revoked');

				assert.deepEqual(outcomeOf(await granting), [403, 'administratorOnly']);
				assert.equal(await countOf(harness, `SELECT 1 FROM ${qualified(grants)}`), 0);
			},
			context,
		);
	});
});

suite("a revocation's reason, as the store keeps it", () => {
	test('refuses a reason outside the identity revocation reasons at the store, by the CHECK', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context);

		await assert.rejects(
			committedQuery(
				owner,
				`INSERT INTO ${qualified(principalRevocations)} (${principalRevocations.columns.userId}, ${principalRevocations.columns.revokedBy}, ${principalRevocations.columns.revokedAt}, ${principalRevocations.columns.reason}) VALUES ($1, $2, now(), 'keyCompromise')`,
				[seededId(seeded.users, 'cy'), seededId(seeded.users, 'ana')],
			),
			violation(INTEGRITY.check, 'principal_revocations_reason_known'),
		);
	});

	test('refuses keyCompromise for a sign-out of everyone at the store, by the CHECK', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context);

		await assert.rejects(
			committedQuery(
				owner,
				`INSERT INTO ${qualified(everyoneSignOuts)} (${everyoneSignOuts.columns.signedOutBy}, ${everyoneSignOuts.columns.signedOutAt}, ${everyoneSignOuts.columns.reasonCode}) VALUES ($1, now(), 'keyCompromise')`,
				[seededId(seeded.users, 'ana')],
			),
			violation(INTEGRITY.check, 'everyone_sign_outs_reason_known'),
		);
	});
});

suite('a lift and the tokens issued around it, as the exchange and the Management API read them', () => {
	// Instants of one day, and their seconds as a token names its `iat`.
	const at = (hour: number, minute = 0): Date => new Date(Date.UTC(2026, 10, 24, hour, minute, 0));
	const secondsOf = (date: Date): number => Math.floor(date.getTime() / 1000);

	// Cy's revocation made by Ana at `revokedAt` and lifted by Ana at `liftedAt`, written as the runtime role reads it.
	const revokeAndLift = (owner: pg.ClientBase, ana: string, cy: string, revokedAt: Date, liftedAt: Date) =>
		committedQuery(
			owner,
			`INSERT INTO ${qualified(principalRevocations)} (${principalRevocations.columns.userId}, ${principalRevocations.columns.revokedBy}, ${principalRevocations.columns.revokedAt}, ${principalRevocations.columns.reason}, ${principalRevocations.columns.liftedBy}, ${principalRevocations.columns.liftedAt}) VALUES ($1, $2, $3, 'credentialCompromise', $2, $4)`,
			[cy, ana, revokedAt, liftedAt],
		);

	const signOutOf = (owner: pg.ClientBase, signedOutAt: Date) =>
		committedQuery(
			owner,
			`INSERT INTO ${qualified(subjectSignOuts)} (idp_issuer, idp_subject_id, signed_out_at, expires_at) VALUES ($1, $2, $3, $4)`,
			[DEFAULT_FIXTURE_ISSUER, SUBJECTS.cy, signedOutAt, new Date(signedOutAt.getTime() + 86_400_000)],
		);

	const signedOutEveryoneAt = (owner: pg.ClientBase, ana: string, signedOutAt: Date) =>
		committedQuery(
			owner,
			`INSERT INTO ${qualified(everyoneSignOuts)} (${everyoneSignOuts.columns.signedOutBy}, ${everyoneSignOuts.columns.signedOutAt}, ${everyoneSignOuts.columns.reasonCode}) VALUES ($1, $2, 'securityIncident')`,
			[ana, signedOutAt],
		);

	// The store reader the exchange reads through, over one connection of the runtime role.
	const readerOf = (client: pg.ClientBase): Parameters<typeof readStoredRefusal>[0] => ({
		query: (text, values) => client.query(text, [...(values ?? [])]),
	});

	const questionOf = (issuedAt: number | undefined) => ({
		issuer: DEFAULT_FIXTURE_ISSUER,
		session: issuedAt === undefined ? {} : { issuedAt, sid: 'session-cy' },
		subject: SUBJECTS.cy,
	});

	test('refuses a token issued during a revocation that is lifted, and one naming no iat, and accepts one issued after the lift', async (context) => {
		const { database, owner, seeded } = await openSeededDatabase(context);
		const reader = readerOf(await database.connect('runtime'));
		await revokeAndLift(owner, seededId(seeded.users, 'ana'), seededId(seeded.users, 'cy'), at(10), at(11));

		assert.equal(
			await readStoredRefusal(reader, database.schema, questionOf(secondsOf(at(10, 30)))),
			'revokedPrincipal',
		);
		assert.equal(await readStoredRefusal(reader, database.schema, questionOf(undefined)), 'revokedPrincipal');
		assert.equal(await readStoredRefusal(reader, database.schema, questionOf(secondsOf(at(11, 30)))), undefined);
	});

	test('keeps a sign-out recorded after the revocation refusing the tokens it covers once the revocation is lifted', async (context) => {
		const { database, owner, seeded } = await openSeededDatabase(context);
		const reader = readerOf(await database.connect('runtime'));
		await revokeAndLift(owner, seededId(seeded.users, 'ana'), seededId(seeded.users, 'cy'), at(10), at(11));
		await signOutOf(owner, at(11, 20));

		assert.equal(
			await readStoredRefusal(reader, database.schema, questionOf(secondsOf(at(11, 10)))),
			'signedOutSession',
		);
		assert.equal(await readStoredRefusal(reader, database.schema, questionOf(secondsOf(at(11, 30)))), undefined);
	});

	test('accepts a token issued in the second a sign-out of everyone is recorded on, and refuses one issued a second earlier', async (context) => {
		const { database, owner, seeded } = await openSeededDatabase(context);
		const reader = readerOf(await database.connect('runtime'));
		await signedOutEveryoneAt(owner, seededId(seeded.users, 'ana'), at(12));

		assert.deepEqual(
			[
				await readStoredRefusal(reader, database.schema, questionOf(secondsOf(at(12)) - 1)),
				await readStoredRefusal(reader, database.schema, questionOf(secondsOf(at(12)))),
			],
			['signedOutEveryone', undefined],
		);
	});

	test('keeps a sign-out of everyone recorded after the lift refusing the tokens issued before it', async (context) => {
		const { database, owner, seeded } = await openSeededDatabase(context);
		const reader = readerOf(await database.connect('runtime'));
		const ana = seededId(seeded.users, 'ana');
		await revokeAndLift(owner, ana, seededId(seeded.users, 'cy'), at(10), at(11));
		await signedOutEveryoneAt(owner, ana, at(11, 40));

		assert.equal(
			await readStoredRefusal(reader, database.schema, questionOf(secondsOf(at(11, 30)))),
			'signedOutEveryone',
		);
		assert.equal(await readStoredRefusal(reader, database.schema, questionOf(secondsOf(at(11, 50)))), undefined);
	});

	test('leaves the grants of the person as they were, the lift touching the revocation alone', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context);
		const cy = seededId(seeded.users, 'cy');
		const grantsOf = () =>
			selectRows<{ id: string; revokedAt: Date | null }>(
				owner,
				`SELECT id::text AS id, revoked_at AS "revokedAt" FROM ${qualified(grants)} WHERE holder_user_id = $1::uuid ORDER BY id`,
				[cy],
			);
		const before = await grantsOf();
		await revokeAndLift(owner, seededId(seeded.users, 'ana'), cy, at(10), at(11));

		assert.deepEqual(await grantsOf(), before);
	});
});

// A trail over the harness's database, its connections taken as the runtime role, with the real confirmation of the
// administrator each change runs under.
type TrailClient = pg.Client & { release(destroy?: boolean): void };

const trailOver = (harness: Harness): AuditTrail<TrailClient> => {
	const store = {
		connect: async (): Promise<TrailClient> =>
			Object.assign(await harness.database.connect('runtime'), { release: () => undefined }),
	};
	return createAuditTrail({
		confirmAuthority: confirmAdministratorAuthority({ schema: harness.database.schema }),
		eventLog: { error: () => undefined, writeEvent: () => undefined },
		settings: {
			clock: { now: () => Date.now() },
			databaseSchema: harness.database.schema,
			eventSource: 'https://usher.example.org/controller',
			instanceName: 'usher-revocation-test',
			storeTimeoutMilliseconds: 15_000,
		},
		store,
	});
};

const actorOf = (person: Person): Actor => ({ id: person.subject, type: 'human' });

// A latch a test opens once the work it holds has started, and a promise the work awaits.
const gateOf = (): { open: () => void; promise: Promise<void> } => {
	let release: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { open: () => release(), promise };
};
