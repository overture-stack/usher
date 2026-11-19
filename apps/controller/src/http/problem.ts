import type { Problem } from './types.js';

/**
 * A refusal's problem details: its code, the status it comes with, a title naming the rule broken, and
 * a detail saying what the caller can do. Neither text ever holds a value the request carried.
 *
 * @param code the problem's code.
 * @param status the HTTP status.
 * @param title the rule broken, in a few words.
 * @param detail what was wrong, and what to do about it.
 */
export const problem = (code: string, status: number, title: string, detail: string): Problem =>
	Object.freeze({ code, detail, status, title });
