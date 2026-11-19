import type { JsonReading } from './types.js';

// A string token, or one of the characters that open, close or separate a structure: once the text
// has parsed, these are the only tokens that tell a member's name from a value, since no number or
// literal holds any of them.
const STRUCTURE = /"(?:[^"\\]|\\[^])*"|[{}[\],]/gu;

// A member named so that an object built from it naively would replace its prototype.
const PROTOTYPE_MEMBER = '__proto__';

const nameOf = (token: string): string => {
	const parsed: unknown = JSON.parse(token);
	return String(parsed);
};

// A scan over text already parsed, so every token is well formed: each open object holds the names
// it has met, and a string read where a name is expected is one.
const departureOf = (text: string): string | undefined => {
	const objects: (Set<string> | undefined)[] = [];
	const position = { expectingName: false };
	for (const [token] of text.matchAll(STRUCTURE)) {
		if (token === '{') {
			objects.push(new Set());
			position.expectingName = true;
		} else if (token === '[') {
			objects.push(undefined);
			position.expectingName = false;
		} else if (token === '}' || token === ']') {
			objects.pop();
			position.expectingName = false;
		} else if (token === ',') {
			position.expectingName = objects.at(-1) !== undefined;
		} else if (position.expectingName) {
			const names = objects.at(-1);
			const name = nameOf(token);
			if (name === PROTOTYPE_MEMBER) {
				return `holds a member named ${PROTOTYPE_MEMBER}`;
			}
			if (names?.has(name) === true) {
				return 'names a member twice in one object';
			}
			names?.add(name);
			position.expectingName = false;
		}
	}
	return undefined;
};

/**
 * Reads JSON text strictly: text JSON parses is refused still when an object in it names a member
 * twice, which a parser keeps the last of, or holds a member named `__proto__` at any depth. A rule
 * names what is wrong and never quotes the text.
 *
 * @param text the text.
 */
export const readStrictJson = (text: string): JsonReading => {
	const parsed = ((): { value: unknown } | undefined => {
		try {
			return { value: JSON.parse(text) };
		} catch {
			return undefined;
		}
	})();
	if (parsed === undefined) {
		return { kind: 'refused', rule: 'is not JSON' };
	}
	const departure = departureOf(text);
	return departure === undefined ? { kind: 'read', value: parsed.value } : { kind: 'refused', rule: departure };
};
