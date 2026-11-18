import pg from 'pg';

import {
  countedOwnerCondition,
  latestDecisionOf,
  liveGrantCondition,
} from './liveGrant.js';
import type { StandingPlaceholders } from './types.js';

/**
 * The columns, in SQL, giving one principal's standing on the resource a statement names by the
 * alias `resource`: `holder`, whether the principal holds a live grant on it that their latest
 * answer did not reject, and `"countedOwner"`, whether the principal is a counted owner of it. The
 * principal is the person holding the identity of the subject under the trusted issuer, matched
 * exactly; a subject no identity holds holds nothing. Only a grant held by the person themself
 * counts, never one held by a group.
 *
 * @param schema the Controller's schema.
 * @param placeholders where the trusted issuer, the subject and the configured clock's instant are
 *   bound.
 */
export const standingColumns = (
  schema: string,
  { issuer, now, subject }: StandingPlaceholders,
): string => {
  const table = (name: string): string =>
    `${pg.escapeIdentifier(schema)}.${name}`;
  const heldByPrincipal = (condition: string): string =>
    `EXISTS (
       SELECT 1 FROM ${table('grants')} held
         JOIN ${table('user_identities')} identity ON identity.user_id = held.holder_user_id
        WHERE held.resource_id = resource.id
          AND identity.idp_issuer = ${issuer} AND identity.idp_subject_id = ${subject}
          AND ${condition})`;
  return `${heldByPrincipal(countedOwnerCondition(schema, 'held', now))} AS "countedOwner",
          ${heldByPrincipal(
            `${liveGrantCondition('held', now)}
             AND ${latestDecisionOf(schema, 'held')} IS DISTINCT FROM 'rejected'`,
          )} AS holder`;
};
