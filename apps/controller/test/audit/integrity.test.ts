import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { suite, test } from 'node:test';

import {
	administratorCaller,
	assertSucceeded,
	createGrant,
	createSelfGrant,
	decideGrantRequest,
	personCaller,
	readLiveness,
	readReadiness,
	revokeGrant,
} from '../../testing/harness/admin.js';
import { refusalText, startOutcome, type StartOutcome } from '../../testing/harness/controller.js';
import { DATABASE_ROLES } from '../../testing/harness/database.js';
import { PEOPLE } from '../../testing/harness/exchange.js';
import {
	APPLICATIONS_ONLY,
	auditRows,
	auditRowsOfType,
	awaitEventWhere,
	awaitOneEvent,
	changeAuditPrivilege,
	CONTROLLED,
	eventsIn,
	exchangeBy,
	instantIn,
	liveGrantCount,
	markOf,
	namingGrant,
	RESOURCES,
	rowOf,
	withAuditHarness,
} from '../../testing/fixtures/audit.js';
import { highestPosition, inTurn, noticesAfter } from '../../testing/harness/policy.js';
import { eventually } from '../../testing/harness/waiting.js';

const SINK_FAILURE = 'the log sink refused a write for a test';

// The rule a refused start names: the audit log's privileges, however the reason spells the log.
const AUDIT_RULE = /audit/iu;

interface StartUnder {
	databasePassword: string;
	log: readonly string[];
	permitted: StartOutcome;
	privilegeChanged: StartOutcome;
}

const startsUnder = (change: 'GRANT' | 'REVOKE', privilege: 'DELETE' | 'INSERT' | 'UPDATE'): Promise<StartUnder> =>
	withAuditHarness({ fixture: APPLICATIONS_ONLY, startsController: false }, async ({ harness, log }) => {
		const permitted = await startOutcome(harness.configuration);
		const since = markOf(log);
		await changeAuditPrivilege(harness.clients.migration, change, privilege, DATABASE_ROLES.runtime);
		const privilegeChanged = await startOutcome(harness.configuration);
		return {
			databasePassword: harness.configuration.databasePassword,
			log: log.lines().slice(since),
			permitted,
			privilegeChanged,
		};
	});

const assertRefusedNamingTheRule = ({
	databasePassword: password,
	log,
	permitted,
	privilegeChanged,
}: StartUnder): void => {
	assert.equal(permitted.kind, 'started');
	assert.equal(privilegeChanged.kind, 'refused');
	const texts = [...(privilegeChanged.kind === 'refused' ? [refusalText(privilegeChanged.refusal)] : []), ...log];
	assert.ok(
		texts.some((text) => AUDIT_RULE.test(text)),
		'the refusal names the audit log rule',
	);
	assert.equal(password.length > 0 && texts.some((text) => text.includes(password)), false);
};

