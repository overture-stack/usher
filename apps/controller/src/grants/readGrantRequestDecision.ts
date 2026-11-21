import { type InputReading, unreadableBody } from '../managementApi/index.js';
import { GRANT_PROBLEMS } from './grantProblems.js';
import type { GrantRequestDecision } from './types.js';

// The word a decider sends for each decision, and the word stored, answered and shown for it.
const STORED_DECISION_OF_SENT = new Map<string, GrantRequestDecision['decision']>([
	['decline', 'declined'],
	['grant', 'granted'],
]);

/**
 * Reads a decision on a grant request from its body: an object holding `decision` alone, so a
 * member may join it later. A body holding another member, lacking `decision`, or holding one that
 * is no string, is refused 400; a decision other than `grant` or `decline`, exactly, is refused 422
 * `unknownDecision`. The decision read is the stored word for the one sent, `granted` or `declined`.
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
	const stored = STORED_DECISION_OF_SENT.get(decision);
	return stored === undefined
		? { kind: 'refused', problem: GRANT_PROBLEMS.unknownRequestDecision }
		: { input: { decision: stored }, kind: 'read' };
};
