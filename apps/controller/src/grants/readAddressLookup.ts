import { type InputReading, readTextMembers } from '../managementApi/index.js';
import { GRANT_PROBLEMS } from './grantProblems.js';
import { isAddressForm } from './readHolder.js';
import type { AddressLookup } from './types.js';

/**
 * Reads an address lookup from its body: `email` alone, a string, kept exactly as given. No body, a
 * body lacking it, holding another member, or holding one that is no string, is refused 400; an
 * address out of an address's form is refused 422 `addressForm`, before anything is looked up.
 *
 * @param body the body's object, or none for a request sending none.
 */
export const readAddressLookup = (body: Readonly<Record<string, unknown>> | undefined): InputReading<AddressLookup> => {
	const reading = readTextMembers(body ?? {}, { email: { required: true } });
	if (reading.kind === 'refused') {
		return reading;
	}
	const email = reading.members['email'] ?? '';
	return isAddressForm(email)
		? { input: { email }, kind: 'read' }
		: { kind: 'refused', problem: GRANT_PROBLEMS.addressForm };
};
