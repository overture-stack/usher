import { BlockList, isIP } from 'node:net';

import type { StartProblem } from '../failures/index.js';

/** One environment variable as an environment gives it: its name, and its value or none. */
export interface Variable {
  name: string;
  value: string | undefined;
}

/**
 * What reading one variable gave: its value, or the rule its value broke. A refused reading names the
 * variable and the rule alone, never the value.
 */
export type Reading<Value> =
  { kind: 'read'; value: Value } | { kind: 'refused'; problem: StartProblem };

/** The protocols a PostgreSQL connection URL may name. */
const DATABASE_PROTOCOLS: readonly string[] = ['postgres:', 'postgresql:'];

const MISSING = 'is missing';

// The form of every key the controller reads: 32 bytes, in the one encoding that gives them back.
const CANONICAL_KEY = /^[A-Za-z0-9_-]{43}$/u;

const WHOLE_NUMBER = /^\d+$/u;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  '[::1]',
  'localhost',
]);

/**
 * A reading of a value.
 *
 * @param value the value read.
 */
export const read = <Value>(value: Value): Reading<Value> => ({
  kind: 'read',
  value,
});

/**
 * A refused reading, naming the variable and the rule its value broke.
 *
 * @param variable the variable read.
 * @param rule the rule, worded to follow the variable's name.
 */
export const refused = <Value>(
  { name }: Variable,
  rule: string,
): Reading<Value> => ({ kind: 'refused', problem: { rule, variable: name } });

/**
 * Reads on from a reading's value, passing a refusal through as it is.
 *
 * @param reading the reading so far.
 * @param next what reads on from its value.
 */
export const then = <From, To>(
  reading: Reading<From>,
  next: (value: From) => Reading<To>,
): Reading<To> => (reading.kind === 'read' ? next(reading.value) : reading);

/**
 * Reads text, as given: the default when the variable is unset, and an empty value refused unless
 * allowed.
 *
 * @param variable the variable.
 * @param options whether an empty value is allowed, and the default, without which an unset variable
 *   is refused.
 */
export const readText = (
  variable: Variable,
  {
    emptyAllowed = false,
    fallback,
  }: { emptyAllowed?: boolean; fallback?: string } = {},
): Reading<string> => {
  const { value } = variable;
  if (value === undefined) {
    return fallback === undefined ? refused(variable, MISSING) : read(fallback);
  }
  return value === '' && !emptyAllowed
    ? refused(variable, 'is empty')
    : read(value);
};

const isCanonicalKey = (text: string): boolean => {
  const bytes = Buffer.from(text, 'base64url');
  try {
    return (
      CANONICAL_KEY.test(text) &&
      bytes.length === 32 &&
      bytes.toString('base64url') === text
    );
  } finally {
    bytes.fill(0);
  }
};

/**
 * Reads a key: 32 bytes as 43 base64url characters in canonical form, the form of an application
 * key. Whitespace around it is left out, since it is never part of a key and a pasted value often
 * carries it; whitespace inside it is refused.
 *
 * @param variable the variable.
 */
export const readKey = (variable: Variable): Reading<string> =>
  then(readText(variable, { emptyAllowed: true }), (text) => {
    const key = text.trim();
    return isCanonicalKey(key)
      ? read(key)
      : refused(
          variable,
          'is not 32 bytes as 43 base64url characters in canonical form',
        );
  });

/**
 * Reads a whole number within bounds.
 *
 * @param variable the variable.
 * @param bounds the least and the greatest number allowed, the greatest none by default, and the
 *   default, without which an unset variable is refused.
 */
export const readInteger = (
  variable: Variable,
  {
    fallback,
    maximum = Number.MAX_SAFE_INTEGER,
    minimum,
  }: { fallback?: number; maximum?: number; minimum: number },
): Reading<number> => {
  const { value } = variable;
  if (value === undefined) {
    return fallback === undefined ? refused(variable, MISSING) : read(fallback);
  }
  const number = WHOLE_NUMBER.test(value) ? Number(value) : Number.NaN;
  if (Number.isSafeInteger(number) && number >= minimum && number <= maximum) {
    return read(number);
  }
  return refused(
    variable,
    maximum === Number.MAX_SAFE_INTEGER
      ? `is not a whole number of at least ${minimum}`
      : `is not a whole number from ${minimum} to ${maximum}`,
  );
};

