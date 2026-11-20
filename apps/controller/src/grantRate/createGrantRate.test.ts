import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import pg from 'pg';

import type { AuditEvent, AuditTransaction } from '../eventLog/index.js';
import { createGrantRate } from './createGrantRate.js';
import type { GrantRateSettings } from './types.js';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0, 250);

const ISSUER = 'https://auth.example.org/realms/usher';

const SUBJECT = 'subject-ana';

const SOURCE_IP = '203.0.113.17';

const THRESHOLD = Object.freeze({ operationCount: 3, windowSeconds: 30 });

// The live settings the grant rate reads: the clock and the issuer as fixed, the threshold as given.
const settingsWith = (grantRateThreshold: GrantRateSettings['grantRateThreshold']): GrantRateSettings => ({
	clock: { now: () => NOW },
	databaseSchema: 'usher',
	grantRateThreshold,
	identityProviderIssuer: ISSUER,
});

interface Statement {
	text: string;
	values: readonly unknown[] | undefined;
}

interface Counting {
	recorded: AuditEvent[];
	statements: Statement[];
}

// Counts one operation on a connection answering that the actor performed `earlier` operations
// within the window before it, keeping each statement and each event recorded.
const countWith = async (earlier: number, settings: GrantRateSettings = settingsWith(THRESHOLD)): Promise<Counting> => {
	const counting: Counting = { recorded: [], statements: [] };
	const query = async (text: string, values?: readonly unknown[]) => {
		counting.statements.push({ text, values });
		return { rows: text.includes('count(') ? [{ earlier }] : [] };
	};
	const transaction: AuditTransaction<pg.ClientBase> = {
		// A client that never connects, its query answered here: the client's overloads are more than
		// a fake can spell out.
		connection: Object.assign(new pg.Client(), { query }),
		record: async (event) => {
			counting.recorded.push(event);
			return 'event-id';
		},
	};
	await createGrantRate(settings).count(transaction, { sourceIp: SOURCE_IP, subject: SUBJECT });
	return counting;
};

suite("the grant rate's count", () => {
	test("takes the actor's lock, keyed by their subject, in a statement of its own before it counts", async () => {
		const { statements } = await countWith(0);

		const [lock, counted, ...beyond] = statements;
		assert.match(lock?.text ?? '', /^SELECT pg_advisory_xact_lock\(/u);
		assert.equal(lock?.values?.includes(SUBJECT), true);
		assert.doesNotMatch(lock?.text ?? '', /grant_operations/u);
		assert.match(counted?.text ?? '', /"usher"\."grant_operations"/u);
		assert.deepEqual(beyond, []);
	});

	test("counts the operation under the trusted issuer at the configured clock's instant, kept until the window has passed, beside the actor's operations since the window began", async () => {
		const { statements } = await countWith(0);

		assert.deepEqual(statements[1]?.values, [
			ISSUER,
			SUBJECT,
			new Date(NOW),
			new Date(NOW + THRESHOLD.windowSeconds * 1000),
			new Date(NOW - THRESHOLD.windowSeconds * 1000),
		]);
	});

	test("records grant.rateExceeded at warning, naming the count, the window and the address of the request counted, when the actor's operations before this one number exactly the threshold", async () => {
		const { recorded } = await countWith(THRESHOLD.operationCount);

		assert.deepEqual(recorded, [
			{
				data: {
					operationCount: THRESHOLD.operationCount + 1,
					sourceIp: SOURCE_IP,
					windowSeconds: THRESHOLD.windowSeconds,
				},
				severity: 'warning',
				type: 'grant.rateExceeded',
			},
		]);
	});

	test("records nothing while the actor's operations before this one number fewer or more than the threshold", async () => {
		const recorded = await Promise.all(
			[0, THRESHOLD.operationCount - 1, THRESHOLD.operationCount + 1, THRESHOLD.operationCount + 5].map(
				async (earlier) => (await countWith(earlier)).recorded,
			),
		);

		assert.deepEqual(recorded, [[], [], [], []]);
	});

	test('reads the threshold at each count, so a change to the settings applies at the next count', async () => {
		const settings = settingsWith({ operationCount: 3, windowSeconds: 30 });
		const grantRate = createGrantRate(settings);
		const recorded: AuditEvent[] = [];
		const transaction: AuditTransaction<pg.ClientBase> = {
			connection: Object.assign(new pg.Client(), {
				query: async () => ({ rows: [{ earlier: 3 }] }),
			}),
			record: async (event) => {
				recorded.push(event);
				return 'event-id';
			},
		};

		settings.grantRateThreshold = { operationCount: 5, windowSeconds: 30 };
		await grantRate.count(transaction, { sourceIp: SOURCE_IP, subject: SUBJECT });

		assert.deepEqual(recorded, []);
	});
});
