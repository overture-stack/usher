import type { PollRequest } from './types.js';

/** What a poll answer echoes as `after` when the poll asked for head. */
export const HEAD = 'head';

// A nonce as the Bridge makes one: 16 to 128 base64url characters, unpadded.
const NONCE = /^[A-Za-z0-9_-]{16,128}$/u;

const POLL_PARAMETERS: ReadonlySet<string> = new Set([
  'after',
  'head',
  'nonce',
]);

/**
 * Reads a poll's query exactly: `head=true` or a non-empty `after`, exactly one of them, and a nonce of
 * 16 to 128 base64url characters, each sent once, and no other parameter. Values are read
 * percent-decoded.
 *
 * @param url the request's target, its path and query.
 * @returns the starting point and the nonce, or `undefined` for a query breaking any of those rules.
 */
export const readPollQuery = (url: string): PollRequest | undefined => {
  const separator = url.indexOf('?');
  const parameters = [
    ...new URLSearchParams(separator === -1 ? '' : url.slice(separator + 1)),
  ];
  const names = parameters.map(([name]) => name);
  const named = new Map(parameters);
  const after = named.get('after');
  const head = named.get('head');
  const nonce = named.get('nonce');
  const isWellFormed =
    new Set(names).size === names.length &&
    names.every((name) => POLL_PARAMETERS.has(name)) &&
    (after === undefined) !== (head === undefined) &&
    (head === undefined || head === 'true') &&
    after !== '' &&
    nonce !== undefined &&
    NONCE.test(nonce);
  if (isWellFormed) {
    return after === undefined
      ? { nonce, start: { kind: 'head' } }
      : { nonce, start: { cursor: after, kind: 'after' } };
  }
  return undefined;
};
