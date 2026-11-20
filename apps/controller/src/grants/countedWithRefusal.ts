import type pg from 'pg';

import type { AuditTransaction } from '../eventLog/index.js';
import type { Principal } from '../managementApi/index.js';
import type { GrantOperationsSettings } from './types.js';

/**
 * The work counting a refused or failed grant write against the grant rate, by the principal
 * refused, from the address its request came from, in the transaction recording its event.
 *
 * @param operations the grant rate.
 */
export const countedWithRefusal =
	({ grantRate }: Pick<GrantOperationsSettings, 'grantRate'>) =>
	(transaction: AuditTransaction<pg.ClientBase>, { subject }: Principal, sourceIp: string): Promise<void> =>
		grantRate.count(transaction, { sourceIp, subject });
