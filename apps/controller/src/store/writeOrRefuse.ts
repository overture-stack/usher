import pg from 'pg';

import { type StartProblem, StartRefusal } from '../failures/index.js';

const INSUFFICIENT_PRIVILEGE = '42501';

/**
 * Makes a write the start cannot go on without, refusing the start with the problem given when the
 * database role may not make it. The write is attempted only when it is needed, so a role that may only
 * read starts whenever the store already holds what the start would write.
 *
 * @param problem the variable at fault and the rule its value breaks, when the role may not write.
 * @param write the write, on the start's connection.
 * @throws {StartRefusal} carrying the problem, when the store refuses the write for want of privilege.
 */
export const writeOrRefuse = async <Result>(problem: StartProblem, write: () => Promise<Result>): Promise<Result> => {
	try {
		return await write();
	} catch (error) {
		if (error instanceof pg.DatabaseError && error.code === INSUFFICIENT_PRIVILEGE) {
			throw new StartRefusal([problem]);
		}
		throw error;
	}
};
