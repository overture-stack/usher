import type { FieldWithVariable, RetentionDurations } from './types.js';
import { readInteger, type Reading, type Variable } from './variableReaders.js';

/** Each duration the notice retention floor is made of, as reading it gave. */
export type RetentionReadings = {
  readonly [Field in keyof RetentionDurations]: Reading<number>;
};

/**
 * Reads the durations the notice retention floor is made of, each with its default: a 300 s token
 * lifetime, a 60 s grace period and a 30 s margin. The Controller and its schema migration command
 * both read them here, so the floor the command stores is the one the Controller's own reading
 * gives.
 *
 * @param variable the variable each is read from, by field.
 */
export const readRetentionDurations = (
  variable: (field: FieldWithVariable) => Variable,
): RetentionReadings => ({
  retentionGraceSeconds: readInteger(variable('retentionGraceSeconds'), {
    fallback: 60,
    minimum: 0,
  }),
  retentionMarginSeconds: readInteger(variable('retentionMarginSeconds'), {
    fallback: 30,
    minimum: 0,
  }),
  tokenLifetimeSeconds: readInteger(variable('tokenLifetimeSeconds'), {
    fallback: 300,
    minimum: 1,
  }),
});

/**
 * The notice retention floor the durations give, in seconds: the token lifetime, plus the grace period
 * and the margin.
 *
 * @param durations the token lifetime, the grace period and the margin.
 */
export const retentionFloorSeconds = ({
  retentionGraceSeconds,
  retentionMarginSeconds,
  tokenLifetimeSeconds,
}: RetentionDurations): number =>
  tokenLifetimeSeconds + retentionGraceSeconds + retentionMarginSeconds;
