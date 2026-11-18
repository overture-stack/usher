import type pg from 'pg';

/** A connection taken from the store's pool for one unit of work. */
export interface PooledConnection {
  /** Returns the connection to its pool, or discards it when `destroy` is true. */
  release(destroy?: boolean): void;
}

/** Where a unit of store work takes its connection from: the Controller's pool. */
export interface ConnectionPool<Connection extends PooledConnection> {
  connect(): Promise<Connection>;
}

/**
 * When a request must have been answered, as the time left until then on a monotonic clock, so a unit
 * of store work run for the request can be bounded by it as well as by its timeout. It is fixed for
 * the request: every reading counts down from the same instant, however late the unit begins.
 */
export interface Deadline {
  /** The milliseconds left until the deadline, read now: zero or less once it has passed. */
  remainingMilliseconds(): number;
}

/** The connection one unit of store work holds, its bound, its one release, and its commit's timeout. */
export interface Lease<Connection> {
  /**
   * How long the unit's work may run, in milliseconds, from when the unit asked for its connection:
   * its timeout, or, for a unit with a deadline, the time then left to the deadline where that is
   * shorter, in whole milliseconds. Both limits the store applies to a session are set to it where the
   * unit sets its own.
   */
  boundMilliseconds: number;

  connection: Connection;

  /**
   * Returns the connection to its pool, or discards it when `destroy` is true. Only the first release
   * reaches the pool: any later one, or one after the unit was abandoned, does nothing.
   */
  release(destroy?: boolean): void;

  /**
   * Marks the unit's `COMMIT` as about to be sent: the unit is given one more of its timeout from now
   * for the answer, or, for a unit with a deadline, the time left to the deadline where that is
   * shorter, and the answer arriving within it decides the outcome. Past it, the unit fails with
   * {@link CommitUnconfirmed}. Only the first call counts, and none once the unit is abandoned.
   *
   * @throws {StoreTimeout} for a unit with a deadline when less than the commit window is left to it:
   *   the unit is abandoned with that failure and its connection discarded, and the `COMMIT` must not
   *   be sent.
   */
  sendingCommit(): void;
}

/** Where the Controller reads the store outside any transaction, one statement at a time. */
export interface StoreReader {
  /**
   * Runs one statement on a connection of its own, within the store timeout.
   *
   * @param text the statement, every value bound.
   * @param values the values bound to it.
   * @throws {StoreTimeout} when the store does not answer it within the store timeout.
   */
  query<Row extends pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<Row>>;
}
