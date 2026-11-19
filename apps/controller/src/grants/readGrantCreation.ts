import type { Problem } from '../http/index.js';
import { type InputReading, unreadableBody } from '../managementApi/index.js';
import { GRANT_PROBLEMS } from './grantProblems.js';
import { readHolder } from './readHolder.js';
import type { GrantCreation } from './types.js';

// The members a creation takes, each held as a string but the holder, an object; `fieldCategory`
// and `grantedBy` are known so a body naming either breaks a rule rather than its shape.
const TEXT_MEMBERS = ['category', 'expiresAt', 'resource', 'role'] as const;

const TAKEN = [
  ...TEXT_MEMBERS,
  'fieldCategory',
  'grantedBy',
  'holder',
].toSorted();

const TAKEN_NAMED = `${TAKEN.slice(0, -1).join(', ')} and ${TAKEN.at(-1) ?? ''}`;

const REQUIRED = ['holder', 'resource', 'role'] as const;

// An RFC 3339 instant with an offset: a date, `T`, a time with whole seconds and any fraction, and
// `Z` or an offset in hours and minutes.
const INSTANT = new RegExp(
  [
    String.raw`^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})`,
    String.raw`T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.\d+)?`,
    String.raw`(?:Z|[+-](?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$`,
  ].join(''),
  'u',
);

const refused = (problem: Problem): InputReading<never> => ({
  kind: 'refused',
  problem,
});

const shapeProblem = (
  body: Readonly<Record<string, unknown>>,
): Problem | undefined => {
  if (!Object.keys(body).every((name) => TAKEN.includes(name))) {
    return unreadableBody(
      `holds a member this operation does not take: it takes ${TAKEN_NAMED} alone`,
    );
  }
  const missing = REQUIRED.find((name) => !Object.hasOwn(body, name));
  if (missing !== undefined) {
    return unreadableBody(`lacks the member ${missing}`);
  }
  const mistyped = TEXT_MEMBERS.find(
    (name) => Object.hasOwn(body, name) && typeof body[name] !== 'string',
  );
  return mistyped === undefined
    ? undefined
    : unreadableBody(`holds ${mistyped} as something other than a string`);
};

// The instant a text names, or undefined for text that is no RFC 3339 instant with an offset or
// names a day, an hour or an offset there is not.
const instantOf = (text: string): Date | undefined => {
  const groups = INSTANT.exec(text)?.groups;
  if (groups === undefined) {
    return undefined;
  }
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = [
    groups['year'],
    groups['month'],
    groups['day'],
    groups['hour'],
    groups['minute'],
    groups['second'],
    groups['offsetHour'],
    groups['offsetMinute'],
  ].map((part) => Number(part ?? '0'));
  const written = new Date(
    Date.UTC(year ?? 0, (month ?? 0) - 1, day ?? 0, hour ?? 0, minute ?? 0),
  );
  const holdsDay =
    written.getUTCFullYear() === year &&
    written.getUTCMonth() === (month ?? 0) - 1 &&
    written.getUTCDate() === day;
  const inRange = [
    [hour, 24],
    [minute, 60],
    [second, 60],
    [offsetHour, 24],
    [offsetMinute, 60],
  ].every(([value = 0, bound = 0]) => value < bound);
  return holdsDay && inRange ? new Date(Date.parse(text)) : undefined;
};

/**
 * Reads a grant's creation from its body. The body is first read by its shape alone, refused 400: a
 * member other than `category`, `expiresAt`, `fieldCategory`, `grantedBy`, `holder`, `resource` and
 * `role`; `holder`, `resource` or `role` missing; `category`, `expiresAt`, `resource` or `role`
 * holding anything but a string; a holder that is no object, or names its subject or address as
 * anything but a string. Its rules are then judged in turn, each refused 422: a `grantedBy`,
 * whatever it holds; a `fieldCategory`, whatever it holds; a holder naming other than exactly one
 * person; an address out of an address's form; the `admin` role, which nobody grants; an `owner`
 * grant naming a category, or naming an expiry, `ownerGrantsDoNotExpire`, whatever its form; an
 * expiry that is no RFC 3339 instant with an offset, `Z` or `±hh:mm`, or names a day, an hour or an
 * offset there is not; and an expiry at or before the configured instant. Every text is kept
 * exactly as given.
 *
 * @param body the body's object.
 * @param now the configured clock's instant, in milliseconds since the Unix epoch.
 */
export const readGrantCreation = (
  body: Readonly<Record<string, unknown>>,
  now: number,
): InputReading<GrantCreation> => {
  const shape = shapeProblem(body);
  if (shape !== undefined) {
    return refused(shape);
  }
  const text = (name: (typeof TEXT_MEMBERS)[number]): string | undefined => {
    const value = body[name];
    return typeof value === 'string' ? value : undefined;
  };
  const holder = readHolder(body['holder'], 'holder');
  if (holder.kind === 'refused' && holder.problem.status === 400) {
    return holder;
  }
  if (Object.hasOwn(body, 'grantedBy')) {
    return refused(GRANT_PROBLEMS.grantedByNotTaken);
  }
  if (Object.hasOwn(body, 'fieldCategory')) {
    return refused(GRANT_PROBLEMS.fieldCategoryNotTaken);
  }
  if (holder.kind === 'refused') {
    return holder;
  }
  const role = text('role') ?? '';
  const category = text('category');
  const expiry = text('expiresAt');
  if (role === 'admin') {
    return refused(GRANT_PROBLEMS.administratorRoleNotGranted);
  }
  if (role === 'owner' && category !== undefined) {
    return refused(GRANT_PROBLEMS.wholeResourceRole);
  }
  if (role === 'owner' && expiry !== undefined) {
    return refused(GRANT_PROBLEMS.ownerGrantsDoNotExpire);
  }
  const expiresAt = expiry === undefined ? undefined : instantOf(expiry);
  if (expiry !== undefined && expiresAt === undefined) {
    return refused(GRANT_PROBLEMS.expiryNotAnInstant);
  }
  if (expiresAt !== undefined && expiresAt.getTime() <= now) {
    return refused(GRANT_PROBLEMS.expiryPassed);
  }
  return {
    input: {
      category,
      expiresAt,
      holder: holder.holder,
      resource: text('resource') ?? '',
      role,
    },
    kind: 'read',
  };
};
