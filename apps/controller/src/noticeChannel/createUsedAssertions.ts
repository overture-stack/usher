import type { Clock } from '../configuration/index.js';
import type { UsedAssertions } from './types.js';

/**
 * Creates this instance's record of the channel assertions presented to the stream, each kept until
 * it stops being accepted and forgotten after, so the record holds no more than the assertions of the
 * last minute and a half. An assertion is known by its application and its `jti` together.
 *
 * @param clock the wall clock assertions' acceptance is judged on.
 */
export const createUsedAssertions = (clock: Clock): UsedAssertions => {
  const recorded = new Map<string, number>();
  return {
    record: (applicationId, id, acceptedUntil) => {
      const now = clock.now();
      [...recorded]
        .filter(([, until]) => until < now)
        .forEach(([expired]) => {
          recorded.delete(expired);
        });
      const known = `${applicationId}\n${id}`;
      if (recorded.has(known)) {
        return false;
      }
      recorded.set(known, acceptedUntil);
      return true;
    },
  };
};
