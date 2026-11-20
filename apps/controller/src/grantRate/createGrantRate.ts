import pg from 'pg';

import type { GrantRate, GrantRateSettings } from './types.js';

// The first key of the transaction-scoped advisory lock that one actor's counts take in turn, its
// second a hash of the actor's subject. A two-key advisory lock never meets a one-key one, whatever
// their values.
const ACTOR_LOCK_CLASS = 86_172_070;

const SECOND_MILLISECONDS = 1000;

/**
 * Creates the grant rate, counted in the store so every instance sharing it counts alike. Each
 * count first takes, in a statement of its own, a transaction-scoped advisory lock keyed by the
 * actor's subject, so two counts of one actor, on any instances, run in turn and the later one
 * reads the earlier one's row. It then writes the operation's row in `grant_operations`, under the
 * trusted issuer, at the configured clock's instant, and expiring once the configured window has
 * passed from it, and counts the actor's rows within that window before this one. When those
 * number exactly the threshold's `operationCount`, this operation carries the count past it, and
 * `grant.rateExceeded` is recorded at warning in the same transaction, naming the count with this
 * operation, the window and the address the request came from; a count already past the threshold
 * records nothing more, so the event is recorded once each time the count crosses.
 *
 * @param settings the clock, the schema, the trusted issuer and the live settings.
 */
export const createGrantRate = (settings: GrantRateSettings): GrantRate => {
	const { clock, databaseSchema, identityProviderIssuer } = settings;
	const schema = pg.escapeIdentifier(databaseSchema);
	const operations = `${schema}.${pg.escapeIdentifier('grant_operations')}`;
	// The operation's row is written in the statement's data-modifying part, unseen by its count.
	const countAndWrite = `WITH counted AS (
      INSERT INTO ${operations} (idp_issuer, idp_subject_id, occurred_at, expires_at)
      VALUES ($1, $2, $3, $4)
    )
    SELECT count(*)::integer AS earlier FROM ${operations}
     WHERE idp_issuer = $1 AND idp_subject_id = $2 AND occurred_at > $5`;

	return {
		count: async ({ connection, record }, { sourceIp, subject }) => {
			await connection.query('SELECT pg_advisory_xact_lock($1::integer, hashtext($2))', [
				ACTOR_LOCK_CLASS,
				subject,
			]);
			// Read at the count, not at creation, so a change through the settings applies at once.
			const { operationCount, windowSeconds } = settings.grantRateThreshold;
			const windowMilliseconds = windowSeconds * SECOND_MILLISECONDS;
			const now = clock.now();
			const { rows } = await connection.query<{ earlier: number }>(countAndWrite, [
				identityProviderIssuer,
				subject,
				new Date(now),
				new Date(now + windowMilliseconds),
				new Date(now - windowMilliseconds),
			]);
			if (rows[0]?.earlier === operationCount) {
				await record({
					data: { operationCount: operationCount + 1, sourceIp, windowSeconds },
					severity: 'warning',
					type: 'grant.rateExceeded',
				});
			}
		},
	};
};
