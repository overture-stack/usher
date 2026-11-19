import pg from 'pg';

import { standingColumns } from './standingColumns.js';
import type {
  ResourceStanding,
  StandingLock,
  StandingQuestion,
  StatementRunner,
} from './types.js';

// The row lock a read takes on the resource, held until its transaction ends.
const LOCKING: Readonly<Record<Exclude<StandingLock, 'none'>, string>> = {
  noKeyUpdate: 'FOR NO KEY UPDATE',
  share: 'FOR SHARE',
};

/**
 * Reads one principal's standing on the resource holding an externalId, matched exactly, in one
 * statement, so the resource and the grants judged come from one snapshot. A lock asked for is
 * taken on the resource's row in a statement of its own before that read, so the read sees every
 * change committed before the lock was granted, and is held for the rest of the transaction:
 * `share` against every lock for update, and `noKeyUpdate` against those and against `share`.
 *
 * @param runner where the statements run: a transaction's connection for a lock.
 * @param schema the Controller's schema.
 * @param question the externalId, the trusted issuer, the principal's subject, the configured
 *   clock's instant, and the lock.
 * @returns the standing, or `undefined` when no resource holds the externalId.
 */
export const readResourceStanding = async (
  runner: StatementRunner,
  schema: string,
  { externalId, issuer, lock, now, subject }: StandingQuestion,
): Promise<ResourceStanding | undefined> => {
  const resources = `${pg.escapeIdentifier(schema)}.resources`;
  if (lock !== 'none') {
    await runner.query(
      `SELECT 1 FROM ${resources} WHERE external_id = $1 ${LOCKING[lock]}`,
      [externalId],
    );
  }
  const { rows } = await runner.query<ResourceStanding>(
    `SELECT resource.base_tier AS "accessLevel",
            resource.external_id AS "externalId",
            resource.id::text AS id,
            resource.retired_at IS NOT NULL AS retired,
            resource.suppressed,
            ${standingColumns(schema, {
              issuer: '$2::text',
              now: '$3::timestamptz',
              subject: '$4::text',
            })}
       FROM ${resources} resource
      WHERE resource.external_id = $1`,
    [externalId, issuer, now, subject],
  );
  return rows[0];
};
