import { type InputReading, unreadableBody } from '../managementApi/index.js';
import { GRANT_PROBLEMS } from './grantProblems.js';
import type { GrantAnswer } from './types.js';

// The word a holder sends for each answer, and the word stored, answered and shown for it.
const STORED_DECISION_OF_SENT = new Map<string, GrantAnswer['decision']>([
	['accept', 'accepted'],
	['decline', 'declined'],
]);

/**
 * Reads a holder's answer to a grant from its body: `decision` and `capabilities`, each required. A
 * body holding another member, lacking either, or holding a decision that is no string or
 * capabilities that are no list of strings, is refused 400; a decision other than `accept` or
 * `decline`, exactly, is refused 422 `unknownDecision`. The decision read is the stored word for the
 * one sent, `accepted` or `declined`. Whether the capabilities are the role's is judged once the grant
 * is read.
 *
 * @param body the body's object.
 */
export const readGrantAnswer = (body: Readonly<Record<string, unknown>>): InputReading<GrantAnswer> => {
	const { capabilities, decision } = body;
	if (!Object.keys(body).every((name) => name === 'capabilities' || name === 'decision')) {
		return {
			kind: 'refused',
			problem: unreadableBody(
				'holds a member this operation does not take: it takes capabilities and decision alone',
			),
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
	if (!Array.isArray(capabilities) || !capabilities.every((capability) => typeof capability === 'string')) {
		return {
			kind: 'refused',
			problem: unreadableBody(
				capabilities === undefined
					? 'lacks the member capabilities'
					: 'holds capabilities as something other than a list of strings',
			),
		};
	}
	const stored = STORED_DECISION_OF_SENT.get(decision);
	return stored === undefined
		? { kind: 'refused', problem: GRANT_PROBLEMS.unknownDecision }
		: { input: { capabilities, decision: stored }, kind: 'read' };
};
