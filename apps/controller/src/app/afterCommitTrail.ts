import type { AuditTrail } from '../eventLog/index.js';
import type { AfterCommitLog, AfterCommitStep } from './types.js';

/** The line naming a step after a commit that failed; the committed change is answered as made. */
export const AFTER_COMMIT_FAILED = 'controller.afterCommitFailed';

// The failure by its code alone, where it carries one, since a message may quote a value.
const codeOf = (failure: unknown): Readonly<Record<string, string>> => {
  const code: unknown =
    typeof failure === 'object' && failure !== null && 'code' in failure
      ? failure.code
      : undefined;
  return typeof code === 'string' ? { code } : {};
};

/**
 * Wraps a trail so each transaction it commits runs the steps given, in turn and awaited, before its
 * result is given back, so the instance answering a change holds what the change made. Nothing a step
 * meets reaches the caller: a step that throws or rejects is written to the log at error as
 * {@link AFTER_COMMIT_FAILED}, naming the step and the failure's code alone, and the next step runs,
 * since the change has committed and its answer must say so. A transaction that fails runs no step,
 * its failure thrown as the trail threw it. The transaction's options reach the trail as given, and
 * events recorded outside any change are recorded as the trail records them.
 *
 * @param settings the trail, the steps, and where a failed step is written.
 */
export const afterCommitTrail = <Connection>({
  log,
  steps,
  trail,
}: {
  log: AfterCommitLog;
  steps: readonly AfterCommitStep[];
  trail: AuditTrail<Connection>;
}): AuditTrail<Connection> => {
  const runGuarded = async ({ name, run }: AfterCommitStep): Promise<void> => {
    try {
      await run();
    } catch (failure) {
      log.error(AFTER_COMMIT_FAILED, { ...codeOf(failure), step: name });
    }
  };
  return {
    inTransaction: async (actor, work, options) => {
      const result = await trail.inTransaction(actor, work, options);
      await steps.reduce(
        (earlier, step) => earlier.then(() => runGuarded(step)),
        Promise.resolve(),
      );
      return result;
    },
    recordEvent: trail.recordEvent,
  };
};
