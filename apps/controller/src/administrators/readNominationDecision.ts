import { type InputReading, unreadableBody } from '../managementApi/index.js';
import { ADMINISTRATOR_PROBLEMS } from './administratorProblems.js';
import type { NominationAnswer } from './types.js';

// The word a nominee sends for each answer, and the word stored for it.
const STORED_DECISION_OF_SENT = new Map<string, NominationAnswer['decision']>([
	['accept', 'accepted'],
	['decline', 'declined'],
]);

/**
 * Reads a nominee's answer to a nomination from its body: `decision`, required and alone. A body
 * holding another member, lacking the decision, or holding one that is no string is refused 400; a
 * decision other than `accept` or `decline`, exactly, is refused 422 `unknownDecision`. The decision
 * read is the stored word for the one sent, `accepted` or `declined`.
 *
 * @param body the body's object.
 */
export const readNominationDecision = (body: Readonly<Record<string, unknown>>): InputReading<NominationAnswer> => {
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
		? { kind: 'refused', problem: ADMINISTRATOR_PROBLEMS.unknownDecision }
		: { input: { decision: stored }, kind: 'read' };
};
