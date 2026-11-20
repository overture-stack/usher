import { performance } from 'node:perf_hooks';
import { after, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

/** Registers cleanup steps, run last first once their test or suite ends. */
export interface Cleanup {
	defer(step: () => Promise<void>): void;
}

/** The current time in whole seconds since the Unix epoch, as a token's timestamps are written. */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * Waits until a condition holds, checking it at each interval, and reports whether it held before
 * the timeout. The condition is never checked again once the wait has ended.
 *
 * @param condition the condition.
 * @param timeoutMs the most to wait.
 * @param intervalMs how often to check: every 100 ms by default.
 */
export const eventually = async (
	condition: () => Promise<boolean>,
	timeoutMs: number,
	intervalMs = 100,
): Promise<boolean> => {
	const deadline = performance.now() + timeoutMs;
	const attempt = async (): Promise<boolean> => {
		if (await condition()) {
			return true;
		}
		if (performance.now() >= deadline) {
			return false;
		}
		await delay(intervalMs);
		return attempt();
	};
	return attempt();
};

/**
 * A promise's value if it settles within a bound, `undefined` if it has not by then: how a test
 * shows that work waits, such as a second run held behind a lock. The promise itself goes on, for the
 * test to await once it has let the work go on; a rejection within the bound is thrown here.
 *
 * @param pending the promise.
 * @param milliseconds the bound.
 */
export const settledWithin = async <Value>(
	pending: Promise<Value>,
	milliseconds: number,
): Promise<Value | undefined> => {
	const bound = new AbortController();
	try {
		return await Promise.race([
			pending,
			delay(milliseconds, undefined, { signal: bound.signal }).catch(() => undefined),
		]);
	} finally {
		bound.abort();
	}
};

const runLastFirst = async (steps: readonly (() => Promise<void>)[]): Promise<void> => {
	const failures = await steps.toReversed().reduce<Promise<readonly unknown[]>>(async (earlier, step) => {
		const failed = await earlier;
		try {
			await step();
			return failed;
		} catch (error) {
			return [...failed, error];
		}
	}, Promise.resolve([]));
	if (failures.length > 0) {
		throw new AggregateError(failures, 'the cleanup did not finish cleanly');
	}
};

const registry = (register: (run: () => Promise<void>) => void): Cleanup => {
	const steps: (() => Promise<void>)[] = [];
	register(() => runLastFirst(steps));
	return {
		defer: (step) => {
			steps.push(step);
		},
	};
};

const testRegistries = new WeakMap<TestContext, Cleanup>();

/**
 * The cleanup registry of one test: each step deferred runs once the test ends, the last deferred
 * first, every step running whatever the one before it did, and every failure reported together.
 * Every call for one test gives the same registry, so steps deferred anywhere in the test, a support
 * module's included, run in one order: what started last stops first.
 *
 * @param context the test's context.
 */
export const cleanupFor = (context: TestContext): Cleanup => {
	const held = testRegistries.get(context);
	if (held !== undefined) {
		return held;
	}
	const created = registry((run) => context.after(run));
	testRegistries.set(context, created);
	return created;
};

/**
 * A cleanup registry for the suite it is called in, run once the suite's tests have ended, the last
 * deferred first. Call it in the suite's body.
 */
export const suiteCleanup = (): Cleanup => registry((run) => after(run));
