import pg from 'pg';

import type { GrantEnds } from './types.js';

const tableIn =
  (schema: string) =>
  (name: string): string =>
    `${pg.escapeIdentifier(schema)}.${name}`;

/**
 * Whether a grant is live: neither revoked, nor replaced once it had expired, nor expired on the
 * configured clock. A grant expiring at the instant given has expired.
 *
 * @param ends when the grant was revoked, was replaced and expires, each `null` for never.
 * @param now the configured clock's instant, in milliseconds since the Unix epoch.
 */
export const isLive = (
  { endedAt, expiresAt, revokedAt }: GrantEnds,
  now: number,
): boolean =>
  revokedAt === null &&
  endedAt === null &&
  (expiresAt === null || expiresAt.getTime() > now);

/**
 * The condition, in SQL, that the grant a statement names by an alias is live, as {@link isLive}
 * judges it.
 *
 * @param alias the alias the statement gives the grant's row.
 * @param now the placeholder the configured clock's instant is bound to, such as `$3::timestamptz`.
 */
export const liveGrantCondition = (alias: string, now: string): string =>
  `(${alias}.revoked_at IS NULL AND ${alias}.ended_at IS NULL
    AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > ${now}))`;

/**
 * The latest answer, in SQL, that the holder of the grant a statement names by an alias gave it:
 * `accepted`, `rejected`, or `NULL` while they have given none.
 *
 * @param schema the controller's schema.
 * @param alias the alias the statement gives the grant's row.
 */
export const latestDecisionOf = (schema: string, alias: string): string =>
  `(SELECT answer.decision FROM ${tableIn(schema)('grant_decisions')} answer
     WHERE answer.grant_id = ${alias}.id AND answer.user_id = ${alias}.holder_user_id
     ORDER BY answer.decided_at DESC LIMIT 1)`;

/**
 * The condition, in SQL, that the grant a statement names by an alias makes its holder a counted
 * owner of its resource: a person's grant of the role named `owner`, live, which their latest
 * answer accepted. A group's grant makes nobody an owner.
 *
 * @param schema the controller's schema.
 * @param alias the alias the statement gives the grant's row.
 * @param now the placeholder the configured clock's instant is bound to.
 */
export const countedOwnerCondition = (
  schema: string,
  alias: string,
  now: string,
): string =>
  `(${alias}.holder_user_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM ${tableIn(schema)('roles')} owning
                 WHERE owning.id = ${alias}.role_id AND owning.name = 'owner')
    AND ${liveGrantCondition(alias, now)}
    AND ${latestDecisionOf(schema, alias)} = 'accepted')`;
