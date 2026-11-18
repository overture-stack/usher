import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { StoreLog } from './types.js';

/** The line naming a change to the CA file named by a database URL, read as a connection opened. */
export const CA_FILE_CHANGED = 'store.caFileChanged';

/** The line naming a CA file that could not be read as a connection opened, so that connection fails. */
export const CA_FILE_UNREADABLE = 'store.caFileUnreadable';

type Reading =
  { digest: string; kind: 'read' } | { code: string; kind: 'unreadable' };

const codeOf = (failure: unknown): string => {
  const code: unknown =
    typeof failure === 'object' && failure !== null && 'code' in failure
      ? failure.code
      : undefined;
  return typeof code === 'string' ? code : 'unreadable';
};

const readingOf = (path: string): { contents?: string; reading: Reading } => {
  try {
    const contents = readFileSync(path, 'utf8');
    return {
      contents,
      reading: {
        digest: createHash('sha256').update(contents).digest('hex'),
        kind: 'read',
      },
    };
  } catch (failure) {
    return { reading: { code: codeOf(failure), kind: 'unreadable' } };
  }
};

const isSame = (first: Reading, second: Reading): boolean =>
  first.kind === 'read'
    ? second.kind === 'read' && first.digest === second.digest
    : second.kind === 'unreadable' && first.code === second.code;

// The line a read writes, given the reading before it: none for a read finding what the one before
// found, nor for a first read finding the file, which the start read already.
const lineFor = (
  before: Reading | undefined,
  reading: Reading,
): 'changed' | 'unreadable' | undefined => {
  if (before !== undefined && isSame(before, reading)) {
    return undefined;
  }
  if (reading.kind === 'unreadable') {
    return 'unreadable';
  }
  return before === undefined ? undefined : 'changed';
};

/**
 * Reads the CA file named in `sslrootcert` by a database URL, each time it is called: its contents, or,
 * while it cannot be read, no certificate at all, so a connection verifying against it fails rather
 * than falling back to any other trust. The first read is taken as the file the start read, and
 * writes a line only when it fails. After it, a read finding other contents than the read before
 * writes {@link CA_FILE_CHANGED} at warning, and one failing where the read before did not, or for
 * another code, writes {@link CA_FILE_UNREADABLE} at error, naming the failure by its code; each
 * names the variable the URL is read from, and none the path or the contents.
 *
 * @param path the file `sslrootcert` names.
 * @param settings where the lines are written, and the variable they name.
 */
export const readCaFile = (
  path: string,
  {
    log,
    variable,
  }: { log: Pick<StoreLog, 'error' | 'warning'>; variable: string },
): (() => string | string[]) => {
  // The reading before, against which each read tells a change; none before the first.
  const previous: { reading?: Reading } = {};
  return () => {
    const { contents, reading } = readingOf(path);
    const line = lineFor(previous.reading, reading);
    previous.reading = reading;
    if (line === 'unreadable' && reading.kind === 'unreadable') {
      log.error(CA_FILE_UNREADABLE, { code: reading.code, variable });
    }
    if (line === 'changed') {
      log.warning(CA_FILE_CHANGED, { variable });
    }
    return contents ?? [];
  };
};
