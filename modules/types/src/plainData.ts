/** A map read from plain data: its own keys, each paired with its value. */
export type PlainEntries = readonly (readonly [key: string, value: unknown])[];

/**
 * How many levels a snapshot copies. It is twice SQON's own depth limit, which is the deepest value
 * any validator here accepts, so everything a validator accepts is copied whole.
 */
const SNAPSHOT_DEPTH = 256;

const hasPlainPrototype = (value: object): boolean => {
  const prototype: object | null = Object.getPrototypeOf(value);

  return prototype === null || Object.getPrototypeOf(prototype) === null;
};

/**
 * Whether `value` is a plain object, as made by an object literal, `JSON.parse` or
 * `Object.create(null)` in any realm: an object other than a list whose prototype is `null` or has
 * a `null` prototype of its own. `null`, a list, a `Map` and an instance of an ordinary class are
 * refused. An object inheriting directly from any other null-prototype object, such as
 * `Object.create(Object.create(null))` or an instance of a class extending `null`, passes.
 */
export const isPlainRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  hasPlainPrototype(value);

/**
 * The value of `record`'s own member `key`, or `undefined` when it has none, even when a prototype,
 * `Object.prototype` included, carries one.
 */
export const ownMember = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): unknown => (Object.hasOwn(record, key) ? record[key] : undefined);

/**
 * The own entries of a plain record, non-enumerable ones included, or `undefined` when `value` is
 * not a plain record or carries a symbol key, which no JSON value does. Every key a lookup could
 * reach is listed, `__proto__` and `constructor` included.
 */
export const ownEntries = (value: unknown): PlainEntries | undefined => {
  if (isPlainRecord(value)) {
    const keys = Reflect.ownKeys(value);

    return keys.every((key): key is string => typeof key === 'string')
      ? keys.map((key) => [key, value[key]] as const)
      : undefined;
  }

  return undefined;
};

/**
 * The entries of a list, or `undefined` when `value` is not one. A hole in a sparse list is read as
 * `undefined`, so no check skips it as `every` or `flatMap` would.
 */
export const listEntries = (value: unknown): readonly unknown[] | undefined =>
  Array.isArray(value) ? Array.from(value) : undefined;

/**
 * Whether every own key of `record` is one of `members`. A symbol key never is.
 *
 * @param members the names allowed as keys of `record`.
 */
export const hasOnlyMembers = (
  record: Readonly<Record<string, unknown>>,
  members: ReadonlySet<string>,
): boolean =>
  Reflect.ownKeys(record).every(
    (key) => typeof key === 'string' && members.has(key),
  );

/**
 * Whether `key` can name an entry of a map read from plain data: never the empty string, which
 * names nothing, and never `__proto__`, read as the prototype rather than as a key by an assignment
 * into an ordinary object.
 *
 * @param key a key read from the input.
 */
export const isUsableKey = (key: string): boolean =>
  key.length > 0 && key !== '__proto__';

/**
 * Whether `value` is a string that can name something. The empty string names nothing anywhere in
 * these contracts.
 */
export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const snapshotAt = (value: unknown, depth: number): unknown => {
  if (depth < SNAPSHOT_DEPTH) {
    const entries = listEntries(value);

    if (entries !== undefined) {
      return entries.map((entry) => snapshotAt(entry, depth + 1));
    }

    const members = ownEntries(value);

    if (members !== undefined) {
      return Object.fromEntries(
        members.map(([key, member]) => [key, snapshotAt(member, depth + 1)]),
      );
    }
  }

  return value;
};

/**
 * A copy of `value`'s own data, each member read once, whatever getters, proxies or prototypes are
 * carried by the original. Lists and plain records are copied, every own member and nothing
 * inherited, and a `__proto__` key stays an own member of the copy. Anything else, and anything
 * nested at least twice SQON's depth limit below `value`, is kept as it is rather than copied.
 * Throws whatever reading `value` throws.
 */
export const plainSnapshot = (value: unknown): unknown => snapshotAt(value, 0);

/**
 * Freezes `value` and, recursively, the values of its enumerable string-keyed members, and returns
 * `value`. Anything other than an object is returned as it is. It assumes acyclic data, since a
 * cycle recurses until the stack overflows. A getter among those members runs, and an error it
 * throws is not caught.
 */
export const deepFreeze = <Value>(value: Value): Value => {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }

  return value;
};

/**
 * Whether `value` and everything reachable from it is frozen and holds data members only, so it
 * reads the same every time. An accessor member is never run.
 */
export const isFrozenData = (value: unknown): boolean =>
  typeof value === 'object' && value !== null
    ? Object.isFrozen(value) &&
      Object.values(Object.getOwnPropertyDescriptors(value)).every(
        (descriptor) =>
          Object.hasOwn(descriptor, 'value') && isFrozenData(descriptor.value),
      )
    : true;
