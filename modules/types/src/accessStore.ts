import { deepFreeze, isFrozenData } from './plainData.js';
import { UsherContractError } from './problems.js';
import {
  type UsherRequestAccess,
  validateRequestAccess,
} from './requestAccess.js';

const ACCESS_MEMBER = 'usher';

/**
 * The wording of every rule held by {@link attachAccess} and {@link readAccess}, keyed by a stable
 * name.
 */
export const ACCESS_STORE_RULES = {
  alreadyHeld: 'the store already holds request access',
  attachedInvalid: 'request access must be valid to be attached',
  heldInvalid: 'the request access in the store is not valid',
  heldOtherwise:
    'the store holds request access only as attached by attachAccess: fixed, hidden and deeply frozen',
  noNewMember: 'the store accepts no new member',
  notHeld: 'the store holds no request access',
  storeIsObject: 'a per-request store is an object',
  storeUsable: 'a per-request store can be read and written without error',
} as const;

const isStore = (store: unknown): store is object =>
  (typeof store === 'object' && store !== null) || typeof store === 'function';

const requireStore = (store: unknown): object => {
  if (isStore(store)) {
    return store;
  }

  throw new UsherContractError(ACCESS_STORE_RULES.storeIsObject);
};

/**
 * Runs one operation on the store, turning anything it throws, such as a proxy's trap, into an
 * error naming only the rule, so no error quotes the store.
 */
const onStore = <Result>(operation: () => Result): Result => {
  try {
    return operation();
  } catch {
    throw new UsherContractError(ACCESS_STORE_RULES.storeUsable);
  }
};

/** Whether `descriptor` has the shape of the member defined by `attachAccess`. */
const isAttachedMember = (descriptor: PropertyDescriptor): boolean =>
  Object.hasOwn(descriptor, 'value') &&
  descriptor.writable === false &&
  descriptor.configurable === false &&
  descriptor.enumerable === false;

/**
 * Validates `access` and attaches a deeply frozen copy of it to `store` under `usher`, as an own
 * member that is neither writable, configurable nor enumerable, so later code can neither replace
 * it nor carry it into a template or a serialized store by spreading the store. The copy is the one
 * validated, so what is attached is exactly what passed, and the caller's object is never frozen.
 *
 * @param store the framework's per-request store, such as Express's `res.locals`.
 * @throws {UsherContractError} attaching nothing, when any of these holds:
 * - `access` is invalid;
 * - `store` already has an own `usher` member, whatever its value;
 * - `store` refuses a new member;
 * - `store` is not an object, or throws when used.
 */
export const attachAccess = (
  store: object,
  access: UsherRequestAccess,
): void => {
  const target = requireStore(store);
  const verdict = validateRequestAccess(access);

  if (verdict.success) {
    const holdsAccess = onStore(() => Object.hasOwn(target, ACCESS_MEMBER));

    if (holdsAccess) {
      throw new UsherContractError(ACCESS_STORE_RULES.alreadyHeld);
    }

    const attached = onStore(() =>
      Reflect.defineProperty(target, ACCESS_MEMBER, {
        configurable: false,
        enumerable: false,
        value: deepFreeze(verdict.access),
        writable: false,
      }),
    );

    if (attached) {
      return;
    }

    throw new UsherContractError(ACCESS_STORE_RULES.noNewMember);
  }

  throw new UsherContractError(
    ACCESS_STORE_RULES.attachedInvalid,
    verdict.problems,
  );
};

/** Frozen data is checked first, through descriptors, so no accessor inside the value ever runs. */
const heldAccess = (value: unknown): UsherRequestAccess => {
  const frozen = onStore(() => isFrozenData(value));

  if (frozen) {
    const verdict = validateRequestAccess(value);

    if (verdict.success) {
      return deepFreeze(verdict.access);
    }

    throw new UsherContractError(
      ACCESS_STORE_RULES.heldInvalid,
      verdict.problems,
    );
  }

  throw new UsherContractError(ACCESS_STORE_RULES.heldOtherwise);
};

/**
 * Returns the access attached to `store`, validated again on every read and deeply frozen. Only an
 * own `usher` member is read, and only one shaped as left by {@link attachAccess}: a value, neither
 * writable, configurable nor enumerable, holding frozen data alone, so what is read cannot change
 * after it is read. An accessor is refused without being run.
 *
 * @param store the framework's per-request store, such as Express's `res.locals`.
 * @throws {UsherContractError} when any of these holds:
 * - the store holds no access;
 * - the store holds access in any other shape;
 * - the store holds a value that is invalid or of a version other than 1;
 * - `store` is not an object, or throws when used.
 */
export const readAccess = (store: object): UsherRequestAccess => {
  const target = requireStore(store);
  const descriptor = onStore(() =>
    Reflect.getOwnPropertyDescriptor(target, ACCESS_MEMBER),
  );

  if (descriptor !== undefined && isAttachedMember(descriptor)) {
    return heldAccess(descriptor.value);
  }

  throw new UsherContractError(
    descriptor === undefined
      ? ACCESS_STORE_RULES.notHeld
      : ACCESS_STORE_RULES.heldOtherwise,
  );
};
