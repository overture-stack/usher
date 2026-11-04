import { randomBytes } from 'node:crypto';
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  request as httpRequest,
} from 'node:http';
import { performance } from 'node:perf_hooks';

import type { Notice } from '@overture-stack/usher-types';
import { createParser, type EventSourceMessage } from 'eventsource-parser';

import {
  type ChannelReader,
  createChannelReader,
  importApplicationKey,
  NOTICE_VERSIONS,
  NOTICE_VERSIONS_HEADER,
  type NoticeReading,
  type PollAnswerReading,
  PUSH_BUFFER_CHARACTERS,
} from './bridgeWire.js';
import type { ControllerApplication } from './controller.js';
import {
  authorizationFor,
  mergedHeaders,
  type WireResponse,
} from './exchange.js';

/** What every channel request carries, with the departures the malformed-request tests need. */
export interface ChannelRequest {
  /** The application whose channel assertion authenticates the request, and whose subkeys decrypt the answer. */
  application: ControllerApplication;

  /** A channel assertion sent in place of a fresh one; `null` sends no `authorization` header. */
  assertion?: string | null;

  /** Headers merged over the bridge's, by lower-case name; one set to `undefined` is left out. */
  headers?: Readonly<Record<string, string | undefined>>;

  /** The notice versions header's value: the bridge's {@link NOTICE_VERSIONS}, comma-separated, by default. */
  versions?: string;
}

/** What one poll sends. */
export interface PollRequest extends ChannelRequest {
  /** The cursor to continue after; a head poll when absent. */
  after?: string;

  /** The nonce: 16 fresh random bytes, base64url, as the bridge makes it, by default. */
  nonce?: string;

  /** A raw query string, without its `?`, sent in place of the one the bridge builds. */
  query?: string;

  signal?: AbortSignal;
}

/** A poll's answer: the response, and the answer read as the bridge reads it. */
export interface PollResponse extends WireResponse {
  /** The answer read through the reproduced channel reader, for a 200; `undefined` for any other status. */
  answer: PollAnswerReading | undefined;

  /** What the poll sent, for the echo to be checked against: the cursor or `head`, and the nonce. */
  sent: { after: string; nonce: string };
}

/** Every notice from a cursor to the newest, as {@link pollAll} pages through them. */
export interface CaughtUp {
  /** The cursor the last page named, after which the next notice will be answered. */
  next: string;

  notices: readonly Notice[];

  /** How many pages the poll took. */
  pages: number;
}

/** What opening the notice stream sends. */
export interface StreamRequest extends ChannelRequest {
  /** The cursor sent as `last-event-id`; `null` leaves the header out. */
  lastEventId: string | null;

  /** Aborts the connection, its wait for the headers included, as {@link NoticeStream.close} does. */
  signal?: AbortSignal;
}

/**
 * One read of the notice stream. An event is everything up to and including a blank line, a comment
 * alone (a heartbeat) included, carrying when its last chunk arrived (`performance.now()`), its
 * bytes as received, what eventsource-parser dispatched for it, and for a `notice` event, the notice
 * read as the bridge reads it. The stream ends, or overflows once the bridge's parser would buffer
 * more than {@link PUSH_BUFFER_CHARACTERS}; nothing is read after either.
 */
export type StreamRead =
  | {
      arrivedAt: number;
      bytes: Uint8Array;
      comments: readonly string[];
      kind: 'event';
      message: EventSourceMessage | undefined;
      notice: NoticeReading | undefined;
    }
  | { arrivedAt: number; kind: 'ended' }
  | { arrivedAt: number; kind: 'overflow' };

/** An open notice stream, read from the moment it opens, so each arrival time is the chunk's own. */
export interface NoticeStream extends AsyncIterable<StreamRead> {
  /** Aborts the connection, settling once it has ended and every chunk read has been handled. */
  close(): Promise<void>;

  headers: Headers;

  /** The next read, waiting for it; `ended` for every call once the stream has ended or overflowed. */
  next(): Promise<StreamRead>;

  /**
   * The next read, waiting at most the time given, or `undefined` when nothing arrived by then. A
   * read arriving after a wait was given up is kept for the next call, never lost.
   */
  nextWithin(timeoutMs: number): Promise<StreamRead | undefined>;

  status: number;
}

const HEAD = 'head';

const channelReaderFor = async (
  application: ControllerApplication,
): Promise<ChannelReader> =>
  createChannelReader(await importApplicationKey(application.key));

// Follows poll.ts `query`.
const pollQuery = (after: string | undefined, nonce: string): string =>
  new URLSearchParams(
    after === undefined ? { head: 'true', nonce } : { after, nonce },
  ).toString();

