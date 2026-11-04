import type { NonEmpty } from '@overture-stack/usher-types';

import type { ControllerClient, ExchangeAnswer } from './core.js';
import { textWithin } from './responseBody.js';

/** The part of fetch needed to reach the controller, satisfied by the global fetch and by undici's. */
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

/** What the default controller client needs. */
export interface FetchControllerClientOptions {
  /** Signs a fresh channel assertion for each exchange. */
  assertion: () => Promise<string>;

  /** The controller's base URL, ending in `/`. */
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

/** How a status other than 200 reads: the controller's wire format fixes each. */
const answerForStatus = (status: number): ExchangeAnswer => {
  if (status === 403) {
    return { kind: 'refused' };
  }
  if (status === 401) {
    return { cause: 'assertionRefused', kind: 'unavailable' };
  }
  if (status === 408 || (status >= 500 && status <= 599)) {
    return { cause: 'status', kind: 'failed' };
  }
  return { cause: 'status', kind: 'unavailable' };
};

const tokenOf = async (
  response: Awaited<ReturnType<ControllerFetch>>,
  cap: number,
): Promise<ExchangeAnswer> => {
  const text = await textWithin(response, cap);
  return text === undefined ? TOO_LARGE : { kind: 'token', token: text.trim() };
};

/**
 * Creates the default controller client, which posts `{ credential, payloadVersions }` to the
 * controller's `exchange` endpoint, leaving `credential` out for the anonymous exchange. Each post is
 * authenticated by a fresh channel assertion and follows no redirect. Every answer other than a 200
 * is discarded unread, no body reaches a log, and a refusal of the assertion is never read as a
 * refusal of the identity. Each exchange resolves to:
 *
 * - for a 200, its token, read up to the cap and no further, or `unreadable` with `tokenTooLarge`
 *   past the cap;
 * - for a 401, `unavailable` with cause `assertionRefused`;
 * - for a 403, `refused`;
 * - for a 408 or a 5xx, `failed` with cause `status`;
 * - for any other status, `unavailable` with cause `status`;
 * - for a failure once the exchange's signal has aborted, `failed` with cause `timeout`;
 * - for any other failure, a redirect or a throw while signing included, `failed` with cause
 *   `network`.
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
        body: JSON.stringify(
          credential === null
            ? { payloadVersions }
            : { credential, payloadVersions },
        ),
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
      void response.body?.cancel().catch(() => undefined);
      return answerForStatus(response.status);
    } catch {
      return signal.aborted ? TIMED_OUT : NETWORK_FAILED;
    }
  },
});