/**
 * Reads a comma-separated list, each entry with the whitespace around it left out: an empty value is
 * an empty list, and an empty entry is refused.
 *
 * @param variable the variable.
 * @param fallback the list when the variable is unset; without one, an unset variable is refused.
 */
export const readList = (
  variable: Variable,
  fallback?: readonly string[],
): Reading<readonly string[]> => {
  const { value } = variable;
  if (value === undefined) {
    return fallback === undefined ? refused(variable, MISSING) : read(fallback);
  }
  if (value === '') {
    return read([]);
  }
  const entries = value.split(',').map((entry) => entry.trim());
  return entries.includes('')
    ? refused(variable, 'holds an empty entry between its commas')
    : read(entries);
};

// A CIDR prefix length: a whole number with no sign and no leading zero.
const PREFIX_LENGTH = /^(?:0|[1-9]\d{0,2})$/u;

// The bits an address of each IP version holds, by the version `isIP` names.
const ADDRESS_BITS: Readonly<Record<number, number>> = { 4: 32, 6: 128 };

// The first and last IPv4 addresses in their IPv6 form, which an IPv4 client is matched in against
// an IPv6 range.
const MAPPED_IPV4_BOUNDS: readonly string[] = [
  '::ffff:0.0.0.0',
  '::ffff:255.255.255.255',
];

interface AddressRange {
  address: string;
  prefix: number;
  version: number;
}

// An entry written as a CIDR range, or undefined for one that is not.
const rangeOf = (entry: string): AddressRange | undefined => {
  const [address = '', prefix = '', ...rest] = entry.split('/');
  const version = isIP(address);
  const bits = ADDRESS_BITS[version];
  return rest.length === 0 &&
    bits !== undefined &&
    PREFIX_LENGTH.test(prefix) &&
    Number(prefix) <= bits
    ? { address, prefix: Number(prefix), version }
    : undefined;
};

// Whether a range holds every address of an IP version: prefix length 0, or an IPv6 range holding
// every IPv4 address in its IPv6 form, which `::ffff:0:0/96` does.
const holdsAVersion = ({ address, prefix, version }: AddressRange): boolean => {
  if (prefix === 0) {
    return true;
  }
  if (version !== 6) {
    return false;
  }
  const range = new BlockList();
  range.addSubnet(address, prefix, 'ipv6');
  return MAPPED_IPV4_BOUNDS.every((bound) => range.check(bound, 'ipv6'));
};

/**
 * Reads a comma-separated list of IP addresses and CIDR ranges, such as `10.42.0.0/16`; none by
 * default. A range holding every address of an IP version, of prefix length 0 or an IPv6 range
 * holding every IPv4 address in its IPv6 form, such as `::ffff:0:0/96`, would take every client of
 * that version for a proxy, letting any of them name its own address, so it is refused.
 *
 * @param variable the variable.
 */
export const readAddresses = (variable: Variable): Reading<readonly string[]> =>
  then(readList(variable, []), (entries) => {
    const ranges = entries.map(rangeOf);
    if (
      !entries.every(
        (entry, index) => isIP(entry) !== 0 || ranges[index] !== undefined,
      )
    ) {
      return refused(
        variable,
        'holds an entry that is neither an IP address nor a CIDR range',
      );
    }
    return ranges.some((range) => range !== undefined && holdsAVersion(range))
      ? refused(
          variable,
          'holds a range of every address of an IP version, which would let any client name its own address',
        )
      : read(entries);
  });

/**
 * Whether a URL carries a password, in its user information or as a `password` parameter, either of
 * which a PostgreSQL client would use.
 *
 * @param url the URL.
 */
const carriesPassword = (url: URL): boolean =>
  url.password !== '' || url.searchParams.has('password');

/**
 * Reads a store's connection URL, which never carries the store's password: a URL is the kind of
 * value that ends up in a log or an error, so the password is read from a variable of its own.
 *
 * @param variable the variable.
 * @param rules the variable the password is read from, and the protocols allowed, any by default.
 */