/**
 * Sends `GET notices`, relative to the controller's URL, exactly as the bridge's poll sends a page:
 * `head=true` or `after`, then a fresh `nonce`, as the query; `accept: application/jose`,
 * `authorization: Bearer` and a fresh channel assertion, and the notice versions header. A 200's
 * body is read, trimmed, through the reproduced channel reader. Follows `poll.ts` `createPoll`, its
 * `fetchPage` and `query`.
 *
 * @param controllerUrl the controller's URL, ending in `/`.
 * @param request the application, the cursor and any departure from the bridge's request.
 */
export const poll = async (
  controllerUrl: URL,
  {
    after,
    application,
    assertion,
    headers = {},
    nonce = randomBytes(16).toString('base64url'),
    query,
    signal,
    versions = NOTICE_VERSIONS.join(','),
  }: PollRequest,
): Promise<PollResponse> => {
  const response = await fetch(
    new URL(`notices?${query ?? pollQuery(after, nonce)}`, controllerUrl),
    {
      headers: mergedHeaders(
        {
          accept: 'application/jose',
          ...(await authorizationFor(application, assertion)),
          [NOTICE_VERSIONS_HEADER]: versions,
        },
        headers,
      ),
      method: 'GET',
      redirect: 'manual',
      ...(signal === undefined ? {} : { signal }),
    },
  );
  const body = await response.text();
  return {
    answer:
      response.status === 200
        ? await (
            await channelReaderFor(application)
          ).readPollAnswer(body.trim())
        : undefined,
    body,
    headers: response.headers,
    sent: { after: after ?? HEAD, nonce },
    status: response.status,
  };
};

const pagesFrom = async (
  controllerUrl: URL,
  application: ControllerApplication,
  after: string | undefined,
  read: CaughtUp,
  requested: ReadonlySet<string>,
): Promise<CaughtUp> => {
  const page = await poll(controllerUrl, {
    application,
    ...(after === undefined ? {} : { after }),
  });
  if (page.answer?.kind !== 'answer') {
    throw new Error(
      `the poll after ${page.sent.after} was answered ${page.status}${page.answer === undefined ? '' : `, ${page.answer.reason}`}`,
    );
  }
  const { answer } = page.answer;
  if (answer.nonce !== page.sent.nonce || answer.after !== page.sent.after) {
    throw new Error(
      `the poll after ${page.sent.after} was answered with another request's echo`,
    );
  }
  if (answer.more && requested.has(answer.next)) {
    throw new Error(
      `the poll after ${page.sent.after} asked for more from a cursor already asked after`,
    );
  }
  const caughtUp: CaughtUp = {
    next: answer.next,
    notices: [...read.notices, ...answer.notices],
    pages: read.pages + 1,
  };
  return answer.more
    ? pagesFrom(
        controllerUrl,
        application,
        answer.next,
        caughtUp,
        new Set([...requested, answer.next]),
      )
    : caughtUp;
};

/**
 * Polls from a cursor, or from head when none is given, page by page while each answer asks for
 * more, as the bridge's check does. Each answer must be a 200 that reads, echoes its request, and
 * never asks for more from a cursor already asked after; anything else throws, naming the status or
 * the bridge's reason. A head poll answers no notices, so its `next` is the cursor a test calls c0.
 *
 * @param controllerUrl the controller's URL, ending in `/`.
 * @param options the application, and the cursor to start after.
 */
export const pollAll = (
  controllerUrl: URL,
  {
    after,
    application,
  }: { after?: string; application: ControllerApplication },
): Promise<CaughtUp> =>
  pagesFrom(
    controllerUrl,
    application,
    after,
    { next: after ?? HEAD, notices: [], pages: 0 },
    new Set(after === undefined ? [] : [after]),
  );

interface SplitText {
  blocks: readonly string[];
  rest: string;
}

// An event ends at a blank line, its terminator a CR, an LF or a CR LF. A CR closing the text may be
// the first half of a CR LF, so it waits for the next chunk.
const completeEvents = (text: string): SplitText => {
  const terminators = [...text.matchAll(/\r\n|\n|\r/gu)].flatMap((match) =>
    match[0] === '\r' && match.index === text.length - 1
      ? []
      : [{ end: match.index + match[0].length, start: match.index }],
  );
  const ends = terminators.flatMap(({ end, start }, index) =>
    start === (terminators[index - 1]?.end ?? 0) ? [end] : [],
  );
  return {
    blocks: ends.map((end, index) => text.slice(ends[index - 1] ?? 0, end)),
    rest: text.slice(ends.at(-1) ?? 0),
  };
};

