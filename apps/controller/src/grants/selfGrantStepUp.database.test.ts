import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	type AdminResponse,
	administratorCaller,
	changeGrantExpiry,
	STEP_UP_LEVEL,
	steppedUpSignIn,
	createSelfGrant,
	personCaller,
	readSettings,
	updateSettings,
} from '../../testing/harness/admin.js';
import { AUDIT_EVENT_TYPES, auditRows, dataOf, emittedType } from '../../testing/harness/auditEvents.js';
import { CAST, grantsFixture, HOUR_MS, OPEN_STUDY, selfGrantUntil } from '../../testing/fixtures/grants.js';
import { type Harness, withHarness } from '../../testing/harness/harness.js';
import { eventually } from '../../testing/harness/waiting.js';

const CHALLENGE = `Bearer error="insufficient_user_authentication", error_description="A recent step-up is required", acr_values="${STEP_UP_LEVEL}", max_age=300`;

// The clock tolerance a step-up's window is widened by, in seconds.
const TOLERANCE_SECONDS = 30;

const inHours = (hours: number): string => new Date(Date.now() + hours * HOUR_MS).toISOString();

const refusalOf = ({ headers, problem, status }: AdminResponse): readonly unknown[] => [
	status,
	problem?.code,
	headers.get('www-authenticate'),
];

const settingIn = ({ body }: AdminResponse, name: string): unknown =>
	typeof body === 'object' && body !== null ? (body as Readonly<Record<string, unknown>>)[name] : undefined;

const deniedSelfCreations = async (harness: Harness): Promise<readonly unknown[]> =>
	(await auditRows(harness.clients.migration))
		.filter((row) => row.type === emittedType(AUDIT_EVENT_TYPES.grantSelfCreation))
		.map(dataOf)
		.filter((data) => data['result'] === 'denied')
		.map((data) => data['reason']);

suite('a self-grant issued at once, needing a recent step-up', () => {
	test("refuses a counted owner's self-grant 401 stepUpRequired with its challenge when they signed in at the ordinary level, writing nothing, and grants it once they step up", async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const terms = selfGrantUntil(inHours(2));

			const refused = await createSelfGrant(await personCaller(harness, CAST.ownerOfA1), terms);
			const granted = await createSelfGrant(
				await personCaller(harness, CAST.ownerOfA1, { mint: steppedUpSignIn() }),
				terms,
			);

			assert.deepEqual(refusalOf(refused), [401, 'stepUpRequired', CHALLENGE]);
			assert.equal(granted.status, 201);
			assert.deepEqual(await deniedSelfCreations(harness), ['stepUpRequired']);
		});
	});

	test("refuses the only live administrator's self-grant on a resource with no counted owner alike, and grants it once they step up", async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const terms = selfGrantUntil(inHours(2), { resource: OPEN_STUDY });

			const refused = await createSelfGrant(await administratorCaller(harness), terms);
			const granted = await createSelfGrant(
				await administratorCaller(harness, { mint: steppedUpSignIn() }),
				terms,
			);

			assert.deepEqual(refusalOf(refused), [401, 'stepUpRequired', CHALLENGE]);
			assert.equal(granted.status, 201);
		});
	});

	test('refuses a step-up older than the window, and one naming no sign-in time', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const terms = selfGrantUntil(inHours(2));
			const stale = steppedUpSignIn(300 + TOLERANCE_SECONDS + 5);

			const answers = [
				await createSelfGrant(await personCaller(harness, CAST.ownerOfA1, { mint: stale }), terms),
				await createSelfGrant(
					await personCaller(harness, CAST.ownerOfA1, { mint: { claims: { acr: STEP_UP_LEVEL } } }),
					terms,
				),
			];

			assert.deepEqual(answers.map(refusalOf), [
				[401, 'stepUpRequired', CHALLENGE],
				[401, 'stepUpRequired', CHALLENGE],
			]);
		});
	});

	test('takes one step-up for every change within the window', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const owner = await personCaller(harness, CAST.ownerOfA1, { mint: steppedUpSignIn() });

			const granted = await createSelfGrant(owner, selfGrantUntil(inHours(2)));
			const extended = await changeGrantExpiry(owner, granted.grantId ?? '', inHours(3));

			assert.deepEqual([granted.status, extended.status], [201, 200]);
		});
	});

	test("leaves a platform administrator's self-grant asked as a request unjudged, while another live administrator could approve it", async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			await administratorCaller(harness, { person: CAST.secondAdministrator });

			const asked = await createSelfGrant(
				await administratorCaller(harness),
				selfGrantUntil(inHours(2), { resource: OPEN_STUDY }),
			);

			assert.equal(asked.status, 202);
		});
	});

	test('refuses a counted owner extending a grant they hold unless they stepped up, and holds no one ending it earlier to that', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const granted = await createSelfGrant(
				await personCaller(harness, CAST.ownerOfA1, { mint: steppedUpSignIn() }),
				selfGrantUntil(inHours(2)),
			);
			const signedIn = await personCaller(harness, CAST.ownerOfA1);
			const grantId = granted.grantId ?? '';

			const answers = [
				await changeGrantExpiry(signedIn, grantId, inHours(3)),
				await changeGrantExpiry(signedIn, grantId, inHours(1)),
				await changeGrantExpiry(
					await personCaller(harness, CAST.ownerOfA1, { mint: steppedUpSignIn() }),
					grantId,
					inHours(3),
				),
			];

			assert.deepEqual(answers.map(refusalOf), [
				[401, 'stepUpRequired', CHALLENGE],
				[200, undefined, null],
				[200, undefined, null],
			]);
		});
	});
});

