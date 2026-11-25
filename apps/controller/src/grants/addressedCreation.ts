import type { AuditEvent } from '../eventLog/index.js';
import type { OperationOutcome } from '../managementApi/index.js';
import { GRANT_PROBLEMS } from './grantProblems.js';
import { grantView } from './grantView.js';
import { answered, refused } from './operationOutcome.js';
import type { ViewedGrant } from './types.js';

/** The terms of a grant whose holder is named by address, as its creation names them. */
export interface AddressedTerms {
	/** The scoped record categories the grants take, in order; none for the whole resource. */
	categories: readonly string[] | undefined;

	/** The address, exactly as given. */
	email: string;

	/** The externalId. */
	resource: string;

	role: string;
}

/**
 * What a creation naming its holder by address answers once the directory has resolved the address,
 * and the reason its event records a refusal while the answer does not say so.
 */
export interface AddressedAnswer {
	outcome: OperationOutcome;

	/** The refusal the operation's event records though the answer is a success; none otherwise. */
	recordedRefusal?: string;
}

// The answer a counted owner is given, whether or not an account holds the address: the terms and
// the address as given, naming no grant and no holder.
const ownersAnswer = ({ categories, email, resource, role }: AddressedTerms): OperationOutcome =>
	answered(202, {
		...(categories === undefined ? {} : { categories: [...categories] }),
		email,
		kind: 'grantByAddress',
		resource,
		role,
	});

/**
 * How a creation naming its holder by address is answered, decided here alone. A platform
 * administrator is answered 201 with the grants written for the account holding the address, and is
 * refused 404 `holderNotFound` for an address held by no single account. A counted owner is
 * answered 202 alike in both cases, naming the terms and the address as given, never the grant's id
 * nor the holder's subject; nothing is written for an address held by no single account, and the
 * event records that refusal as `holderNotFound`.
 *
 * @param caller whether the caller is a platform administrator.
 * @param terms the grant's terms and the address as given.
 * @param written the grant written for the account holding the address, or none for an address held
 *   by no single account.
 * @param now the configured clock's instant, in milliseconds since the Unix epoch.
 */
export const addressedAnswer = (
	{ administrator }: { administrator: boolean },
	terms: AddressedTerms,
	written: readonly ViewedGrant[] | undefined,
	now: number,
): AddressedAnswer => {
	if (administrator) {
		return {
			outcome:
				written === undefined
					? refused(GRANT_PROBLEMS.holderNotFound)
					: answered(201, { grants: written.map((grant) => grantView(grant, now)) }),
		};
	}
	return written === undefined
		? {
				outcome: ownersAnswer(terms),
				recordedRefusal: GRANT_PROBLEMS.holderNotFound.code,
			}
		: { outcome: ownersAnswer(terms) };
};

/**
 * The `grant.creation` event recording a creation refused though its answer does not say so: naming
 * the resource, and the reason.
 *
 * @param resource the externalId.
 * @param reason the refusal's reason.
 * @param sourceIp the address the request came from.
 */
export const unansweredRefusal = (resource: string, reason: string, sourceIp: string): AuditEvent => ({
	data: { reason, resourceId: resource, result: 'denied', sourceIp },
	severity: 'warning',
	type: 'grant.creation',
});