export const readStoreUrl = (
  variable: Variable,
  {
    passwordVariable,
    protocols,
  }: { passwordVariable: string; protocols?: readonly string[] },
): Reading<string> =>
  then(readText(variable), (text) => {
    const url = URL.parse(text);
    if (url === null) {
      return refused(variable, 'is not a URL');
    }
    if (carriesPassword(url)) {
      return refused(
        variable,
        `carries a password, which is read from ${passwordVariable} alone`,
      );
    }
    return protocols === undefined || protocols.includes(url.protocol)
      ? read(text)
      : refused(
          variable,
          `is not a URL whose protocol is one of ${protocols.join(', ')}`,
        );
  });

// The user information as the driver decodes it; one that does not decode names no role it can read.
const decodedUser = (username: string): string => {
  try {
    return decodeURIComponent(username);
  } catch {
    return '';
  }
};

// The role a PostgreSQL URL names as the driver reads it: its last `user` parameter, else its user
// information, an empty value counting as none in either, so empty when it names none.
const roleNamedBy = (url: URL): string =>
  url.searchParams.getAll('user').at(-1) || decodedUser(url.username);

/** How the role the controller connects as is named by the refusal of a URL naming no role. */
export const CONTROLLER_ROLE_DESCRIPTION =
  'the role the controller connects as';

/** What reading a PostgreSQL connection URL is told: the variable its password is read from, and the role it must name. */
export interface DatabaseUrlRules {
  /** The variable the role's password is read from, which the refusal of a URL carrying one names. */
  passwordVariable: string;

  /** The role the URL must name, as the refusal of a URL naming none words it, such as `the schema migration role`. */
  roleDescription: string;
}

interface DatabaseConnection {
  role: string;
  url: string;
}

// The URL was read by readStoreUrl, which takes only text that parses as a URL.
const readDatabaseConnection = (
  variable: Variable,
  { passwordVariable, roleDescription }: DatabaseUrlRules,
): Reading<DatabaseConnection> =>
  then(
    readStoreUrl(variable, { passwordVariable, protocols: DATABASE_PROTOCOLS }),
    (url) => {
      const role = roleNamedBy(new URL(url));
      return role === ''
        ? refused(
            variable,
            `names no database role; it must name ${roleDescription}`,
          )
        : read({ role, url });
    },
  );

/**
 * Reads a PostgreSQL connection URL as {@link readStoreUrl} reads a store's, which must name the
 * database role it connects as, in its user information or as a `user` parameter, either of which
 * the driver uses. Left to the driver, a URL naming none connects as `PGUSER` or as the process's own
 * user, neither of which a deployment states.
 *
 * @param variable the variable.
 * @param rules the variable the password is read from, and the role the URL must name.
 */
export const readDatabaseUrl = (
  variable: Variable,
  rules: DatabaseUrlRules,
): Reading<string> =>
  then(readDatabaseConnection(variable, rules), ({ url }) => read(url));

/**
 * Reads the database role a PostgreSQL connection URL names, as the driver reads it, the URL refused
 * as {@link readDatabaseUrl} refuses it. Nothing else of the URL is kept.
 *
 * @param variable the variable.
 * @param rules the variable the password is read from, and the role the URL must name.
 */
export const readDatabaseRole = (
  variable: Variable,
  rules: DatabaseUrlRules,
): Reading<string> =>
  then(readDatabaseConnection(variable, rules), ({ role }) => read(role));

/**
 * Reads the URL of something the controller trusts or sends a secret to: https, or http to a loopback
 * host, where nothing it carries crosses a network in the clear, and carrying no password, as no URL
 * the controller holds does.
 *
 * @param variable the variable.
 */
export const readSecureUrl = (variable: Variable): Reading<string> =>
  then(readText(variable), (text) => {
    const url = URL.parse(text);
    if (url !== null && carriesPassword(url)) {
      return refused(variable, 'carries a password');
    }
    return url !== null &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)))
      ? read(text)
      : refused(
          variable,
          'is not an https URL, or an http URL to a loopback host',
        );
  });