suite('audit integrity', () => {
	test('refuses to start while its database role may update or delete audit log rows', async () => {
		const outcomes = await inTurn(['UPDATE', 'DELETE'] as const, (privilege) => startsUnder('GRANT', privilege));

		assert.equal(outcomes.length, 2);
		outcomes.forEach(assertRefusedNamingTheRule);
	});

	test('refuses to start while its database role may not insert into the audit log', async () => {
		assertRefusedNamingTheRule(await startsUnder('REVOKE', 'INSERT'));
	});

	test('refuses a policy change it cannot record, leaving the change unmade', async () => {
		await withAuditHarness({}, async ({ harness }) => {
			const owner = await personCaller(harness, PEOPLE.owner);
			const beforeControl = await highestPosition(harness.clients.migration);
			const control = await createGrant(owner, {
				category: CONTROLLED,
				holder: { subject: PEOPLE.ana.subject },
				resource: RESOURCES.a1,
				role: 'viewer',
			});
			const controlNotices = await noticesAfter(harness.clients.migration, beforeControl);
			await changeAuditPrivilege(harness.clients.migration, 'REVOKE', 'INSERT', DATABASE_ROLES.runtime);
			const before = await highestPosition(harness.clients.migration);

			const refused = await createGrant(owner, {
				category: CONTROLLED,
				holder: { subject: PEOPLE.bo.subject },
				resource: RESOURCES.a1,
				role: 'viewer',
			});

			assertSucceeded(control, 'the recorded creation');
			assert.ok(controlNotices.length > 0, 'the recorded creation wrote a notice');
			assert.ok(refused.status >= 500, `the creation was answered ${refused.status}`);
			assert.equal(await liveGrantCount(harness.clients.migration, PEOPLE.bo.subject, RESOURCES.a1), 0);
			assert.deepEqual(await noticesAfter(harness.clients.migration, before), []);
		});
	});

	test('records each step of the tamper chain in the log stream as well as the database', async () => {
		await withAuditHarness({}, async ({ harness, log }) => {
			const administrator = await administratorCaller(harness);
			const since = markOf(log);

			const requested = await createSelfGrant(administrator, {
				category: CONTROLLED,
				expiresAt: instantIn(3_600_000),
				resource: RESOURCES.a1,
				role: 'viewer',
			});
			assertSucceeded(requested, 'the self-grant request');
			const selfGrant = await decideGrantRequest(
				await personCaller(harness, PEOPLE.owner),
				requested.grantId ?? '',
				'granted',
			);
			assertSucceeded(selfGrant, 'the approval');
			const exchanged = await exchangeBy(harness, PEOPLE.administrator);
			assertSucceeded(await revokeGrant(administrator, selfGrant.grantId ?? ''), 'the revocation');
			const chain = [
				await awaitEventWhere(log, 'grant.request', (data) => data['requestId'] === requested.grantId, {
					since,
				}),
				await awaitEventWhere(log, 'grant.requestDecision', namingGrant(selfGrant.grantId), { since }),
				await awaitOneEvent(log, 'token.exchange', { since }),
				await awaitEventWhere(log, 'grant.revocation', namingGrant(selfGrant.grantId), { since }),
			];
			const order = eventsIn(log, since).map(({ id }) => id);
			const positions = chain.map(({ id }) => order.indexOf(id));
			const rows = await auditRows(harness.clients.migration);

			assert.equal(exchanged.status, 200);
			assert.ok(positions.every((position) => position >= 0));
			assert.deepEqual(
				positions,
				positions.toSorted((first, second) => first - second),
			);
			chain.forEach((event) => {
				assert.deepEqual(rowOf(rows, event).data, event.data);
			});
		});
	});

	test('keeps serving and reports itself unready while its log stream cannot be written', async () => {
		const sink = { failing: false };
		const logStream = new Writable({
			write: (_chunk: unknown, _encoding, callback) => {
				callback(sink.failing ? new Error(SINK_FAILURE) : null);
			},
		});

		await withAuditHarness({ configuration: { logStream } }, async ({ harness }) => {
			const readyBefore = await readReadiness(harness.url);
			const storedBefore = (await auditRowsOfType(harness.clients.migration, 'token.exchange')).length;
			sink.failing = true;

			const served = await exchangeBy(harness, PEOPLE.ana);
			const unready = await eventually(async () => (await readReadiness(harness.url)).status === 503, 10_000);
			const readyAfter = await readReadiness(harness.url);
			const alive = await readLiveness(harness.url);
			const servedAgain = await exchangeBy(harness, PEOPLE.bo);
			const storedAfter = (await auditRowsOfType(harness.clients.migration, 'token.exchange')).length;

			assert.equal(readyBefore.status, 200);
			assert.equal(served.status, 200);
			assert.ok(unready, 'the controller reported itself unready');
			assert.equal(readyAfter.status, 503);
			assert.equal(readyAfter.text.includes(SINK_FAILURE), false);
			assert.equal(readyAfter.problem?.detail, undefined);
			assert.equal(alive.status, 503);
			assert.equal(servedAgain.status, 200);
			assert.equal(storedAfter, storedBefore + 2);
		});
	});
});
