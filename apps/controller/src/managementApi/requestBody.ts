import type { Problem } from '../http/index.js';
import { PROBLEMS, unreadableBody } from './problems.js';
import { readStrictJson } from './readStrictJson.js';

/** What reading a request's body gave: none, one JSON object, or the refusal it earned. */
export type BodyReading =
  | { kind: 'absent' }
  | { kind: 'object'; value: Readonly<Record<string, unknown>> }
  | { kind: 'refused'; problem: Problem };

/** What reading an object's text members gave: the members sent, by name, or the refusal they earned. */
export type MembersReading =
  | { kind: 'read'; members: Readonly<Partial<Record<string, string>>> }
  | { kind: 'refused'; problem: Problem };

const JSON_MEDIA_TYPE = 'application/json';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// JSON in UTF-8, the one encoding RFC 8259 allows: a charset parameter naming any other is refused.
const isJson = (contentType: string | undefined): boolean => {
  const [mediaType = '', ...parameters] = (contentType ?? '').split(';');
  return (
    mediaType.trim().toLowerCase() === JSON_MEDIA_TYPE &&
    parameters.every((parameter) => {
      const [name = '', value = ''] = parameter.split('=');
      return (
        name.trim().toLowerCase() !== 'charset' ||
        value.trim().replaceAll('"', '').toLowerCase() === 'utf-8'
      );
    })
  );
};

const decoded = (bytes: Uint8Array): string | undefined => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

/**
 * Reads a request's body as one JSON object: an empty body is none; any other must be
 * `application/json` in UTF-8, refused 415 otherwise, and is refused 400 unless it is valid UTF-8 and
 * JSON holding one object, naming no member twice and none `__proto__`.
 *
 * @param bytes the body as received, or none.
 * @param contentType the request's `content-type`.
 */
export const readJsonBody = (
  bytes: Uint8Array | undefined,
  contentType: string | undefined,
): BodyReading => {
  if (bytes === undefined || bytes.length === 0) {
    return { kind: 'absent' };
  }
  if (!isJson(contentType)) {
    return { kind: 'refused', problem: PROBLEMS.unsupportedMediaType };
  }
  const text = decoded(bytes);
  if (text === undefined) {
    return { kind: 'refused', problem: unreadableBody('is not UTF-8') };
  }
  const reading = readStrictJson(text);
  if (reading.kind === 'refused') {
    return { kind: 'refused', problem: unreadableBody(reading.rule) };
  }
  return isRecord(reading.value)
    ? { kind: 'object', value: reading.value }
    : { kind: 'refused', problem: unreadableBody('is not one JSON object') };
};

/**
 * Reads an object's members, each a string: a member it lacks that is required, one of another type,
 * or one it does not take is refused 400, the rule naming the members it takes and never one sent.
 *
 * @param object the body's object.
 * @param members each member taken, and whether it is required.
 */
export const readTextMembers = <Name extends string>(
  object: Readonly<Record<string, unknown>>,
  members: Readonly<Record<Name, { required: boolean }>>,
): MembersReading => {
  const names = Object.keys(members).toSorted();
  const isTaken = (name: string): name is Name => Object.hasOwn(members, name);
  if (!Object.keys(object).every(isTaken)) {
    return {
      kind: 'refused',
      problem: unreadableBody(
        `holds a member this operation does not take: it takes ${names.join(' and ')} alone`,
      ),
    };
  }
  const missing = names.find(
    (name) =>
      isTaken(name) && members[name].required && !Object.hasOwn(object, name),
  );
  if (missing !== undefined) {
    return {
      kind: 'refused',
      problem: unreadableBody(`lacks the member ${missing}`),
    };
  }
  const mistyped = Object.keys(object).find(
    (name) => typeof object[name] !== 'string',
  );
  if (mistyped !== undefined) {
    return {
      kind: 'refused',
      problem: unreadableBody(
        `holds ${mistyped} as something other than a string`,
      ),
    };
  }
  return {
    kind: 'read',
    members: Object.fromEntries(
      Object.entries(object).flatMap(([name, value]) =>
        isTaken(name) && typeof value === 'string' ? [[name, value]] : [],
      ),
    ),
  };
};
