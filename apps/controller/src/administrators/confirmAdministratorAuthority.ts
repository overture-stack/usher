import { admittedAdministrator, AdministratorStatusWithdrawn, type StoreReader } from '../managementApi/index.js';
import { ADMINISTRATORS_LOCK, readAdministratorStatus } from './administratorStore.js';

/**
 * Creates the confirmation the audit trail runs in every change's transaction, after the actor is
 * declared and before the change's work. A change run outside a request admitted as an administrator
 * confirms nothing and sends no statement. Otherwise the change takes the administrators' lock,
 * exclusively where it alters who is an administrator and shared where it does not, so a change that
 * alters who is an administrator and any change by an administrator never interleave. It then reads
 * whether the identity is a live administrator, and throws {@link AdministratorStatusWithdrawn} when
 * it is not, which fails the transaction.
 *
 * @param options the Controller's schema.
 */
export const confirmAdministratorAuthority =
	({ schema }: { schema: string }) =>
	async (connection: StoreReader, { exclusive }: { exclusive: boolean }): Promise<void> => {
		const identity = admittedAdministrator();
		if (identity === undefined) {
			return;
		}
		await connection.query(
			exclusive ? 'SELECT pg_advisory_xact_lock($1)' : 'SELECT pg_advisory_xact_lock_shared($1)',
			[ADMINISTRATORS_LOCK],
		);
		const status = await readAdministratorStatus(connection, schema, identity);
		if (!status.administrator) {
			throw new AdministratorStatusWithdrawn();
		}
	};
