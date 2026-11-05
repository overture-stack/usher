import { randomUUID } from 'node:crypto';

import pg from 'pg';

import { eventInstant } from './eventInstant.js';
import type {
  Actor,
  AuditEvent,
  AuditTrail,
  AuditTrailSettings,
  AuditTransaction,
  EventEnvelope,
  TrailConnection,
} from './types.js';

const SPECVERSION = '1.0';

const TYPE_PREFIX = 'bio.overture.';

// The transaction-local settings the policy tables' triggers read the actor from: its type, and its
// subject, empty for an actor who is nobody.
const DECLARE_ACTOR =
  "SELECT set_config('usher.actor_type', $1, true), set_config('usher.actor_id', $2, true)";

const actorIdOf = (actor: Actor): string | null =>
  'id' in actor ? actor.id : null;

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
 * of the change it records, and as a line of the log stream once that transaction has committed. The
 * row and the line carry the same envelope: a fresh uuid as `id`, the configured `source`, CloudEvents
 * 1.0, the type with the `bio.overture.` prefix, `time` read from the clock as RFC 3339 in UTC, the
 * severity, and `data` naming the actor and the instance. The row keeps `time` in `occurred_at`.
 *
 * @param options the store, the log stream, and the settings naming the schema, the event source
 *   and the instance.
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
  ): Promise<Result> => {
    if (actorIdOf(actor) === '') {
      throw new TypeError(
        'an actor who is a person or a service account names their subject',
      );
    }
    const connection = await store.connect();
    const transaction = { open: true };
    const recorded: EventEnvelope[] = [];
    const record = async (event: AuditEvent): Promise<string> => {
      if (transaction.open) {
        const envelope = envelopeOf(event, actor);
        await connection.query(insertRow, rowValues(envelope));
        recorded.push(envelope);
        return envelope.id;
      }
      throw new Error(
        'an event is recorded only while its transaction is open',
      );
    };
    const committed = async (): Promise<Result> => {
      try {
        await connection.query('BEGIN');
        await connection.query(DECLARE_ACTOR, [
          actor.type,
          actorIdOf(actor) ?? '',
        ]);
        const result = await work({ connection, record });
        // A transaction in which a statement failed rolls back when told to commit, and says so only
        // in its answer, so a failure the work caught still leaves nothing committed and no line.
        const { command } = await connection.query('COMMIT');
        if (command === 'COMMIT') {
          return result;
        }
        throw new Error(
          'the transaction rolled back at its commit, a statement in it having failed',
        );
      } catch (error) {
        transaction.open = false;
        // A connection that cannot roll back is gone, and is dropped rather than returned to the pool.
        const rolledBack = await connection.query('ROLLBACK').then(
          () => true,
          () => false,
        );
        connection.release(!rolledBack);
        throw error;
      }
    };
    const result = await committed();
    transaction.open = false;
    connection.release();
    recorded.forEach((envelope) => {
      eventLog.writeEvent(envelope);
    });
    return result;
  };

  return { inTransaction };
};
