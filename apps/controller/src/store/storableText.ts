/**
 * Whether text can be stored and recorded as given: PostgreSQL's text and JSON hold no NUL character,
 * and no unpaired surrogate has a UTF-8 form, so either would fail a write or be replaced silently.
 *
 * @param text the text.
 */
export const isStorableText = (text: string): boolean => text.isWellFormed() && !text.includes('\u0000');

/**
 * Whether a parsed JSON value holds, at any depth, a string or a member name that is not
 * {@link isStorableText}.
 *
 * @param value the value.
 */
export const holdsUnstorableText = (value: unknown): boolean => {
	if (typeof value === 'string') {
		return !isStorableText(value);
	}
	if (Array.isArray(value)) {
		return value.some(holdsUnstorableText);
	}
	if (typeof value === 'object' && value !== null) {
		return Object.entries(value).some(([name, held]) => !isStorableText(name) || holdsUnstorableText(held));
	}
	return false;
};
