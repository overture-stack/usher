const BASE64URL = /^[A-Za-z0-9_-]+$/u;

// An id as the store writes a grant's or a grant request's, in lower case.
const STORED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * The cursor of the page after the one ending with a grant or a grant request: its id, as unpadded
 * base64url of its text.
 *
 * @param id the id of the last entry on the page.
 */
export const cursorAfterId = (id: string): string => Buffer.from(id, 'utf8').toString('base64url');

/**
 * The id a cursor names, read only from the form {@link cursorAfterId} writes for an id in the
 * store's form: any other text names none.
 *
 * @param cursor the cursor sent.
 * @returns the id, or `undefined` for a cursor no listing gave.
 */
export const idOfCursor = (cursor: string): string | undefined => {
	if (!BASE64URL.test(cursor)) {
		return undefined;
	}
	const id = Buffer.from(cursor, 'base64url').toString('utf8');
	return STORED_ID.test(id) && cursorAfterId(id) === cursor ? id : undefined;
};
