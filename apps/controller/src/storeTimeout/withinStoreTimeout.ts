import { CommitUnconfirmed } from './commitUnconfirmed.js';
import { StoreTimeout } from './storeTimeout.js';
import type {
  ConnectionPool,
  Deadline,
  Lease,
  PooledConnection,
} from './types.js';

/**
 * The least time left to a unit's deadline, in milliseconds, for its `COMMIT` to be sent. With less
 * left, the store's answer could not arrive before the deadline, and a `COMMIT` sent anyway would leave
 * the outcome unknown at the very moment the request must be answered; abandoning the unit instead
 * leaves nothing committed, so the request's answer is certain.
 */
export const COMMIT_WINDOW_MILLISECONDS = 100;

// The unit's work bound: its timeout, or the time left to its deadline when shorter, in whole
// milliseconds, so both limits the store applies to a session can be set to it exactly.
const workBoundOf = (
  timeoutMilliseconds: number,
  deadline: Deadline | undefined,
): number =>
  deadline === undefined
    ? timeoutMilliseconds
    : Math.floor(
        Math.min(timeoutMilliseconds, deadline.remainingMilliseconds()),
      );

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
 * A unit given a deadline is bounded by it as well, so it never runs past it. Its work is bounded by
 * its timeout or the time left to the deadline as it begins, whichever is shorter, and its `COMMIT` by
 * its timeout or the time left as it is about to be sent, whichever is shorter, never by a fresh
 * timeout. With less than {@link COMMIT_WINDOW_MILLISECONDS} left by then, its `COMMIT` is not sent:
 * the unit is abandoned with {@link StoreTimeout} and its connection discarded, so its open
 * transaction cannot outlive the request. With not one whole millisecond left as it begins, it fails
 * with {@link StoreTimeout} at once, taking no connection.
 *
 * @param pool where the connection is taken from.
 * @param timeoutMilliseconds the unit's timeout: the configured store timeout, or the unit's own.
 * @param work the unit's statements, given the connection, its bound, its one release and its
 *   commit's timeout.
 * @param deadline when the request the unit runs for must have been answered, for a unit bounded by
 *   one; none by default.
 * @throws {StoreTimeout} when the bound runs out before the work ends or sends its `COMMIT`, or too
 *   little is left to a deadline to send it.
 * @throws {CommitUnconfirmed} when the `COMMIT`'s answer does not come within its bound.
 * @throws whatever the pool or the work throws otherwise.
 */
export const withinStoreTimeout = <Connection extends PooledConnection, Result>(
  pool: ConnectionPool<Connection>,
  timeoutMilliseconds: number,
  work: (lease: Lease<Connection>) => Promise<Result>,
  deadline?: Deadline,
): Promise<Result> => {
  const boundMilliseconds = workBoundOf(timeoutMilliseconds, deadline);
  if (deadline !== undefined && boundMilliseconds < 1) {
    return Promise.reject(new StoreTimeout());
  }
  return new Promise<Result>((resolve, reject) => {
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
    const abandon = (failure: Error): void => {
      unit.phase = 'abandoned';
      clearTimeout(unit.timer);
      release(true);
      reject(failure);
    };
    unit.timer = setTimeout(() => {
      abandon(new StoreTimeout());
    }, boundMilliseconds);
    const sendingCommit = (): void => {
      if (unit.phase === 'working') {
        const remaining = deadline?.remainingMilliseconds();
        if (remaining !== undefined && remaining < COMMIT_WINDOW_MILLISECONDS) {
          const failure = new StoreTimeout();
          abandon(failure);
          throw failure;
        }
        unit.phase = 'committing';
        clearTimeout(unit.timer);
        unit.timer = setTimeout(
          () => {
            abandon(new CommitUnconfirmed());
          },
          remaining === undefined
            ? timeoutMilliseconds
            : Math.min(timeoutMilliseconds, remaining),
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
      return work({ boundMilliseconds, connection, release, sendingCommit });
    };
    // Once the unit is abandoned, its promise is settled, and the work's own end changes nothing of
    // it.
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
};
