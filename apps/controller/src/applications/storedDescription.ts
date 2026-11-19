/**
 * A description as it is stored: trimmed at both ends, and none for one sent empty once trimmed, or
 * not sent.
 *
 * @param given the description sent, if any.
 */
export const storedDescription = (given: string | undefined): string | null => {
	const trimmed = given?.trim() ?? '';
	return trimmed === '' ? null : trimmed;
};
