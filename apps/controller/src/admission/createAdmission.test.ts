import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { admissionShare } from './admissionShare.js';
import { createAdmission } from './createAdmission.js';
import type { Admission, Admitted, ExchangeKind } from './types.js';

const SEARCH = 'application-search';

const PORTAL = 'application-portal';

/** Work the test settles itself, as an exchange's store work settles once the store answers. */
interface HeldWork {
	/** Whether the work was begun. */
	begun(): boolean;

	fail(failure: Error): void;
	finish(): void;
	work: () => Promise<string>;
}

const heldWork = (): HeldWork => {
	const state: {
		begun: boolean;
		settle: { fail: (failure: Error) => void; finish: () => void };
	} = {
		begun: false,
		settle: { fail: () => undefined, finish: () => undefined },
	};
	const settled = new Promise<string>((resolve, reject) => {
		state.settle = {
			fail: reject,
			finish: () => {
				resolve('done');
			},
		};
	});
	return {
		begun: () => state.begun,
		fail: (failure) => {
			state.settle.fail(failure);
		},
		finish: () => {
			state.settle.finish();
		},
		work: () => {
			state.begun = true;
			return settled;
		},
	};
};

const finishedWork = async (): Promise<string> => 'done';

interface Stand {
	admission: Admission;

	/** Sets how many applications are registered, as the instance holds them. */
	register(count: number): void;
}

// An admission over an exchange pool of the size given, with the applications given registered until
// the test registers more or fewer.
const standUp = ({ poolSize, registered }: { poolSize: number; registered: number }): Stand => {
	const state = { registered };
	return {
		admission: createAdmission({
			poolSize,
			registeredCount: () => state.registered,
		}),
		register: (count) => {
			state.registered = count;
		},
	};
};

const kindOf = (admitted: Admitted<unknown>): Admitted<unknown>['kind'] => admitted.kind;

// Takes places for an application, one per work given, each held until the test settles it.
const holding = (
	admission: Admission,
	applicationId: string,
	kind: ExchangeKind,
	works: readonly HeldWork[],
): Promise<Admitted<string>>[] => works.map(({ work }) => admission.within(applicationId, kind, work));

const heldWorks = (count: number): readonly HeldWork[] => Array.from({ length: count }, heldWork);

const finishAll = (works: readonly HeldWork[]): void => {
	works.forEach(({ finish }) => {
		finish();
	});
};

