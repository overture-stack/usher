import type pg from 'pg';

import { ENVIRONMENT_VARIABLES } from '../configuration/index.js';
import type { StartProblem } from '../startRefusal.js';

/** The limits the store applies to a session, each of which the controller sets to its store timeout. */
export const STATEMENT_LIMITS: readonly string[] = Object.freeze([
  'idle_in_transaction_session_timeout',
  'statement_timeout',
]);

/** One limit as the store reports it for a session: its name, its value, and the unit it counts in. */
export interface StatementLimit {
  name: string;

  /** The value, as text, in {@link StatementLimit.unit}. */
  setting: string;

  unit: string | null;
}

// Each unit the store may report a time in, in milliseconds; a value in any other counts as no limit
// the controller set.
const UNIT_MILLISECONDS: ReadonlyMap<string, number> = new Map([
  ['d', 86_400_000],
  ['h', 3_600_000],
  ['min', 60_000],
  ['ms', 1],
  ['s', 1000],
]);

const UNAPPLIED: StartProblem = {
  rule: "names a connection on which the store does not apply the controller's statement limits, as a connection pooler that drops startup parameters does",
  variable: ENVIRONMENT_VARIABLES.databaseUrl,
};

const millisecondsOf = ({ setting, unit }: StatementLimit): number =>
  Number(setting) * (UNIT_MILLISECONDS.get(unit ?? '') ?? Number.NaN);

/**
 * Reads the limits the store applies to the session of the connection given, as `pg_settings`
 * reports them.
 *
 * @param connection the connection whose session is read.
 */
export const readStatementLimits = async (
  connection: pg.ClientBase,
): Promise<readonly StatementLimit[]> =>
  (
    await connection.query<StatementLimit>(
      'SELECT name, setting, unit FROM pg_catalog.pg_settings WHERE name = ANY($1::text[])',
      [[...STATEMENT_LIMITS]],
    )
  ).rows;

/**
 * The rule broken when the store does not apply both of the controller's limits to a session, each
 * equal to the store timeout once read in milliseconds, whatever unit the store reports: none when it
 * does, and otherwise one naming the database URL, since a connection that drops the limits leaves a
 * statement whose client has gone holding its locks.
 *
 * @param limits the limits read from the session.
 * @param storeTimeoutMilliseconds the store timeout.
 */
export const statementLimitProblems = (
  limits: readonly StatementLimit[],
  storeTimeoutMilliseconds: number,
): readonly StartProblem[] =>
  STATEMENT_LIMITS.every((name) =>
    limits.some(
      (limit) =>
        limit.name === name &&
        millisecondsOf(limit) === storeTimeoutMilliseconds,
    ),
  )
    ? []
    : [UNAPPLIED];
