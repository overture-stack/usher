import type { Writable } from 'node:stream';

import { pino } from 'pino';

import { eventInstant } from './eventInstant.js';
import type {
  EventLog,
  EventLogSettings,
  LineFields,
  Severity,
} from './types.js';

type LoggerLevel = 'error' | 'info' | 'warn';

// The logger has no critical level, so a critical event is written at error, the most severe it has
// below fatal, which is kept for a process that cannot go on.
const LEVELS = {
  critical: 'error',
  error: 'error',
  info: 'info',
  warning: 'warn',
} as const satisfies Readonly<Record<Severity, LoggerLevel>>;

// The members the log writes itself on an operational line. The logger writes `level` without
// looking at the object it is given, so a field of that name would appear twice.
const LOG_MEMBERS: ReadonlySet<string> = new Set(['level', 'message', 'time']);

interface Sink {
  close(): void;
  fail(): void;
  isWritable(): boolean;
  write(line: string): void;
}

// A stream emitting an error with nobody listening ends the process, so the sink listens while any
// line it wrote is in flight, and lets go once it is closed and every one has settled: the stream is
// the configuration's, and other Controllers may be writing to it.
const createSink = (stream: Writable): Sink => {
  const state = { listening: false, open: true, pending: 0, writable: true };
  const fail = (): void => {
    state.writable = false;
  };
  const letGoOnceSettled = (): void => {
    if (!state.open && state.pending === 0 && state.listening) {
      stream.off('error', fail);
      state.listening = false;
    }
  };
  // A write that throws may also call back, and its outcome is counted once.
  const settlement = (): ((error?: Error | null) => void) => {
    const write = { settled: false };
    return (error) => {
      if (!write.settled) {
        write.settled = true;
        state.pending -= 1;
        if (error !== null && error !== undefined) {
          fail();
        }
        letGoOnceSettled();
      }
    };
  };
  return {
    close: () => {
      state.open = false;
      letGoOnceSettled();
    },
    fail,
    isWritable: () => state.writable,
    write: (line) => {
      if (state.open) {
        if (!state.listening) {
          stream.on('error', fail);
          state.listening = true;
        }
        state.pending += 1;
        const settle = settlement();
        try {
          stream.write(line, settle);
        } catch {
          settle(new Error('the log stream threw on a write'));
        }
      }
    },
  };
};

/**
 * Creates the Controller's log stream over the configured stream, connecting nothing until its first
 * line. An operational line carries its fields, `message` naming it and `time` read from the clock;
 * an event's line carries its envelope alone. Every line is one JSON object holding each member
 * once, with the logger's numeric level in `level`.
 *
 * @param settings the clock, and the stream lines are written to.
 */
export const createEventLog = ({
  clock,
  logStream,
}: EventLogSettings): EventLog => {
  const sink = createSink(logStream);
  const logger = pino(
    { base: null, timestamp: false },
    {
      write: (line: string): void => {
        sink.write(line);
      },
    },
  );
  const writeLine = (
    level: LoggerLevel,
    line: Readonly<Record<string, unknown>>,
  ): void => {
    try {
      logger[level](line);
    } catch {
      sink.fail();
    }
  };
  const operationalLine =
    (level: LoggerLevel) =>
    (message: string, fields: LineFields = {}): void => {
      writeLine(level, {
        ...Object.fromEntries(
          Object.entries(fields).filter(([member]) => !LOG_MEMBERS.has(member)),
        ),
        message,
        time: eventInstant(clock.now()),
      });
    };
  return {
    close: () => {
      sink.close();
    },
    error: operationalLine('error'),
    info: operationalLine('info'),
    isWritable: () => sink.isWritable(),
    warning: operationalLine('warn'),
    writeEvent: ({
      data,
      dataschema,
      id,
      severity,
      source,
      specversion,
      time,
      type,
    }) => {
      writeLine(LEVELS[severity], {
        data,
        ...(dataschema === undefined ? {} : { dataschema }),
        id,
        severity,
        source,
        specversion,
        time,
        type,
      });
    },
  };
};
