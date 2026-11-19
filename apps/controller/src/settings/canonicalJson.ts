const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> => {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const prototype: unknown = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
};

// The value with every object's keys sorted, refusing any value JSON cannot hold.
const sortedValue = (value: unknown): unknown => {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'number') {
		if (Number.isFinite(value)) {
			return value;
		}
		throw new TypeError('cannot be canonicalized: a number JSON cannot hold, which is not finite');
	}
	if (Array.isArray(value)) {
		return value.map(sortedValue);
	}
	if (isPlainObject(value)) {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, sortedValue(value[key])]),
		);
	}
	throw new TypeError('cannot be canonicalized: a value JSON cannot hold, which is not a plain JSON value');
};

/**
 * Writes a value as its canonical JSON text: every object's keys sorted at every depth, and the JSON
 * otherwise as `JSON.stringify` writes it, with no whitespace. For strings, finite numbers, booleans,
 * null, arrays and plain objects, that is the form RFC 8785 (JSON Canonicalization Scheme) defines, since
 * its numbers are ECMAScript's `Number.prototype.toString`, which `JSON.stringify` uses. The sorting
 * compares keys by their UTF-16 code units, as RFC 8785 does.
 *
 * Throws a `TypeError` on what JSON cannot hold: a non-finite number, `undefined` (at any depth, as an
 * object's member too), a function, or an object that is not plain, such as a `Date`, a `Map` or a class
 * instance. The message names the kind of value, never the value itself.
 *
 * @param value the value to write.
 * @returns the canonical JSON text.
 * @throws {TypeError} on a value JSON cannot hold.
 */
export const canonicalJson = (value: unknown): string => JSON.stringify(sortedValue(value));
