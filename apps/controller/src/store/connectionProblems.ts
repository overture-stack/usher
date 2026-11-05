import { ENVIRONMENT_VARIABLES } from '../configuration/index.js';
import type { StartProblem } from '../startRefusal.js';

const { databasePassword, databaseUrl } = ENVIRONMENT_VARIABLES;

const UNANSWERING_ADDRESS: StartProblem = {
  rule: 'names an address at which no store accepts connections',
  variable: databaseUrl,
};

const UNRESOLVED_HOST: StartProblem = {
  rule: 'names a host that does not resolve',
  variable: databaseUrl,
};

const UNREACHABLE_HOST: StartProblem = {
  rule: 'names a host that cannot be reached',
  variable: databaseUrl,
};

// Each failure to connect a start can meet, by its code, a system error's or a SQLSTATE, as the rule
// it breaks. Each code here arises only in reaching the store and signing in, never from a statement
// the start sends. A refused password may be the password's fault or the role's, since the store
// answers the same for a role it does not hold: the password is named, and its rule names the role.
const CONNECTION_PROBLEMS: ReadonlyMap<string, StartProblem> = new Map([
  [
    '28000',
    {
      rule: 'names a database role the store does not let connect to that database from this host',
      variable: databaseUrl,
    },
  ],
  [
    '28P01',
    {
      rule: `is not the password of the database role ${databaseUrl} names, or that role does not exist`,
      variable: databasePassword,
    },
  ],
  [
    '3D000',
    { rule: 'names a database the store does not hold', variable: databaseUrl },
  ],
  ['EAI_AGAIN', UNRESOLVED_HOST],
  ['ECONNREFUSED', UNANSWERING_ADDRESS],
  ['EHOSTUNREACH', UNREACHABLE_HOST],
  ['ENETUNREACH', UNREACHABLE_HOST],
  ['ENOENT', UNANSWERING_ADDRESS],
  ['ENOTFOUND', UNRESOLVED_HOST],
]);

/**
 * The rule a start broke when the store could not be reached or signed in to, by the failure's code,
 * naming the variable at fault and never its value; none for any other failure.
 *
 * @param failure what the start met.
 */
export const connectionProblemOf = (
  failure: unknown,
): StartProblem | undefined => {
  const code: unknown =
    typeof failure === 'object' && failure !== null && 'code' in failure
      ? failure.code
      : undefined;
  return typeof code === 'string' ? CONNECTION_PROBLEMS.get(code) : undefined;
};
