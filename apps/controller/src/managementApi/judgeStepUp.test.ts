import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { CLOCK_TOLERANCE_MILLISECONDS } from '../configuration/index.js';
import { STEP_UP_REQUIRED, judgeStepUp } from './judgeStepUp.js';
import type { SignIn } from './types.js';

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);

const SETTINGS = { stepUpLevel: 'confirmation', stepUpWindowSeconds: 300 };

const WINDOW_MILLISECONDS = SETTINGS.stepUpWindowSeconds * 1000;

const CHALLENGE =
	'Bearer error="insufficient_user_authentication", error_description="A recent step-up is required", acr_values="confirmation", max_age=300';

const judged = (signIn?: SignIn): ReturnType<typeof judgeStepUp> =>
	judgeStepUp(signIn === undefined ? {} : { signIn }, SETTINGS, NOW);

const steppedUpAt = (authenticatedAt: number): SignIn => ({ authenticatedAt, level: 'confirmation' });

suite('judging whether a principal stepped up recently', () => {
	test('takes a sign-in at the step-up level within the window', () => {
		assert.deepEqual(judged(steppedUpAt(NOW - 60_000)), { kind: 'steppedUp' });
	});

	test('takes a sign-in at both edges of the window, each widened by the clock tolerance', () => {
		assert.deepEqual(
			[
				judged(steppedUpAt(NOW - WINDOW_MILLISECONDS - CLOCK_TOLERANCE_MILLISECONDS)),
				judged(steppedUpAt(NOW + CLOCK_TOLERANCE_MILLISECONDS)),
			].map(({ kind }) => kind),
			['steppedUp', 'steppedUp'],
		);
	});

	test('refuses a sign-in past either edge, naming the level and the window in its challenge', () => {
		const refusals = [
			judged(steppedUpAt(NOW - WINDOW_MILLISECONDS - CLOCK_TOLERANCE_MILLISECONDS - 1000)),
			judged(steppedUpAt(NOW + CLOCK_TOLERANCE_MILLISECONDS + 1000)),
		];

		assert.deepEqual(refusals, [
			{ challenge: CHALLENGE, kind: 'refused', problem: STEP_UP_REQUIRED(300) },
			{ challenge: CHALLENGE, kind: 'refused', problem: STEP_UP_REQUIRED(300) },
		]);
	});

	test('refuses an ordinary sign-in, any other level, no level, no sign-in time, and no sign-in at all', () => {
		const refusals = [
			judged({ authenticatedAt: NOW, level: '1' }),
			judged({ authenticatedAt: NOW, level: 'Confirmation' }),
			judged({ authenticatedAt: NOW }),
			judged({ level: 'confirmation' }),
			judged(),
		];

		assert.deepEqual(
			refusals.map(({ kind }) => kind),
			['refused', 'refused', 'refused', 'refused', 'refused'],
		);
	});

	test('answers 401 stepUpRequired, naming the window and no value the request carried', () => {
		const refusal = judged();

		assert.equal(refusal.kind, 'refused');
		assert.deepEqual(refusal.kind === 'refused' ? refusal.problem : undefined, {
			code: 'stepUpRequired',
			detail: 'This needs a sign-in at the step-up level within the last 300 seconds. Sign in again at that level, as WWW-Authenticate names it, then send the request again.',
			status: 401,
			title: 'A recent step-up is required',
		});
	});

	test('names the configured level and window in the challenge', () => {
		const refusal = judgeStepUp({}, { stepUpLevel: 'mfa', stepUpWindowSeconds: 900 }, NOW);

		assert.equal(
			refusal.kind === 'refused' ? refusal.challenge : undefined,
			'Bearer error="insufficient_user_authentication", error_description="A recent step-up is required", acr_values="mfa", max_age=900',
		);
	});
});
