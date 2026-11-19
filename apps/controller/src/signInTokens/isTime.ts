/**
 * Whether a claim holds a time: a finite number, in seconds since the Unix epoch.
 *
 * @param value the claim's value.
 */
export const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
