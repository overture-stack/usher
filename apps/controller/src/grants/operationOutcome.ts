import type { Actor, JsonValue } from '../eventLog/index.js';
import { ControllerError } from '../failures/index.js';
import type { Problem } from '../http/index.js';
import type { StepUpJudgement, OperationOutcome, Principal } from '../managementApi/index.js';

/**
 * An id in the form the store gives a grant's or a grant request's; any other text names neither,
 * and is never sent to the store as one.
 */
export const STORED_ID_FORM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// A refusal reached inside a change's transaction, thrown so the transaction rolls back and nothing
// of the change is written, a person first met in it included.
class RefusedWithin extends Error {
	readonly challenge: string | undefined;
	readonly problem: Problem;
	readonly recordedReason: string | undefined;

	constructor(problem: Problem, { challenge, recordedReason }: { challenge?: string; recordedReason?: string } = {}) {
		super(problem.code);
		this.challenge = challenge;
		this.problem = problem;
		this.recordedReason = recordedReason;
	}
}

/**
 * Refuses a change from inside its transaction, rolling the transaction back whole; the change's
 * outcome, read by {@link changeOutcome}, is the refusal.
 *
 * @param problem the refusal answered.
 * @param recordedReason the reason its event records, where it differs from the code answered.
 */
export const refuseWithin = (problem: Problem, recordedReason?: string): never => {
	throw new RefusedWithin(problem, recordedReason === undefined ? {} : { recordedReason });
};

/**
 * Refuses a change from inside its transaction, as {@link refuseWithin} does, unless its principal
 * stepped up recently: the refusal answers the judgement's problem with its challenge.
 *
 * @param judgement whether the principal stepped up recently, as `judgeStepUp` judges it.
 */
export const steppedUpWithin = (judgement: StepUpJudgement): void => {
	if (judgement.kind === 'refused') {
		throw new RefusedWithin(judgement.problem, { challenge: judgement.challenge });
	}
};

/** An operation's refusal, as {@link refused} gives one. */
export type RefusedOutcome = Extract<OperationOutcome, { kind: 'refused' }>;

/**
 * An operation's refusal.
 *
 * @param problem the refusal answered.
 * @param recordedReason the reason its event records, where it differs from the code answered.
 */
export const refused = (problem: Problem, recordedReason?: string): RefusedOutcome => ({
	kind: 'refused',
	problem,
	...(recordedReason === undefined ? {} : { recordedReason }),
});

/**
 * An operation's answer, which may be stored.
 *
 * @param status the answer's status.
 * @param body its JSON body, or none for an answer carrying no content.
 */
export const answered = (status: number, body: JsonValue | undefined): OperationOutcome => ({
	body,
	forbidsStoring: false,
	kind: 'answered',
	status,
});

const constraintOf = (failure: unknown): string | undefined => {
	const constraint: unknown =
		typeof failure === 'object' && failure !== null && 'constraint' in failure ? failure.constraint : undefined;
	return typeof constraint === 'string' ? constraint : undefined;
};

/**
 * A change's outcome: what its transaction gave once committed, the refusal it reached through
 * {@link refuseWithin}, or the refusal a rule the store checks answers, by the constraint the store
 * names, nothing of it written. Any other failure is thrown on, as the store's.
 *
 * @param change the change, run in its transaction.
 * @param refusedByStore the refusal each constraint the store may name answers.
 */
export const changeOutcome = <Result>(
	change: Promise<Result>,
	refusedByStore: Readonly<Record<string, Problem>> = {},
): Promise<RefusedOutcome | Result> =>
	change.catch((failure: unknown) => {
		if (failure instanceof RefusedWithin) {
			return {
				...refused(failure.problem, failure.recordedReason),
				...(failure.challenge === undefined ? {} : { challenge: failure.challenge }),
			};
		}
		const constraint = constraintOf(failure);
		const problem = constraint === undefined ? undefined : refusedByStore[constraint];
		if (problem !== undefined) {
			return refused(problem);
		}
		throw failure;
	});

/**
 * Fails a change whose grant or request names a role the store does not hold, which the store's
 * references keep from happening.
 */
export const roleMissing = (): never => {
	throw new ControllerError("the store holds no role by a grant's role name");
};

/**
 * The actor a principal is, as the audit trail names one.
 *
 * @param principal the principal.
 */
export const actorOf = ({ subject, type }: Principal): Actor => ({
	id: subject,
	type,
});
