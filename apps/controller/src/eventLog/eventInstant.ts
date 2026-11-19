/**
 * An instant as every event and log line writes it, an event's `time` and any instant in its data
 * alike: RFC 3339 in UTC with the `Z` designator, never a numeric offset, its seconds always present
 * and followed by milliseconds.
 *
 * @param milliseconds the instant, in milliseconds since the Unix epoch.
 * @throws {RangeError} for a value no date holds.
 */
export const eventInstant = (milliseconds: number): string =>
  new Date(milliseconds).toISOString();
