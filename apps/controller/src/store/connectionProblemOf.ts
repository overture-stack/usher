import { ENVIRONMENT_VARIABLES } from '../configuration/index.js';
import type { StartProblem } from '../failures/index.js';
import type { ConnectionVariables } from './types.js';

// The Controller's own: its runtime role's URL and password.
const CONTROLLER_CONNECTION: ConnectionVariables = {
	passwordVariable: ENVIRONMENT_VARIABLES.databasePassword,
	urlVariable: ENVIRONMENT_VARIABLES.databaseUrl,
};

// Each failure to connect a start or a migration run can meet, by its code, a system error's or a
// SQLSTATE, as the rule it breaks. Each code here arises only in reaching the store and signing in,
// never from a statement sent. A refused password may be the password's fault or the role's, since the store
// answers the same for a role it does not hold: the password is named, and its rule names the role.
const connectionProblems = ({
	passwordVariable,
	urlVariable,
}: ConnectionVariables): ReadonlyMap<string, StartProblem> => {
	const unansweringAddress: StartProblem = {
		rule: 'names an address at which no store accepts connections',
		variable: urlVariable,
	};
	const unresolvedHost: StartProblem = {
		rule: 'names a host that does not resolve',
		variable: urlVariable,
	};
	const unreachableHost: StartProblem = {
		rule: 'names a host that cannot be reached',
		variable: urlVariable,
	};
	return new Map([
		[
			'28000',
			{
				rule: 'names a database role the store does not let connect to that database from this host',
				variable: urlVariable,
			},
		],
		[
			'28P01',
			{
				rule: `is not the password of the database role ${urlVariable} names, or that role does not exist`,
				variable: passwordVariable,
			},
		],
		[
			'3D000',
			{
				rule: 'names a database the store does not hold',
				variable: urlVariable,
			},
		],
		['EAI_AGAIN', unresolvedHost],
		['ECONNREFUSED', unansweringAddress],
		['EHOSTUNREACH', unreachableHost],
		['ENETUNREACH', unreachableHost],
		['ENOENT', unansweringAddress],
		['ENOTFOUND', unresolvedHost],
	]);
};

/**
 * The rule a start or a migration run broke when the store could not be reached or signed in to, by
 * the failure's code, naming the variable at fault and never its value; none for any other failure.
 *
 * @param failure what the start or the run met.
 * @param variables the variables the connection was read from: the Controller's own by default.
 */
export const connectionProblemOf = (
	failure: unknown,
	variables: ConnectionVariables = CONTROLLER_CONNECTION,
): StartProblem | undefined => {
	const code: unknown =
		typeof failure === 'object' && failure !== null && 'code' in failure ? failure.code : undefined;
	return typeof code === 'string' ? connectionProblems(variables).get(code) : undefined;
};