suite("an instance's admission", () => {
	test("admits an application's exchanges within its share whatever the pool holds, another application having borrowed every connection", async () => {
		// Two applications registered over four connections: a share of two each.
		const { admission } = standUp({ poolSize: 4, registered: 2 });
		const portalWorks = heldWorks(4);
		const searchWorks = heldWorks(2);

		const portal = holding(admission, PORTAL, 'credential', portalWorks);
		const inFlightOnceBorrowed = admission.inFlight();
		const search = holding(admission, SEARCH, 'credential', searchWorks);
		const pastSearchShare = await admission.within(SEARCH, 'credential', finishedWork);
		finishAll([...portalWorks, ...searchWorks]);

		assert.equal(inFlightOnceBorrowed, 4);
		assert.deepEqual((await Promise.all([...portal, ...search])).map(kindOf), [
			'admitted',
			'admitted',
			'admitted',
			'admitted',
			'admitted',
			'admitted',
		]);
		assert.equal(pastSearchShare.kind, 'overShare');
	});

	test("lends an idle connection past an application's share while the exchanges in flight number fewer than the pool's connections, and refuses the next at once once they reach it, without beginning its work", async () => {
		const { admission } = standUp({ poolSize: 4, registered: 2 });
		const borrowing = heldWorks(4);
		const refused = heldWork();

		const admitted = holding(admission, SEARCH, 'credential', borrowing);
		const overShare = await admission.within(SEARCH, 'credential', refused.work);
		finishAll(borrowing);

		assert.deepEqual((await Promise.all(admitted)).map(kindOf), ['admitted', 'admitted', 'admitted', 'admitted']);
		assert.deepEqual(overShare, { kind: 'overShare' });
		assert.equal(refused.begun(), false);
	});

	test('counts its exchanges in flight in the same turn as each admission and each settlement, before any await', async () => {
		const { admission } = standUp({ poolSize: 4, registered: 2 });
		const works = heldWorks(3);

		const admitted = holding(admission, SEARCH, 'credential', works);
		const inFlightAtOnce = admission.inFlight();
		finishAll(works);
		await Promise.all(admitted);
		const inFlightOnceSettled = admission.inFlight();

		assert.deepEqual([inFlightAtOnce, inFlightOnceSettled], [3, 0]);
	});

	test('sizes the share by the registered count as it stands at each admission', async () => {
		const stand = standUp({ poolSize: 4, registered: 2 });
		const { admission } = stand;
		const portalWorks = heldWorks(1);
		const searchWorks = heldWorks(3);

		// Alone, the search application's share is the whole pool.
		stand.register(1);
		const portal = holding(admission, PORTAL, 'credential', portalWorks);
		const whileAlone = holding(admission, SEARCH, 'credential', searchWorks);
		stand.register(4);
		const onceFourAreRegistered = await admission.within(SEARCH, 'credential', finishedWork);
		finishAll([...portalWorks, ...searchWorks]);
		const admittedWhileAlone = await Promise.all([...portal, ...whileAlone]);
		const afterTheyEnd = await admission.within(SEARCH, 'credential', finishedWork);

		assert.deepEqual(admittedWhileAlone.map(kindOf), ['admitted', 'admitted', 'admitted', 'admitted']);
		assert.equal(onceFourAreRegistered.kind, 'overShare');
		assert.equal(afterTheyEnd.kind, 'admitted');
	});

	test('releases its place once the work resolves, so the next exchange is admitted', async () => {
		const { admission } = standUp({ poolSize: 1, registered: 1 });
		const first = heldWork();

		const admitting = admission.within(SEARCH, 'credential', first.work);
		const whileHeld = await admission.within(SEARCH, 'credential', finishedWork);
		first.finish();
		await admitting;
		const afterwards = await admission.within(SEARCH, 'credential', finishedWork);

		assert.equal(whileHeld.kind, 'overShare');
		assert.deepEqual(afterwards, { kind: 'admitted', result: 'done' });
		assert.equal(admission.inFlight(), 0);
	});

	test('releases its place once the work rejects, passing the failure on', async () => {
		const { admission } = standUp({ poolSize: 1, registered: 1 });
		const failing = heldWork();
		const failure = new Error('the store refused the statement');

		const admitting = admission.within(SEARCH, 'credential', failing.work);
		failing.fail(failure);
		await assert.rejects(admitting, failure);
		const afterwards = await admission.within(SEARCH, 'credential', finishedWork);

		assert.equal(afterwards.kind, 'admitted');
		assert.equal(admission.inFlight(), 0);
	});

	test('releases its place when the work throws before returning a promise, passing the failure on', async () => {
		const { admission } = standUp({ poolSize: 1, registered: 1 });
		const failure = new TypeError('the work could not begin');

		await assert.rejects(
			admission.within(SEARCH, 'anonymous', () => {
				throw failure;
			}),
			failure,
		);
		const afterwards = [
			await admission.within(SEARCH, 'credential', finishedWork),
			await admission.within(SEARCH, 'anonymous', finishedWork),
		];

		assert.deepEqual(afterwards.map(kindOf), ['admitted', 'admitted']);
		assert.equal(admission.inFlight(), 0);
	});

	suite('an anonymous exchange past a full share, the pool contended', () => {
		// Two applications registered over two connections: a share of one each. The search
		// application's credential exchanges fill its share and borrow the other connection.
		const contended = (): {
			admission: Admission;
			filling: readonly HeldWork[];
			recording: Promise<Admitted<string>>[];
		} => {
			const { admission } = standUp({ poolSize: 2, registered: 2 });
			const filling = heldWorks(2);
			return {
				admission,
				filling,
				recording: holding(admission, SEARCH, 'credential', filling),
			};
		};

		test('is admitted while its application has no other anonymous exchange in flight, and a second one is refused while the first is', async () => {
			const { admission, filling, recording } = contended();
			const lane = heldWork();

			const admittedPastShare = admission.within(SEARCH, 'anonymous', lane.work);
			const second = await admission.within(SEARCH, 'anonymous', finishedWork);
			finishAll([...filling, lane]);

			assert.equal(lane.begun(), true);
			assert.deepEqual(await admittedPastShare, {
				kind: 'admitted',
				result: 'done',
			});
			assert.equal(second.kind, 'overShare');
			await Promise.all(recording);
		});

		test('is refused while another anonymous exchange of its application is in flight within the share', async () => {
			const { admission } = standUp({ poolSize: 2, registered: 2 });
			const anonymousHeld = heldWork();
			const credentialHeld = heldWork();

			const admitted = [
				admission.within(SEARCH, 'anonymous', anonymousHeld.work),
				admission.within(SEARCH, 'credential', credentialHeld.work),
			];
			const pastShare = await admission.within(SEARCH, 'anonymous', finishedWork);
			finishAll([anonymousHeld, credentialHeld]);

			assert.deepEqual((await Promise.all(admitted)).map(kindOf), ['admitted', 'admitted']);
			assert.equal(pastShare.kind, 'overShare');
		});

		test('leaves a credential exchange refused, the lane taken or not', async () => {
			const { admission, filling, recording } = contended();
			const lane = heldWork();

			const beforeTheLane = await admission.within(SEARCH, 'credential', finishedWork);
			const admittedPastShare = admission.within(SEARCH, 'anonymous', lane.work);
			const withTheLaneTaken = await admission.within(SEARCH, 'credential', finishedWork);
			finishAll([...filling, lane]);
			await Promise.all([...recording, admittedPastShare]);

			assert.deepEqual([beforeTheLane, withTheLaneTaken].map(kindOf), ['overShare', 'overShare']);
		});

		test('is admitted again once the anonymous exchange admitted past the share has ended, however that ended', async () => {
			const { admission, filling, recording } = contended();
			const failingLane = heldWork();

			const failing = admission.within(SEARCH, 'anonymous', failingLane.work);
			failingLane.fail(new Error('the store refused the statement'));
			await assert.rejects(failing);
			const afterwards = await admission.within(SEARCH, 'anonymous', finishedWork);
			finishAll(filling);
			await Promise.all(recording);

			assert.equal(afterwards.kind, 'admitted');
		});

		test("is admitted past one application's full share while another application's anonymous exchange is in flight", async () => {
			const { admission, filling, recording } = contended();
			const portalAnonymous = heldWork();

			const portal = admission.within(PORTAL, 'anonymous', portalAnonymous.work);
			const pastShare = await admission.within(SEARCH, 'anonymous', finishedWork);
			finishAll([...filling, portalAnonymous]);
			await Promise.all([...recording, portal]);

			assert.equal(pastShare.kind, 'admitted');
		});
	});

	suite('its exchanges in flight', () => {
		test('never number more than the pool, the shares and one lane per application together, with one application borrowing the whole pool, every other filling its share and every lane taken', async () => {
			const poolSize = 10;
			const applications = ['search', 'portal', 'catalogue', 'submission'];
			const { admission } = standUp({
				poolSize,
				registered: applications.length,
			});
			const share = admissionShare(poolSize, applications.length);
			const bound = poolSize + share * applications.length + applications.length;
			const observed: number[] = [];
			const take = (
				applicationId: string,
				kind: ExchangeKind,
			): { admitted: Promise<Admitted<string>>; work: HeldWork } => {
				const work = heldWork();
				const admitted = admission.within(applicationId, kind, work.work);
				observed.push(admission.inFlight());
				return { admitted, work };
			};
			const [borrower = '', ...others] = applications;

			// The borrower first, so it takes every connection while the pool is idle: its share, then the
			// rest of the pool past it.
			const borrowed = Array.from({ length: poolSize }, () => take(borrower, 'credential'));
			const shares = others.flatMap((applicationId) =>
				Array.from({ length: share }, () => take(applicationId, 'credential')),
			);
			const lanes = applications.map((applicationId) => take(applicationId, 'anonymous'));
			const atTheWorstCase = admission.inFlight();
			// One more of each kind for every application, each refused at once.
			const further = applications.flatMap((applicationId) => [
				take(applicationId, 'credential'),
				take(applicationId, 'anonymous'),
			]);
			const taken = [...borrowed, ...shares, ...lanes, ...further];
			finishAll(taken.map(({ work }) => work));
			const answers = await Promise.all(taken.map(({ admitted }) => admitted));

			assert.equal(share, 2);
			assert.equal(bound, 22);
			assert.ok(bound <= 2 * poolSize + applications.length);
			assert.equal(atTheWorstCase, poolSize + share * others.length + applications.length);
			assert.ok(
				observed.every((inFlight) => inFlight <= bound),
				`in flight at most ${Math.max(...observed)} against ${bound}`,
			);
			assert.deepEqual(answers.map(kindOf), [
				...borrowed.map(() => 'admitted'),
				...shares.map(() => 'admitted'),
				...lanes.map(() => 'admitted'),
				...further.map(() => 'overShare'),
			]);
			assert.equal(admission.inFlight(), 0);
		});
	});
});
