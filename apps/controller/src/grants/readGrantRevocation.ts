import { type InputReading, readTextMembers } from '../managementApi/index.js';
import { GRANT_PROBLEMS } from './grantProblems.js';
import {
  GIVEN_REVOCATION_REASONS,
  UNSPECIFIED_REASON,
} from './revocationReasons.js';
import type { GrantRevocation } from './types.js';

/**
 * Reads a grant's revocation from its body, which is sent only with a reason: no body is the reason
 * `unspecified`. A body holding another member, lacking `reason`, or holding one that is no string,
 * is refused 400; a reason outside those a caller may give, `unspecified` and `resourceRetired`
 * among them, is refused 422 `unknownRevocationReason`.
 *
 * @param body the body's object, or none for a request sending none.
 */
export const readGrantRevocation = (
  body: Readonly<Record<string, unknown>> | undefined,
): InputReading<GrantRevocation> => {
  if (body === undefined) {
    return { input: { reason: UNSPECIFIED_REASON }, kind: 'read' };
  }
  const reading = readTextMembers(body, { reason: { required: true } });
  if (reading.kind === 'refused') {
    return reading;
  }
  const reason = reading.members['reason'] ?? '';
  return GIVEN_REVOCATION_REASONS.includes(reason)
    ? { input: { reason }, kind: 'read' }
    : { kind: 'refused', problem: GRANT_PROBLEMS.unknownRevocationReason };
};
