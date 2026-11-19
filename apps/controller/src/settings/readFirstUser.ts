import type { FirstUser, SettingReading } from './types.js';

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const readNamed = (member: 'realmRole' | 'subject', text: unknown): SettingReading<FirstUser> => {
	if (typeof text !== 'string') {
		return { kind: 'refused', rule: `${member} is not text` };
	}
	if (text === '') {
		return { kind: 'refused', rule: `${member} is empty` };
	}
	return { kind: 'read', value: member === 'realmRole' ? { realmRole: text } : { subject: text } };
};

/**
 * Reads the first user as a setting gives it: an object naming exactly one of `realmRole`, a realm role's
 * name read from a token's `realm_access.roles`, and `subject`, the `sub` claim at the identity provider.
 * Naming both or neither is refused, and so is any other member and an empty name.
 *
 * @param value the value as the source gives it.
 */
export const readFirstUser = (value: unknown): SettingReading<FirstUser> => {
	if (!isObject(value)) {
		return { kind: 'refused', rule: 'is not an object naming a realmRole or a subject' };
	}
	const names = Object.keys(value);
	if (!names.every((name) => name === 'realmRole' || name === 'subject')) {
		return { kind: 'refused', rule: 'holds a member other than realmRole or subject' };
	}
	if (names.length === 0) {
		return { kind: 'refused', rule: 'names neither realmRole nor subject, which exactly one of them must name' };
	}
	if (names.length === 2) {
		return { kind: 'refused', rule: 'names both realmRole and subject, which exactly one of them must name' };
	}
	return Object.hasOwn(value, 'realmRole')
		? readNamed('realmRole', value.realmRole)
		: readNamed('subject', value.subject);
};
