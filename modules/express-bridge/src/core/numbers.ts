/**
 * Returns the value when it is a positive whole number, the form of every bound and interval inside
 * the core.
 *
 * @param what what the number is, for the error's fixed text.
 * @throws {RangeError} naming `what`, never the value, for anything else.
 */
export const positiveWhole = (value: number, what: string): number => {
  if (Number.isSafeInteger(value) && value > 0) {
    return value;
  }

  throw new RangeError(`${what} is a positive whole number`);
};
