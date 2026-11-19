import pg from 'pg';

import type { Actor, AuditEvent } from '../eventLog/index.js';
import { failureCodeOf } from '../failures/index.js';
import { CommitUnconfirmed, type Deadline } from '../storeTimeout/index.js';
import type { ExchangeKey, KeyConfirmations, KeyConfirmationSettings } from './types.js';

/** The line naming a key's confirmation the store could not take; the next exchange tries again. */
export const KEY_CONFIRMATION_FAILED = 'exchange.keyConfirmationFailed';

const SYSTEM: Actor = Object.freeze({ type: 'system' });

type ConfirmedKey = Pick<ExchangeKey, 'applicationId' | 'keyId'>;

// Only a key still unconfirmed, and still live, is confirmed: of two writes racing on one key, the
// second waits on the first's row lock, then finds it confirmed and returns no row.
const confirmation = (schema: string): string =>
	`UPDATE ${pg.escapeIdentifier(schema)}.application_keys SET confirmed_at = $3
    WHERE id = $1::uuid AND application_id = $2::uuid AND confirmed_at IS NULL AND revoked_at IS NULL
    RETURNING id`;

const confirmationEvent = ({ applicationId, keyId }: ConfirmedKey): AuditEvent => ({
	data: { applicationId, keyId },
	severity: 'info',
	type: 'applicationKey.confirmation',
});

// The failure by its code alone, where it carries one that is an identifier, since a message may quote
// a value.
const codeOf = (failure: unknown): Readonly<Record<string, string>> => {
	const code = failureCodeOf(failure);
	return code === undefined ? {} : { code };
};

/**
 * Creates this instance's confirmations of application keys. The first exchange verified with a key
 * sets its `confirmed_at` to the clock's instant and records `applicationKey.confirmation`, naming
 * the application and the key, in one transaction of their own declaring the system as its actor,
 * within the store timeout and the deadline of the exchange that began the write: the confirmation is
 * noticed by the system, so the record of its change names the system rather than whoever the exchange
 * was for. The write takes a key only while it is unconfirmed and live, so however many exchanges race
 * on one key, across instances alike, one write confirms it and one event records it. Once a write has
 * committed, confirming the key or finding it confirmed, the instance knows the key confirmed and
 * writes nothing more for it; exchanges racing on one instance share one write. A write that fails, a
 * write the store did not finish by its deadline among them, is written to the log naming the
 * application, the key and the failure's code alone, one whose commit went unconfirmed is named by the
 * trail's own line, and either leaves the key to its next exchange, which finds it confirmed should
 * the commit have taken effect. Since the exchange's answer waits for the write until its deadline
 * at most, a read straight after that answer shows `confirmed_at` only when the store took the write
 * by then, which is enough for a column that is informational.
 *
 * @param settings the trail, the log, the clock and the schema.
 */
export const createKeyConfirmations = ({ eventLog, settings, trail }: KeyConfirmationSettings): KeyConfirmations => {
	const confirmed = new Set<string>();
	const writing = new Map<string, Promise<void>>();
	const statement = confirmation(settings.databaseSchema);

	const write = async (key: ConfirmedKey, deadline: Deadline | undefined): Promise<void> => {
		try {
			await trail.inTransaction(
				SYSTEM,
				async ({ connection, record }) => {
					const { rows } = await connection.query(statement, [
						key.keyId,
						key.applicationId,
						new Date(settings.clock.now()),
					]);
					if (rows.length > 0) {
						await record(confirmationEvent(key));
					}
				},
				deadline === undefined ? {} : { deadline },
			);
			confirmed.add(key.keyId);
		} catch (failure) {
			if (failure instanceof CommitUnconfirmed) {
				return;
			}
			eventLog.error(KEY_CONFIRMATION_FAILED, {
				applicationId: key.applicationId,
				...codeOf(failure),
				keyId: key.keyId,
			});
		}
	};

	return {
		confirm: (key, deadline) => {
			if (confirmed.has(key.keyId)) {
				return Promise.resolve();
			}
			const pending =
				writing.get(key.keyId) ??
				write(key, deadline).finally(() => {
					writing.delete(key.keyId);
				});
			writing.set(key.keyId, pending);
			return pending;
		},
	};
};
