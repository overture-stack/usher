import type { AuditTrail } from '../eventLog/index.js';
import { CommitUnconfirmed } from '../storeTimeout/index.js';
import type { AfterCommitLog, AfterCommitStep } from './types.js';

/** The line naming a step after a commit that failed; the change is answered as the commit left it. */
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
 * Runs steps after a commit, in turn and awaited. Nothing a step meets reaches the caller: a step that
 * throws or rejects is written to the log at error as {@link AFTER_COMMIT_FAILED}, naming the step and
 * the failure's code alone, and the next step runs, since the answer must say what the commit did.
 *
 * @param settings the steps, and where a failed step is written.
 */
export const runAfterCommit = ({
  log,
  steps,
}: {
  log: AfterCommitLog;
  steps: readonly AfterCommitStep[];
}): Promise<void> =>
  steps.reduce(
    (earlier, { name, run }) =>
      earlier.then(async () => {
        try {
          await run();
        } catch (failure) {
          log.error(AFTER_COMMIT_FAILED, { ...codeOf(failure), step: name });
        }
      }),
    Promise.resolve(),
  );

/**
 * Wraps a trail so each transaction it commits runs the steps given, as {@link runAfterCommit} runs
 * them, before its result is given back, so the instance answering a change holds what the change
 * made. A transaction whose `COMMIT` went unconfirmed runs them too, since the change may have been
 * made, and then its failure is thrown as the trail threw it; one failing otherwise runs no step, its
 * failure thrown alike. The transaction's options reach the trail as given, and events recorded outside
 * any change are recorded as the trail records them.
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
}): AuditTrail<Connection> => ({
  inTransaction: async (actor, work, options) => {
    const result = await trail
      .inTransaction(actor, work, options)
      .catch(async (failure: unknown) => {
        if (failure instanceof CommitUnconfirmed) {
          await runAfterCommit({ log, steps });
        }
        throw failure;
      });
    await runAfterCommit({ log, steps });
    return result;
  },
  recordEvent: trail.recordEvent,
});
