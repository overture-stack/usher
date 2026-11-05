import { CommitUnconfirmed } from './commitUnconfirmed.js';
import { StoreTimeout } from './storeTimeout.js';
import type { ConnectionPool, Lease, PooledConnection } from './types.js';

/**
 * Runs one unit of store work on a connection of its own, within the store timeout counted from the
 * moment the unit asks for its connection to the moment its work ends. Once the work ends in time,
 * the connection is returned to its pool after a success and discarded after a failure, unless the
 * work released it itself.
 *
 * When the timeout runs out first, the unit is abandoned and fails with {@link StoreTimeout}. Its
 * connection is discarded, never returned to the pool: at once when held, and as soon as it arrives
 * when still being acquired, the work then never running. A connection is discarded rather than
 * rolled back, since a statement still running on it would hold back a `ROLLBACK`: the store ends the
 * session and rolls back whatever it held once it reads that the client has gone. The work's next
 * statement fails at the discarded connection, so nothing more of it reaches the store.
 *
 * A unit about to send its `COMMIT` says so through its lease, and is given one more timeout from
 * then for the answer, which decides the outcome when it arrives within it. When none does, the
 * `COMMIT` may or may not have taken effect: the unit is abandoned as above, and fails with
 * {@link CommitUnconfirmed} rather than {@link StoreTimeout}.
 *
 * @param pool where the connection is taken from.
 * @param timeoutMilliseconds the unit's timeout: the configured store timeout, or the unit's own.
 * @param work the unit's statements, given the connection, its one release and its commit's timeout.
 * @throws {StoreTimeout} when the timeout runs out before the work ends or sends its `COMMIT`.
 * @throws {CommitUnconfirmed} when the `COMMIT`'s answer does not come within one more timeout.
 * @throws whatever the pool or the work throws otherwise.
 */
export const withinStoreTimeout = <Connection extends PooledConnection, Result>(
  pool: ConnectionPool<Connection>,
  timeoutMilliseconds: number,
  work: (lease: Lease<Connection>) => Promise<Result>,
): Promise<Result> =>
  new Promise<Result>((resolve, reject) => {
    const unit: {
      held: Connection | undefined;
      phase: 'abandoned' | 'committing' | 'working';
      timer: NodeJS.Timeout | undefined;
    } = { held: undefined, phase: 'working', timer: undefined };
    const release = (destroy?: boolean): void => {
      const { held } = unit;
      unit.held = undefined;
      held?.release(destroy);
    };
    const abandonWith =
      (failure: () => Error): (() => void) =>
      (): void => {
        unit.phase = 'abandoned';
        release(true);
        reject(failure());
      };
    unit.timer = setTimeout(
      abandonWith(() => new StoreTimeout()),
      timeoutMilliseconds,
    );
    const sendingCommit = (): void => {
      if (unit.phase === 'working') {
        unit.phase = 'committing';
        clearTimeout(unit.timer);
        unit.timer = setTimeout(
          abandonWith(() => new CommitUnconfirmed()),
          timeoutMilliseconds,
        );
      }
    };
    const run = async (): Promise<Result> => {
      const connection = await pool.connect();
      if (unit.phase === 'abandoned') {
        connection.release(true);
        throw new StoreTimeout();
      }
      unit.held = connection;
      return work({ connection, release, sendingCommit });
    };
    // Once the timeout has run out, the unit's promise is settled, and the work's own end changes
    // nothing of it.
    run().then(
      (result) => {
        clearTimeout(unit.timer);
        release();
        resolve(result);
      },
      (failure: unknown) => {
        clearTimeout(unit.timer);
        release(true);
        reject(failure);
      },
    );
  });
