import type { DisplayNameReading } from './types.js';

/**
 * The longest an application's display name may be, in characters once trimmed and normalized to NFC,
 * the form it is stored in.
 */
export const DISPLAY_NAME_MAXIMUM_LENGTH = 128;

/**
 * Reads a display name as it is stored: trimmed at both ends, whitespace inside kept, then normalized
 * to NFC, and its characters counted in that form, a character outside the Basic Multilingual Plane
 * counting once. One empty once trimmed, or longer than {@link DISPLAY_NAME_MAXIMUM_LENGTH}, is
 * refused.
 *
 * @param given the display name sent.
 */
export const readDisplayName = (given: string): DisplayNameReading => {
  const stored = given.trim().normalize('NFC');
  if (stored === '') {
    return { kind: 'refused', rule: 'blank' };
  }
  return [...stored].length > DISPLAY_NAME_MAXIMUM_LENGTH
    ? { kind: 'refused', rule: 'tooLong' }
    : { displayName: stored, kind: 'read' };
};
