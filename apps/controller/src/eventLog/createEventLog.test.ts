import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { suite, test } from 'node:test';

import type { Clock } from '../configuration/index.js';
import { createEventLog } from './createEventLog.js';
import type { EventEnvelope, Severity } from './types.js';

const NOW = Date.UTC(2026, 10, 4, 12, 30, 5, 120);

const FIXED_CLOCK: Clock = Object.freeze({ now: () => NOW });

interface Capture {
  /** Each line written so far, parsed. */
  parsed(): readonly Readonly<Record<string, unknown>>[];

  /** Everything written so far, as one text. */
  text(): string;

  stream: Writable;
}

const capture = (): Capture => {
  const chunks: string[] = [];
  const stream = new Writable({
    write: (chunk: unknown, _encoding, callback) => {
      chunks.push(String(chunk));
      callback();
    },
  });
  const text = (): string => chunks.join('');
  return {
    parsed: () =>
      text()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>),
    stream,
    text,
  };
};

// A stream refusing every write once told to, as a sink that has failed does.
const refusingStream = (): {
  refusing: { now: boolean };
  stream: Writable;
  taken: string[];
} => {
  const refusing = { now: false };
  const taken: string[] = [];
  const stream = new Writable({
    write: (chunk: unknown, _encoding, callback) => {
      if (refusing.now) {
        callback(new Error('the sink refused a write'));
      } else {
        taken.push(String(chunk));
        callback();
      }
    },
  });
  return { refusing, stream, taken };
};

// Every callback a write's settling queues has run.
const settled = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const occurrences = (text: string, member: string): number =>
  text.split(`"${member}":`).length - 1;

const envelope = (severity: Severity): EventEnvelope => ({
  data: { actorId: null, actorType: 'system', instance: 'usher-test-1' },
  id: '7d0f5c1e-4b8a-4f43-9d55-3a4f1c2b9e10',
  severity,
  source: 'https://usher.example.org/controller',
  specversion: '1.0',
  time: '2026-11-04T12:30:05.120Z',
  type: 'bio.overture.applicationKey.confirmation',
});

