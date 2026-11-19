import type { NonEmpty } from '@overture-stack/usher-types';

import type { ControllerClient, ExchangeAnswer } from './core.js';
import { textWithin } from './responseBody.js';

/** The part of fetch needed to reach the Controller, satisfied by the global fetch and by undici's. */
export type ControllerFetch = (
	url: URL,
	init: {
		body?: string;
		headers: Record<string, string>;
		method: string;
		redirect: 'error';
		signal: AbortSignal;
	},
) => Promise<{
	body: ReadableStream<Uint8Array> | null;
	headers: { get(name: string): string | null };
	status: number;
}>;

/** What the default Controller client needs. */
export interface FetchControllerClientOptions {
	/** Signs a fresh channel assertion for each exchange. */
	assertion: () => Promise<string>;

	/** The Controller's base URL, ending in `/`. */
	controllerUrl: URL;

	/** The fetch used for every exchange; the global `fetch` when omitted. */
	fetch?: ControllerFetch;

	/** The payload versions listed in every exchange request. */
	payloadVersions: NonEmpty<number>;

	/** The most bytes read from an answer before it is refused unread. */
	responseCapBytes: number;
}

const TIMED_OUT: ExchangeAnswer = Object.freeze({
	cause: 'timeout',
	kind: 'failed',
});
const NETWORK_FAILED: ExchangeAnswer = Object.freeze({
	cause: 'network',
	kind: 'failed',
});
const TOO_LARGE: ExchangeAnswer = Object.freeze({
	kind: 'unreadable',
	reason: 'tokenTooLarge',
});
const FAILED_BY_STATUS: ExchangeAnswer = Object.freeze({
	cause: 'status',
	kind: 'failed',
});

/** The most bytes of a 503's body read for its problem code: 2 KiB. */
const PROBLEM_READ_CAP_BYTES = 2_048;

/** The 503 problem code shedding the application's exchanges, and the only one compared. */
const ADMISSION_SHARE_EXCEEDED = 'admissionShareExceeded';

const RETRY_AFTER_GRAMMAR = /^[0-9]{1,6}$/u;

/**
 * Reads a `Retry-After` value, the whole header as fetch returns it, as whole seconds: 1 to 6 ASCII
 * digits naming at least one second. An HTTP-date, a sign, a fraction, several values, 0, and
 * anything else read as absent.
 *
 * @returns the seconds named, or `undefined` for a value outside that grammar or no value.
 */
export const retryAfterSecondsOf = (value: string | null): number | undefined => {
	const seconds = value !== null && RETRY_AFTER_GRAMMAR.test(value) ? Number(value) : 0;
	return seconds > 0 ? seconds : undefined;
};

/** Whether a 503's body names `admissionShareExceeded` as its problem code, compared whole. */
const namesAdmissionShareExceeded = (text: string | undefined): boolean => {
	try {
		const problem: unknown = JSON.parse(text ?? '');
		return (
			typeof problem === 'object' &&
			problem !== null &&
			Object.getOwnPropertyDescriptor(problem, 'code')?.value === ADMISSION_SHARE_EXCEEDED
		);
	} catch {
		return false;
	}
};

type FetchResponse = Awaited<ReturnType<ControllerFetch>>;

/**
 * How a 503 reads, from its `Retry-After` and the problem code of a body read no further than 2 KiB,
 * past which the rest is cancelled. A body past that, or one that is not a problem naming
 * `admissionShareExceeded`, reads as any other code. It rejects when reading the body does.
 */
const answerFor503 = async (response: FetchResponse, responseCapBytes: number): Promise<ExchangeAnswer> => {
	const retryAfterSeconds = retryAfterSecondsOf(response.headers.get('retry-after'));
	const text = await textWithin(response, Math.min(PROBLEM_READ_CAP_BYTES, responseCapBytes));
	if (namesAdmissionShareExceeded(text)) {
		return { kind: 'admissionShareExceeded', retryAfterSeconds };
	}
	return retryAfterSeconds === undefined ? FAILED_BY_STATUS : { kind: 'retryAfter', retryAfterSeconds };
};

/** How a status other than 200 and 503 reads: the Controller's wire format fixes each. */
const answerForStatus = (status: number): ExchangeAnswer => {
	if (status === 403) {
		return { kind: 'refused' };
	}
	if (status === 401) {
		return { cause: 'assertionRefused', kind: 'unavailable' };
	}
	if (status === 408 || (status >= 500 && status <= 599)) {
		return FAILED_BY_STATUS;
	}
	return { cause: 'status', kind: 'unavailable' };
};

const tokenOf = async (response: FetchResponse, cap: number): Promise<ExchangeAnswer> => {
	const text = await textWithin(response, cap);
	return text === undefined ? TOO_LARGE : { kind: 'token', token: text.trim() };
};

/**
 * Creates the default Controller client, which posts `{ credential, payloadVersions }` to the
 * Controller's `exchange` endpoint, leaving `credential` out for the anonymous exchange. Each post is
 * authenticated by a fresh channel assertion and follows no redirect. A 503's body is read for its
 * problem code alone, no further than 2 KiB or the response cap, whichever is smaller, and the rest is
 * cancelled. Every other answer but a 200 is discarded unread. No body reaches a log, and a refusal of
 * the assertion is never read as a refusal of the identity. Each exchange resolves to:
 *
 * - for a 200, its token, read up to the cap and no further, or `unreadable` with `tokenTooLarge`
 *   past the cap;
 * - for a 401, `unavailable` with cause `assertionRefused`;
 * - for a 403, `refused`;
 * - for a 503 whose problem code is `admissionShareExceeded`, `admissionShareExceeded`, with the
 *   seconds of a valid `Retry-After` or none;
 * - for any other 503 carrying a valid `Retry-After`, `retryAfter` with its seconds, whatever its body
 *   holds;
 * - for a 408 or any other 5xx, `failed` with cause `status`;
 * - for any other status, `unavailable` with cause `status`;
 * - for a failure once the exchange's signal has aborted, `failed` with cause `timeout`;
 * - for any other failure, a redirect, a throw while signing and a failure reading a 503's body
 *   included, `failed` with cause `network`.
 *
 * A valid `Retry-After` is the whole header, 1 to 6 ASCII digits naming at least one second, as
 * {@link retryAfterSecondsOf} reads it.
 */
export const createFetchControllerClient = ({
	assertion,
	controllerUrl,
	fetch = globalThis.fetch,
	payloadVersions,
	responseCapBytes,
}: FetchControllerClientOptions): ControllerClient => ({
	exchange: async ({ credential, signal }) => {
		try {
			const response = await fetch(new URL('exchange', controllerUrl), {
				body: JSON.stringify(credential === null ? { payloadVersions } : { credential, payloadVersions }),
				headers: {
					accept: 'application/jwt',
					authorization: `Bearer ${await assertion()}`,
					'content-type': 'application/json',
				},
				method: 'POST',
				redirect: 'error',
				signal,
			});
			if (response.status === 200) {
				return await tokenOf(response, responseCapBytes);
			}
			if (response.status === 503) {
				return await answerFor503(response, responseCapBytes);
			}
			void response.body?.cancel().catch(() => undefined);
			return answerForStatus(response.status);
		} catch {
			return signal.aborted ? TIMED_OUT : NETWORK_FAILED;
		}
	},
});
