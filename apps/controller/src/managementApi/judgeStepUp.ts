import { CLOCK_TOLERANCE_MILLISECONDS } from '../configuration/index.js';
import { type Problem, problem } from '../http/index.js';
import type { Settings } from '../settings/index.js';
import type { Principal } from './types.js';

/** What a step-up is judged by: the level its sign-in carries, and how long it counts. */
export type StepUpSettings = Pick<Settings, 'stepUpLevel' | 'stepUpWindowSeconds'>;

/**
 * Whether a principal stepped up recently enough: stepped up, or refused with the problem answered and
 * the `WWW-Authenticate` challenge naming the level and the window to meet.
 */
export type StepUpJudgement =
	| { kind: 'steppedUp' }
	| {
			/** The `WWW-Authenticate` value, as RFC 9470 names a stronger sign-in. */
			challenge: string;

			kind: 'refused';
			problem: Problem;
	  };

const STEP_UP_TITLE = 'A recent step-up is required';

/**
 * The problem a missing or stale step-up answers: 401 `stepUpRequired`, naming the window.
 *
 * @param windowSeconds how long a step-up counts after its sign-in.
 */
export const STEP_UP_REQUIRED = (windowSeconds: number): Problem =>
	problem(
		'stepUpRequired',
		401,
		STEP_UP_TITLE,
		`This needs a sign-in at the step-up level within the last ${windowSeconds} seconds. Sign in again at that level, as WWW-Authenticate names it, then send the request again.`,
	);

/**
 * Judges whether a principal stepped up recently: their sign-in's level is the step-up level,
 * compared exactly, and its time is known and falls within the window before the instant, each edge
 * widened by {@link CLOCK_TOLERANCE_MILLISECONDS}. A missing level or time, or any other level, the
 * ordinary sign-in's included, is refused. Only the token is read, so every request within the window
 * is taken under one sign-in.
 *
 * @param principal the principal, and what their token says of their sign-in.
 * @param settings the step-up level and the window, in seconds.
 * @param now the instant, in milliseconds since the Unix epoch.
 */
export const judgeStepUp = (
	{ signIn }: Pick<Principal, 'signIn'>,
	{ stepUpLevel, stepUpWindowSeconds }: StepUpSettings,
	now: number,
): StepUpJudgement => {
	const authenticatedAt = signIn?.authenticatedAt;
	const steppedUp =
		signIn?.level === stepUpLevel &&
		authenticatedAt !== undefined &&
		authenticatedAt >= now - stepUpWindowSeconds * 1000 - CLOCK_TOLERANCE_MILLISECONDS &&
		authenticatedAt <= now + CLOCK_TOLERANCE_MILLISECONDS;
	return steppedUp
		? { kind: 'steppedUp' }
		: {
				challenge: `Bearer error="insufficient_user_authentication", error_description="${STEP_UP_TITLE}", acr_values="${stepUpLevel}", max_age=${stepUpWindowSeconds}`,
				kind: 'refused',
				problem: STEP_UP_REQUIRED(stepUpWindowSeconds),
			};
};
