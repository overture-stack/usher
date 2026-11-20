import type { Problem } from '../http/index.js';
import { unreadableBody } from '../managementApi/index.js';
import { GRANT_PROBLEMS } from './grantProblems.js';
import type { HolderReading } from './types.js';

const ADDRESS_FORM = /^[^\s@,\p{Cc}]+@[^\s@,\p{Cc}]+$/u;

/**
 * Whether text is in an address's form: text before and after a single `@`, holding no whitespace,
 * comma or control character. Whether an account holds the address is never judged here.
 *
 * @param text the text.
 */
export const isAddressForm = (text: string): boolean => ADDRESS_FORM.test(text);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const refused = (problem: Problem): HolderReading => ({
	kind: 'refused',
	problem,
});

/**
 * Reads a grant's holder: exactly one person, by `subject` or by `email`. A holder that is no
 * object, or names its subject or its address as anything but a string, is refused 400; a holder
 * naming anything else, both, neither, or an empty subject, is refused 422 `holderNotOnePerson`; an
 * address not in an address's form is refused 422 `addressForm`. The subject and the address are
 * kept exactly as given.
 *
 * @param value the value sent as the holder.
 * @param member how the body names the holder, for a refusal of its shape.
 */
export const readHolder = (value: unknown, member: string): HolderReading => {
	if (!isRecord(value)) {
		return refused(unreadableBody(`holds ${member} as something other than an object`));
	}
	const mistyped = ['email', 'subject'].find((name) => Object.hasOwn(value, name) && typeof value[name] !== 'string');
	if (mistyped !== undefined) {
		return refused(unreadableBody(`holds the ${mistyped} of ${member} as something other than a string`));
	}
	const [named, ...more] = Object.entries(value);
	if (named === undefined || more.length > 0) {
		return refused(GRANT_PROBLEMS.holderNotOnePerson);
	}
	const [name, text] = named;
	if (name === 'subject' && typeof text === 'string' && text !== '') {
		return { holder: { kind: 'subject', subject: text }, kind: 'read' };
	}
	if (name !== 'email' || typeof text !== 'string') {
		return refused(GRANT_PROBLEMS.holderNotOnePerson);
	}
	return isAddressForm(text)
		? { holder: { email: text, kind: 'address' }, kind: 'read' }
		: refused(GRANT_PROBLEMS.addressForm);
};
