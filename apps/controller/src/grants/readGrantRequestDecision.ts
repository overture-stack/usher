import { type InputReading, unreadableBody } from '../managementApi/index.js';
import { GRANT_PROBLEMS } from './grantProblems.js';
import type { GrantRequestDecision } from './types.js';

const isDecision = (word: string): word is GrantRequestDecision['decision'] => word === 'granted' || word === 'refused';

/**
 * Reads a decision on a grant request from its body: an object holding `decision` alone, so a
 * member may join it later. A body holding another member, lacking `decision`, or holding one that
 * is no string, is refused 400; a decision other than `granted` or `refused`, exactly, is refused
 * 422 `unknownDecision`.
 *
 * @param body the body's object.
 */
export const readGrantRequestDecision = (
	body: Readonly<Record<string, unknown>>,
): InputReading<GrantRequestDecision> => {
	const { decision } = body;
	if (!Object.keys(body).every((name) => name === 'decision')) {
		return {
			kind: 'refused',
			problem: unreadableBody('holds a member this operation does not take: it takes decision alone'),
		};
	}
	if (typeof decision !== 'string') {
		return {
			kind: 'refused',
			problem: unreadableBody(
				decision === undefined
					? 'lacks the member decision'
					: 'holds decision as something other than a string',
			),
		};
	}
	return isDecision(decision)
		? { input: { decision }, kind: 'read' }
		: { kind: 'refused', problem: GRANT_PROBLEMS.unknownRequestDecision };
};
