import { type InputReading, unreadableBody } from '../managementApi/index.js';
import { GRANT_PROBLEMS } from './grantProblems.js';
import type { GrantAnswer } from './types.js';

const isDecision = (word: string): word is GrantAnswer['decision'] =>
  word === 'accepted' || word === 'rejected';

/**
 * Reads a holder's answer to a grant from its body: `decision` and `capabilities`, each required. A
 * body holding another member, lacking either, or holding a decision that is no string or
 * capabilities that are no list of strings, is refused 400; a decision other than `accepted` or
 * `rejected`, exactly, is refused 422 `unknownDecision`. Whether the capabilities are the role's is
 * judged once the grant is read.
 *
 * @param body the body's object.
 */
export const readGrantAnswer = (
  body: Readonly<Record<string, unknown>>,
): InputReading<GrantAnswer> => {
  const { capabilities, decision } = body;
  if (
    !Object.keys(body).every(
      (name) => name === 'capabilities' || name === 'decision',
    )
  ) {
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
  if (
    !Array.isArray(capabilities) ||
    !capabilities.every((capability) => typeof capability === 'string')
  ) {
    return {
      kind: 'refused',
      problem: unreadableBody(
        capabilities === undefined
          ? 'lacks the member capabilities'
          : 'holds capabilities as something other than a list of strings',
      ),
    };
  }
  return isDecision(decision)
    ? { input: { capabilities, decision }, kind: 'read' }
    : { kind: 'refused', problem: GRANT_PROBLEMS.unknownDecision };
};
