import { randomUUID } from 'node:crypto';

import pg from 'pg';

import { ControllerError } from '../failures/index.js';
import {
  CommitUnconfirmed,
  type Lease,
  withinStoreTimeout,
} from '../storeTimeout/index.js';
import { eventInstant } from './eventInstant.js';
import type {
  Actor,
  AuditEvent,
  AuditTrail,
  AuditTrailSettings,
  AuditTransaction,
  EventEnvelope,
  TrailConnection,
  TransactionOptions,
} from './types.js';

const SPECVERSION = '1.0';

const TYPE_PREFIX = 'bio.overture.';

// The transaction-local settings the policy tables' triggers read the actor from: its type, and its
// subject, empty for an actor who is nobody.
const DECLARE_ACTOR =
  "SELECT set_config('usher.actor_type', $1, true), set_config('usher.actor_id', $2, true)";

// The same, setting for the transaction alone both limits the store applies to a session to a unit's
// bound in milliseconds, in the same round trip: raised to a longer timeout of its own, or lowered to
// what is left of the deadline of the request it runs for.
const DECLARE_ACTOR_AND_LIMITS = `${DECLARE_ACTOR}, set_config('statement_timeout', $3, true), set_config('idle_in_transaction_session_timeout', $3, true)`;

/** The line naming an event whose row could not be written. */
export const EVENT_UNRECORDED = 'audit.eventUnrecorded';

/** The line naming the events of a transaction whose commit the store did not confirm. */
export const COMMIT_UNCONFIRMED = 'audit.commitUnconfirmed';

const actorIdOf = (actor: Actor): string | null =>
  'id' in actor ? actor.id : null;

// The failure by its code alone, a SQLSTATE or a system error's, where it carries one, since a store's
// message may quote a value.
const failureCodeOf = (failure: unknown): Readonly<Record<string, string>> => {
  const code: unknown =
    typeof failure === 'object' && failure !== null && 'code' in failure
      ? failure.code
      : undefined;
  return typeof code === 'string' ? { code } : {};
};

const rowValues = ({
  data,
  dataschema,
  id,
  severity,
  source,
  specversion,
  time,
  type,
}: EventEnvelope): readonly unknown[] => [
  id,
  specversion,
  source,
  type,
  time,
  dataschema ?? null,
  JSON.stringify(data),
  severity,
];

/**
 * Creates the audit trail, which writes each event twice: as a row of `audit_log`, in the transaction
 * of the change it records, or in one of its own for an event recording no change, and as a line of
 * the log stream once that transaction has committed. The row and the line carry the same envelope: a
 * fresh uuid as `id`, the configured `source`, CloudEvents 1.0, the type with the `bio.overture.`
 * prefix, `time` read from the clock as RFC 3339 in UTC, the severity, and `data` naming the actor and
 * the instance. The row keeps `time` in `occurred_at`. Each transaction, from taking its connection to
 * its commit, runs within the store timeout, or a unit's own, as `withinStoreTimeout` runs a unit of
 * store work: one the store does not answer in time is abandoned and fails, and none of its lines is
 * written. One whose `COMMIT` goes unanswered within one more timeout is written instead as one line
 * at error, {@link COMMIT_UNCONFIRMED}, naming the `id` and `type` of each event it recorded and never
 * their data, so its rows can be looked for in `audit_log`. A transaction given a deadline is bounded
 * by it as well, as `withinStoreTimeout` bounds a unit by one, and sets both limits the store applies
 * to a session to its bound inside the transaction alone.
 *
 * @param options the store, the log stream, and the settings naming the schema, the event source,
 *   the instance and the store timeout.
 */