const streamOf = (
  response: Response,
  connection: AbortController,
  reader: ChannelReader,
): NoticeStream => {
  const delivery: {
    finished: boolean;
    pending: string;
    processing: Promise<void>;
    queue: StreamRead[];
    waiting: ((read: StreamRead) => void)[];
  } = {
    finished: false,
    pending: '',
    processing: Promise.resolve(),
    queue: [],
    waiting: [],
  };
  const deliver = (read: StreamRead): void => {
    const waiter = delivery.waiting.shift();
    if (waiter === undefined) {
      delivery.queue.push(read);
      return;
    }
    waiter(read);
  };
  const finish = (read: StreamRead): void => {
    if (delivery.finished) {
      return;
    }
    delivery.finished = true;
    deliver(read);
  };

  const overflow = { seen: false };
  const overflowParser = createParser({
    maxBufferSize: PUSH_BUFFER_CHARACTERS,
    onError: (error) => {
      if (error.type === 'max-buffer-size-exceeded') {
        overflow.seen = true;
      }
    },
    onEvent: () => undefined,
  });
  const dispatched: {
    comments: string[];
    message: EventSourceMessage | undefined;
  } = { comments: [], message: undefined };
  const eventParser = createParser({
    onComment: (comment) => dispatched.comments.push(comment),
    onEvent: (message) => {
      dispatched.message = message;
    },
  });
  const parsed = (
    block: string,
  ): {
    comments: readonly string[];
    message: EventSourceMessage | undefined;
  } => {
    dispatched.comments = [];
    dispatched.message = undefined;
    eventParser.feed(block);
    return { comments: dispatched.comments, message: dispatched.message };
  };

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const handle = async (
    chunk: Uint8Array,
    arrivedAt: number,
  ): Promise<void> => {
    if (delivery.finished) {
      return;
    }
    const text = decoder.decode(chunk, { stream: true });
    overflowParser.feed(text);
    if (overflow.seen) {
      finish({ arrivedAt, kind: 'overflow' });
      connection.abort();
      return;
    }
    const { blocks, rest } = completeEvents(delivery.pending + text);
    delivery.pending = rest;
    const reads = await Promise.all(
      blocks.map(async (block) => {
        const { comments, message } = parsed(block);
        return {
          arrivedAt,
          bytes: encoder.encode(block),
          comments,
          kind: 'event' as const,
          message,
          notice:
            message?.event === 'notice'
              ? await reader.readNotice(message.data)
              : undefined,
        };
      }),
    );
    reads.forEach(deliver);
  };

  // Chunks are read as soon as they arrive, each timed then, and handled in turn after.
  const pumped = async (
    body: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<void> => {
    const { done, value } = await body.read();
    if (done) {
      return;
    }
    const arrivedAt = performance.now();
    delivery.processing = delivery.processing.then(() =>
      handle(value, arrivedAt),
    );
    await pumped(body);
  };
  const body = response.body?.getReader();
  const reading = (body === undefined ? Promise.resolve() : pumped(body))
    .catch(() => undefined)
    .then(async () => {
      await delivery.processing;
      finish({ arrivedAt: performance.now(), kind: 'ended' });
    });

  const next = (): Promise<StreamRead> => {
    const queued = delivery.queue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (delivery.finished) {
      return Promise.resolve({ arrivedAt: performance.now(), kind: 'ended' });
    }
    return new Promise((resolve) => delivery.waiting.push(resolve));
  };

  const nextWithin = (timeoutMs: number): Promise<StreamRead | undefined> => {
    const queued = delivery.queue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (delivery.finished) {
      return Promise.resolve({ arrivedAt: performance.now(), kind: 'ended' });
    }
    return new Promise((resolve) => {
      const waiter = (read: StreamRead): void => {
        clearTimeout(timer);
        resolve(read);
      };
      const timer = setTimeout(() => {
        delivery.waiting = delivery.waiting.filter(
          (waiting) => waiting !== waiter,
        );
        resolve(undefined);
      }, timeoutMs);
      delivery.waiting.push(waiter);
    });
  };

  return {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<StreamRead>> => {
        const read = await next();
        return read.kind === 'event'
          ? { done: false, value: read }
          : { done: true, value: read };
      },
    }),

    close: async () => {
      connection.abort();
      await body?.cancel().catch(() => undefined);
      await reading;
    },

    headers: response.headers,
    next,
    nextWithin,
    status: response.status,
  };
};

/**
 * Opens `GET notices/stream`, relative to the controller's URL, exactly as the bridge's push opens
 * it: `accept: text/event-stream`, `authorization: Bearer` and a fresh channel assertion,
 * `last-event-id`, and the notice versions header, through the global fetch as the bridge's default.
 * The body is read from the moment the headers arrive, as the bridge reads it: each chunk decoded as
 * streamed UTF-8 and fed to an eventsource-parser holding the bridge's buffer limit, so an overflow
 * ends the stream where the bridge's would end, its connection aborted as the bridge aborts it.
 * Follows `push.ts` `createPush`, its `connect` and `read`.
 *
 * @param controllerUrl the controller's URL, ending in `/`.
 * @param request the application, the cursor and any departure from the bridge's request.
 */
