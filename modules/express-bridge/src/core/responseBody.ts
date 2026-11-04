import type { ControllerFetch } from './controllerClient.js';

type FetchResponse = Awaited<ReturnType<ControllerFetch>>;

/** The body's chunks up to the cap, or `undefined` once it passes the cap, having cancelled the rest. */
const chunksWithin = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  cap: number,
  received: readonly Uint8Array[] = [],
  size = 0,
): Promise<readonly Uint8Array[] | undefined> => {
  const { done, value } = await reader.read();
  if (done) {
    return received;
  }
  const total = size + value.byteLength;
  if (total > cap) {
    await reader.cancel();
    return undefined;
  }
  return chunksWithin(reader, cap, [...received, value], total);
};

/**
 * Reads a response's body as UTF-8 text, up to `cap` bytes and no further.
 *
 * - A declared length past the cap is refused before any byte is read, and a body that runs past the
 *   cap is cancelled there.
 * - A response with no body reads as empty text.
 * - It rejects when reading or cancelling the body rejects, as it does once the request's signal
 *   aborts.
 *
 * @returns the body's text, or `undefined` for a body past the cap.
 */
export const textWithin = async (
  response: FetchResponse,
  cap: number,
): Promise<string | undefined> => {
  const declared = Number(response.headers.get('content-length'));
  if (declared > cap) {
    await response.body?.cancel();
    return undefined;
  }
  const reader = response.body?.getReader();
  const chunks = reader === undefined ? [] : await chunksWithin(reader, cap);
  return chunks === undefined
    ? undefined
    : Buffer.concat(chunks).toString('utf8');
};