suite("an administrator's own grant, which no step-up lets them widen", () => {
	test('refuses the only live administrator extending the grant their self-grant issued 403 selfWideningNotPermitted, stepped up or not', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const steppedUp = await administratorCaller(harness, { mint: steppedUpSignIn() });
			const granted = await createSelfGrant(steppedUp, selfGrantUntil(inHours(2), { resource: OPEN_STUDY }));
			const grantId = granted.grantId ?? '';

			const answers = [
				await changeGrantExpiry(steppedUp, grantId, inHours(3)),
				await changeGrantExpiry(await administratorCaller(harness), grantId, inHours(3)),
			];

			assert.equal(granted.status, 201);
			assert.deepEqual(
				answers.map(({ problem, status }) => [status, problem?.code]),
				[
					[403, 'selfWideningNotPermitted'],
					[403, 'selfWideningNotPermitted'],
				],
			);
		});
	});
});

suite("the step-up's settings", () => {
	test('judges by the window as an administrator changes it', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const terms = selfGrantUntil(inHours(2));
			const tooOld = 400 + TOLERANCE_SECONDS;
			const before = await createSelfGrant(
				await personCaller(harness, CAST.ownerOfA1, { mint: steppedUpSignIn(tooOld) }),
				terms,
			);

			const changed = await updateSettings(await administratorCaller(harness), {
				stepUpWindowSeconds: 600,
			});
			await eventually(
				async () =>
					(
						await createSelfGrant(
							await personCaller(harness, CAST.ownerOfA1, { mint: steppedUpSignIn(tooOld) }),
							terms,
						)
					).status === 201,
				10_000,
			);

			assert.deepEqual(refusalOf(before), [401, 'stepUpRequired', CHALLENGE]);
			assert.equal(changed.status, 200);
		});
	});

	test('answers the level and the window, and refuses a change of the level, which is fixed after the first run', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const administrator = await administratorCaller(harness);

			const read = await readSettings(administrator);
			const refused = await updateSettings(administrator, { stepUpLevel: 'another-level' });

			assert.deepEqual(
				[settingIn(read, 'stepUpLevel'), settingIn(read, 'stepUpWindowSeconds')],
				[STEP_UP_LEVEL, 300],
			);
			assert.equal(refused.status, 400);
		});
	});
});
