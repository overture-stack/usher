import type pg from 'pg';

/** A connection taken from the store's pool for one unit of work. */
export interface PooledConnection {
  /** Returns the connection to its pool, or discards it when `destroy` is true. */
  release(destroy?: boolean): void;
}

/** Where a unit of store work takes its connection from: the controller's pool. */
export interface ConnectionPool<Connection extends PooledConnection> {
  connect(): Promise<Connection>;
}

/** The connection one unit of store work holds, its one release, and its commit's timeout. */
export interface Lease<Connection> {
  connection: Connection;

  /**
   * Returns the connection to its pool, or discards it when `destroy` is true. Only the first release
   * reaches the pool: any later one, or one after the unit was abandoned, does nothing.
   */
  release(destroy?: boolean): void;

  /**
   * Marks the unit's `COMMIT` as about to be sent: the unit is given one more of its timeout from now
   * for the answer, and the answer arriving within it decides the outcome. Past it, the unit fails
   * with {@link CommitUnconfirmed}. Only the first call counts, and none once the unit is abandoned.
   */
  sendingCommit(): void;
}

/** Where the controller reads the store outside any transaction, one statement at a time. */
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
