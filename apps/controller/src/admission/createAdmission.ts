import { admissionShare } from './admissionShare.js';
import type {
  Admission,
  AdmissionSettings,
  Admitted,
  ExchangeKind,
} from './types.js';

/** An application's exchanges in flight on the instance: all of them, and the anonymous ones. */
interface InFlight {
  anonymous: number;
  total: number;
}

/** Every exchange in flight on the instance: by application, and all of them together. */
interface Held {
  byApplication: ReadonlyMap<string, InFlight>;
  total: number;
}

const NONE_IN_FLIGHT: InFlight = Object.freeze({ anonymous: 0, total: 0 });

const OVER_SHARE: Admitted<never> = Object.freeze({ kind: 'overShare' });

/**
 * Creates an instance's admission, which admits each application's exchanges within a share of the
 * exchange pool, lends the pool's idle connections past a share, and keeps every application its own
 * share whatever another sends. The share is {@link admissionShare} of the pool's size and the
 * registered count as it stands at each admission. An exchange is admitted:
 *
 * 1. while its application has fewer exchanges in flight than its share, always;
 * 2. past its share, while the instance's exchanges in flight, every application's together, number
 *    fewer than the pool's connections, so a connection no share is using is lent rather than left
 *    idle;
 * 3. past that, for an anonymous exchange while its application has no other anonymous exchange in
 *    flight, the anonymous lane, so the open tier stays fresh through a flood of credentials.
 *
 * Any other exchange is refused. The instance counts its exchanges in flight itself, in the same turn
 * as each admission and settlement, rather than reading the pool's own counts, which change only once
 * a connection has been handed out. So with P the pool's connections and R the registered count
 * holding steady, the exchanges in flight never number more than P, for those admitted past their
 * shares, plus the sum of the shares, plus R for the lanes: at most 2P + R while R is at most P. An
 * exchange admitted while every connection is in use waits for one in the driver's queue, bounded by
 * its own deadline.
 *
 * @param settings the pool's size and the registered count.
 */
export const createAdmission = ({
  poolSize,
  registeredCount,
}: AdmissionSettings): Admission => {
  const state: { held: Held } = {
    held: { byApplication: new Map(), total: 0 },
  };

  const inFlightOf = (applicationId: string): InFlight =>
    state.held.byApplication.get(applicationId) ?? NONE_IN_FLIGHT;

  const admits = (applicationId: string, kind: ExchangeKind): boolean => {
    const held = inFlightOf(applicationId);
    return (
      held.total < admissionShare(poolSize, registeredCount()) ||
      state.held.total < poolSize ||
      (kind === 'anonymous' && held.anonymous === 0)
    );
  };

  // An application with nothing in flight is dropped, so the counts hold only what is in flight.
  const adjust = (
    applicationId: string,
    kind: ExchangeKind,
    by: number,
  ): void => {
    const held = inFlightOf(applicationId);
    const next: InFlight = {
      anonymous: held.anonymous + (kind === 'anonymous' ? by : 0),
      total: held.total + by,
    };
    state.held = {
      byApplication:
        next.total > 0
          ? new Map([...state.held.byApplication, [applicationId, next]])
          : new Map(
              [...state.held.byApplication].filter(
                ([holder]) => holder !== applicationId,
              ),
            ),
      total: state.held.total + by,
    };
  };

  return {
    inFlight: () => state.held.total,

    // The check and the take run in one turn, before any await, so no two exchanges take the last
    // place.
    within: async <Result>(
      applicationId: string,
      kind: ExchangeKind,
      work: () => Promise<Result>,
    ): Promise<Admitted<Result>> => {
      if (!admits(applicationId, kind)) {
        return OVER_SHARE;
      }
      adjust(applicationId, kind, 1);
      try {
        return { kind: 'admitted', result: await work() };
      } finally {
        adjust(applicationId, kind, -1);
      }
    },
  };
};
