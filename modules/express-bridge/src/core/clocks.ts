/** A source of the current time, in milliseconds. */
export interface Clock {
  now(): number;
}

/**
 * The wall clock tells the time of day, so every `exp` and event time is read against it, and it can
 * step backward. The monotonic clock only moves forward, so every interval is timed on it: the grace
 * period, the poll deadline and each entry's TTL.
 */
export interface Clocks {
  monotonic: Clock;
  wall: Clock;
}