suite('the log stream', () => {
  test("writes an operational line as one JSON object: the logger's level, its message, its fields and the time read from the clock in UTC", () => {
    const { parsed, stream, text } = capture();
    const log = createEventLog({ clock: FIXED_CLOCK, logStream: stream });

    log.warning('store.grantBeyondUse', {
      object: 'users',
      privilege: 'INSERT',
    });

    assert.equal(text().endsWith('\n'), true);
    assert.equal(text().split('\n').length, 2);
    assert.deepEqual(parsed(), [
      {
        level: 40,
        message: 'store.grantBeyondUse',
        object: 'users',
        privilege: 'INSERT',
        time: '2026-11-04T12:30:05.120Z',
      },
    ]);
  });

  test("writes info, warning and error lines at the logger's info, warn and error levels", () => {
    const { parsed, stream } = capture();
    const log = createEventLog({ clock: FIXED_CLOCK, logStream: stream });

    log.info('egoImport.dryRun');
    log.warning('store.grantBeyondUse');
    log.error('store.idleConnectionLost');

    assert.deepEqual(
      parsed().map(({ level, message }) => [message, level]),
      [
        ['egoImport.dryRun', 30],
        ['store.grantBeyondUse', 40],
        ['store.idleConnectionLost', 50],
      ],
    );
  });

  test('keeps its own level, message and time when fields name them, writing each member once', () => {
    const { parsed, stream, text } = capture();
    const log = createEventLog({ clock: FIXED_CLOCK, logStream: stream });

    log.error('store.idleConnectionLost', {
      failure: 'read ECONNRESET',
      level: 'trace',
      message: 'another name',
      time: '1970-01-01T00:00:00Z',
    });

    assert.deepEqual(parsed(), [
      {
        failure: 'read ECONNRESET',
        level: 50,
        message: 'store.idleConnectionLost',
        time: '2026-11-04T12:30:05.120Z',
      },
    ]);
    ['failure', 'level', 'message', 'time'].forEach((member) => {
      assert.equal(occurrences(text(), member), 1, member);
    });
  });

  test("writes an event's line as its envelope alone, a critical event at the logger's error level", () => {
    const { parsed, stream } = capture();
    const log = createEventLog({ clock: FIXED_CLOCK, logStream: stream });
    const severities: readonly Severity[] = [
      'info',
      'warning',
      'error',
      'critical',
    ];

    severities.forEach((severity) => {
      log.writeEvent(envelope(severity));
    });

    assert.deepEqual(
      parsed(),
      severities.map((severity) => ({
        ...envelope(severity),
        level: { critical: 50, error: 50, info: 30, warning: 40 }[severity],
      })),
    );
  });

  test("writes an event's dataschema where it names one, and no member where it names none", () => {
    const { parsed, stream } = capture();
    const log = createEventLog({ clock: FIXED_CLOCK, logStream: stream });

    log.writeEvent({
      ...envelope('info'),
      dataschema: 'https://overture.bio/schemas/applicationKey.confirmation',
    });
    log.writeEvent(envelope('info'));

    assert.deepEqual(
      parsed().map((line) => line['dataschema']),
      ['https://overture.bio/schemas/applicationKey.confirmation', undefined],
    );
    assert.equal(Object.hasOwn(parsed()[1] ?? {}, 'dataschema'), false);
  });

  test('keeps each line one JSON object when its values hold quotes, backslashes, line breaks, U+2028 and markup', () => {
    const { parsed, stream, text } = capture();
    const log = createEventLog({ clock: FIXED_CLOCK, logStream: stream });
    const awkward = 'a "quoted"\\ value\non\r\nlines <script>&amp;';

    log.writeEvent({
      ...envelope('info'),
      data: { ...envelope('info').data, reason: awkward },
    });
    log.info('egoImport.dryRun', { actorId: awkward });

    assert.equal(text().split('\n').length, 3);
    assert.deepEqual(
      parsed().map((line) =>
        line['data'] === undefined
          ? line['actorId']
          : (line['data'] as Readonly<Record<string, unknown>>)['reason'],
      ),
      [awkward, awkward],
    );
  });

  test('never throws for a line the stream refuses, reporting itself unwritable from then on, and the error the stream emits ends nothing', async () => {
    const { refusing, stream, taken } = refusingStream();
    const log = createEventLog({ clock: FIXED_CLOCK, logStream: stream });

    log.info('first');
    await settled();
    const writableBefore = log.isWritable();
    refusing.now = true;
    assert.doesNotThrow(() => {
      log.writeEvent(envelope('critical'));
    });
    await settled();
    const writableWhileRefused = log.isWritable();
    refusing.now = false;
    log.info('after');
    await settled();

    assert.equal(writableBefore, true);
    assert.equal(writableWhileRefused, false);
    assert.equal(log.isWritable(), false);
    assert.deepEqual(
      taken.map((line) => (JSON.parse(line) as { message: unknown }).message),
      ['first'],
    );
  });

  test('drops a line whose write throws, reporting itself unwritable', async () => {
    const stream = new Writable({
      write: () => {
        throw new Error('the sink threw');
      },
    });
    const log = createEventLog({ clock: FIXED_CLOCK, logStream: stream });

    assert.doesNotThrow(() => {
      log.info('thrown');
    });
    await settled();

    assert.equal(log.isWritable(), false);
  });

  test('listens to the stream only once it writes, and lets go once closed and its lines have settled, writing nothing after', async () => {
    const { parsed, stream } = capture();
    const log = createEventLog({ clock: FIXED_CLOCK, logStream: stream });
    const listenersBefore = stream.listenerCount('error');

    log.info('before closing');
    const listenersWhileWriting = stream.listenerCount('error');
    log.close();
    await settled();
    const listenersAfter = stream.listenerCount('error');
    log.info('after closing');
    log.writeEvent(envelope('info'));
    await settled();

    assert.equal(listenersBefore, 0);
    assert.equal(listenersWhileWriting, 1);
    assert.equal(listenersAfter, 0);
    assert.deepEqual(
      parsed().map(({ message }) => message),
      ['before closing'],
    );
    assert.equal(stream.listenerCount('error'), 0);
  });
});
