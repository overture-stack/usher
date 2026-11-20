import type pg from 'pg';

import type { AuditTransaction } from '../eventLog/index.js';
import type { ControllerSettings } from '../settings/index.js';

/** Where each grant operation is counted against the grant rate's threshold. */
export interface GrantRate {
	/**
	 * Counts one grant operation by the transaction's actor, in that transaction, and records
	 * `grant.rateExceeded` in it when this operation carries the actor's count within the window from
	 * the threshold to past it. It must be the transaction's last step to take a lock, since it holds
	 * the actor's lock until the transaction ends.
	 *
	 * @param transaction the transaction of the change counted, or of the event recording its
	 *   refusal.
	 * @param subject the actor's subject under the trusted issuer.
	 */
	count(transaction: AuditTransaction<pg.ClientBase>, subject: string): Promise<void>;
}

/**
 * What the grant rate is created from: the clock, the schema, the issuer and the live settings, whose
 * `grantRateThreshold` is read at each count rather than once.
 */
export type GrantRateSettings = Pick<
	ControllerSettings,
	'clock' | 'databaseSchema' | 'grantRateThreshold' | 'identityProviderIssuer'
>;