export const createAuditTrail = <Connection extends TrailConnection>({
  eventLog,
  settings,
  store,
}: AuditTrailSettings<Connection>): AuditTrail<Connection> => {
  const insertRow = `INSERT INTO ${pg.escapeIdentifier(settings.databaseSchema)}.audit_log (id, specversion, source, type, occurred_at, dataschema, data, severity) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

  // The trail's own members go last, so the data an event is given never names another actor.
  const envelopeOf = (
    { actor, data, dataschema, severity, type }: AuditEvent,
    transactionActor: Actor,
  ): EventEnvelope => {
    const named = actor ?? transactionActor;
    return {
      data: {
        ...data,
        actorId: actorIdOf(named),
        actorType: named.type,
        instance: settings.instanceName,
      },
      ...(dataschema === undefined ? {} : { dataschema }),
      id: randomUUID(),
      severity,
      source: settings.eventSource,
      specversion: SPECVERSION,
      time: eventInstant(settings.clock.now()),
      type: `${TYPE_PREFIX}${type}`,
    };
  };

  const inTransaction = async <Result>(
    actor: Actor,
    work: (transaction: AuditTransaction<Connection>) => Promise<Result>,
    { deadline, timeoutMilliseconds }: TransactionOptions = {},
  ): Promise<Result> => {
    if (actorIdOf(actor) === '') {
      throw new TypeError(
        'an actor who is a person or a service account names their subject',
      );
    }
    const transaction = { open: true };
    const recorded: EventEnvelope[] = [];
    // A transaction bounded by the store timeout alone keeps the limits its session was opened with.
    const declarationOf = (
      boundMilliseconds: number,
    ): { text: string; values: readonly string[] } =>
      deadline === undefined && timeoutMilliseconds === undefined
        ? { text: DECLARE_ACTOR, values: [] }
        : {
            text: DECLARE_ACTOR_AND_LIMITS,
            values: [String(boundMilliseconds)],
          };
    const committed = async ({
      boundMilliseconds,
      connection,
      release,
      sendingCommit,
    }: Lease<Connection>): Promise<Result> => {
      const declaration = declarationOf(boundMilliseconds);
      const record = async (event: AuditEvent): Promise<string> => {
        if (transaction.open) {
          const envelope = envelopeOf(event, actor);
          await connection.query(insertRow, rowValues(envelope));
          recorded.push(envelope);
          return envelope.id;
        }
        throw new ControllerError(
          'an event is recorded only while its transaction is open',
        );
      };
      try {
        await connection.query('BEGIN');
        await connection.query(declaration.text, [
          actor.type,
          actorIdOf(actor) ?? '',
          ...declaration.values,
        ]);
        const result = await work({ connection, record });
        // A transaction in which a statement failed rolls back when told to commit, and says so only
        // in its answer, so a failure the work caught still leaves nothing committed and no line.
        // With too little left to its deadline, the lease throws instead and has discarded the
        // connection, so no COMMIT is sent and the ROLLBACK below fails at the discarded connection.
        sendingCommit();
        const { command } = await connection.query('COMMIT');
        if (command === 'COMMIT') {
          transaction.open = false;
          return result;
        }
        throw new ControllerError(
          'the transaction rolled back at its commit, a statement in it having failed',
        );
      } catch (error) {
        transaction.open = false;
        // A connection that cannot roll back is gone, and is dropped rather than returned to the pool.
        const rolledBack = await connection.query('ROLLBACK').then(
          () => true,
          () => false,
        );
        release(!rolledBack);
        throw error;
      }
    };
    const result = await withinStoreTimeout(
      store,
      timeoutMilliseconds ?? settings.storeTimeoutMilliseconds,
      committed,
      deadline,
    ).catch((failure: unknown) => {
      if (failure instanceof CommitUnconfirmed) {
        eventLog.error(COMMIT_UNCONFIRMED, {
          events: recorded.map(({ id, type }) => ({ id, type })),
        });
      }
      throw failure;
    });
    recorded.forEach((envelope) => {
      eventLog.writeEvent(envelope);
    });
    return result;
  };

  const recordEvent = async (
    actor: Actor,
    event: AuditEvent,
  ): Promise<string | undefined> => {
    try {
      return await inTransaction(actor, ({ record }) => record(event));
    } catch (failure) {
      // An event whose commit went unconfirmed may be recorded, and its line already names it.
      if (failure instanceof CommitUnconfirmed) {
        return undefined;
      }
      eventLog.error(EVENT_UNRECORDED, {
        ...failureCodeOf(failure),
        eventType: `${TYPE_PREFIX}${event.type}`,
      });
      return undefined;
    }
  };

  return { inTransaction, recordEvent };
};
