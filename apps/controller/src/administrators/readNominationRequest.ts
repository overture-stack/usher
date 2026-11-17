import { unreadableBody } from '../managementApi/index.js';
import type { NominationReading } from './types.js';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const refusedFor = (rule: string): NominationReading => ({
  kind: 'refused',
  problem: unreadableBody(rule),
});

/**
 * Reads a nomination's body strictly: exactly one member, `nominee`, an object holding exactly one
 * member, `subject`, a string, kept exactly as given. Any other shape is refused 400, the rule
 * naming what the body takes and never a value sent.
 *
 * @param body the body's object.
 */
export const readNominationRequest = (
  body: Readonly<Record<string, unknown>>,
): NominationReading => {
  const { nominee, ...others } = body;
  if (Object.keys(others).length > 0) {
    return refusedFor(
      'holds a member this operation does not take: it takes nominee alone',
    );
  }
  if (!Object.hasOwn(body, 'nominee')) {
    return refusedFor('lacks the member nominee');
  }
  if (!isRecord(nominee)) {
    return refusedFor('holds nominee as something other than an object');
  }
  const { subject, ...besides } = nominee;
  if (Object.keys(besides).length > 0) {
    return refusedFor('holds a member of nominee other than subject');
  }
  if (typeof subject !== 'string') {
    return refusedFor(
      Object.hasOwn(nominee, 'subject')
        ? "holds nominee's subject as something other than a string"
        : "lacks nominee's subject",
    );
  }
  return { input: { nomineeSubject: subject }, kind: 'read' };
};