export const openStream = async (
  controllerUrl: URL,
  {
    application,
    assertion,
    headers = {},
    lastEventId,
    signal,
    versions = NOTICE_VERSIONS.join(','),
  }: StreamRequest,
): Promise<NoticeStream> => {
  const reader = await channelReaderFor(application);
  const connection = new AbortController();
  const response = await fetch(new URL('notices/stream', controllerUrl), {
    headers: mergedHeaders(
      {
        accept: 'text/event-stream',
        ...(await authorizationFor(application, assertion)),
        ...(lastEventId === null ? {} : { 'last-event-id': lastEventId }),
        [NOTICE_VERSIONS_HEADER]: versions,
      },
      headers,
    ),
    method: 'GET',
    redirect: 'manual',
    signal:
      signal === undefined
        ? connection.signal
        : AbortSignal.any([connection.signal, signal]),
  });
  return streamOf(response, connection, reader);
};

/** One chunk of a raw stream's body, as it arrived. */
export interface RawChunk {
  /** When it arrived: `performance.now()`. */
  arrivedAt: number;

  bytes: Buffer;
}

/** The notice stream read at the socket, for a test that times bytes or stops reading. */
export interface RawStream {
  /** Every chunk of the body read so far. */
  chunks(): readonly RawChunk[];

  /** Ends the connection, settling once it has closed. */
  close(): Promise<void>;

  /** Settles once the body has ended or the connection has closed, with when that was seen. */
  ended: Promise<number>;

  headers: IncomingHttpHeaders;

  /** When the response's headers arrived: `performance.now()`. */
  headersAt: number;

  /** Stops reading from the socket, so the controller's writes back up. */
  pause(): void;

  /** Reads from the socket again. */
  resume(): void;

  /** When the request was sent: `performance.now()`. */
  sentAt: number;

  status: number;

  /** The body read so far, as UTF-8. */
  text(): string;
}

/** What opening a raw stream sends: the bridge's request, with the departures a test needs. */
export interface RawStreamRequest extends ChannelRequest {
  /** The cursor sent as `last-event-id`; `null` leaves the header out. */
  lastEventId: string | null;
}

/**
 * Opens `GET notices/stream` with the bridge's own headers over a plain http connection of its own,
 * below fetch, reading the body chunk by chunk as it arrives, each timed, and able to stop reading so
 * the controller's writes back up. The connection ends at {@link RawStream.close}.
 *
 * @param controllerUrl the controller's URL, ending in `/`.
 * @param request the application, the cursor and any departure from the bridge's request.
 */
export const openRawStream = async (
  controllerUrl: URL,
  {
    application,
    assertion,
    headers = {},
    lastEventId,
    versions = NOTICE_VERSIONS.join(','),
  }: RawStreamRequest,
): Promise<RawStream> => {
  const requestHeaders = mergedHeaders(
    {
      accept: 'text/event-stream',
      ...(await authorizationFor(application, assertion)),
      ...(lastEventId === null ? {} : { 'last-event-id': lastEventId }),
      [NOTICE_VERSIONS_HEADER]: versions,
    },
    headers,
  );
  const sentAt = performance.now();
  const sent = httpRequest(new URL('notices/stream', controllerUrl), {
    agent: false,
    headers: requestHeaders,
    method: 'GET',
  });
  const closed = new Promise<void>((resolve) => {
    sent.once('close', () => resolve());
  });
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    sent.once('response', resolve);
    sent.once('error', reject);
    sent.end();
  });
  sent.on('error', () => undefined);
  const headersAt = performance.now();
  const chunks: RawChunk[] = [];
  response.on('data', (bytes: Buffer) => {
    chunks.push({ arrivedAt: performance.now(), bytes });
  });
  response.on('error', () => undefined);
  const ended = new Promise<number>((resolve) => {
    response.once('end', () => resolve(performance.now()));
    response.once('close', () => resolve(performance.now()));
  });
  return {
    chunks: () => [...chunks],
    close: async () => {
      sent.destroy();
      await closed;
    },
    ended,
    headers: response.headers,
    headersAt,
    pause: () => {
      response.pause();
    },
    resume: () => {
      response.resume();
    },
    sentAt,
    status: response.statusCode ?? 0,
    text: () =>
      Buffer.concat(chunks.map(({ bytes }) => bytes)).toString('utf8'),
  };
};
