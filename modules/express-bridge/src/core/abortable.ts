/**
 * Settles as `work` does, or rejects with an `Error` whose message is `aborted` as soon as `signal`
 * aborts, whether or not the work heeds the signal. The work's own later rejection is absorbed, so
 * it is never left unhandled.
 *
 * @param work what is awaited, already started.
 */
export const untilAborted = <Value>(
  signal: AbortSignal,
  work: Promise<Value>,
): Promise<Value> =>
  new Promise((resolve, reject) => {
    const aborted = (): void => reject(new Error('aborted'));
    if (signal.aborted) {
      aborted();
    }
    signal.addEventListener('abort', aborted, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', aborted));
  });
