import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suite, test, type TestContext } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import {
  type BridgeLogger,
  createChannelFailureTally,
  createEventLog,
  createOverloadTally,
  EVENT_CATALOGUE,
  type EventDefinition,
  type Severity,
  type SeverityByField,
  type SeverityByValue,
} from './events.js';

interface LoggedLine {
  level: 'error' | 'info' | 'warn';
  message: string;
  object: Record<string, unknown>;
}

const recordingLogger = (): BridgeLogger & { lines: LoggedLine[] } => {
  const lines: LoggedLine[] = [];
  const at =
    (level: LoggedLine['level']) =>
    (object: object, message: string): void => {
      lines.push({ level, message, object: object as Record<string, unknown> });
    };

  return { error: at('error'), info: at('info'), lines, warn: at('warn') };
};

/**
 * A logger that throws on every call while `failing.throws` holds, and otherwise records as
 * `recordingLogger` does; `failing.calls` counts every call, thrown or recorded.
 */
const failingLogger = (): BridgeLogger & {
  failing: { calls: number; throws: boolean };
  lines: LoggedLine[];
} => {
  const recording = recordingLogger();
  const failing = { calls: 0, throws: true };
  const at =
    (level: LoggedLine['level']) =>
    (object: object, message: string): void => {
      failing.calls += 1;
      if (failing.throws) {
        throw new Error('a defect in the host logger');
      }
      recording[level](object, message);
    };

  return {
    error: at('error'),
    failing,
    info: at('info'),
    lines: recording.lines,
    warn: at('warn'),
  };
};

const SOURCE = 'https://search.example.org/usher-bridge';

const wallAt = (ms: number) => ({ now: () => ms });

/** Passes a value the types rule out, as a cast at a call site could. */
const smuggled = <Target>(value: unknown): Target => value as Target;

/**
 * Counts the timers set through the global `setTimeout` from now on that have neither been cleared
 * nor fired, calling through to the real timers.
 */
const liveTimers = (context: TestContext): (() => number) => {
  const live = new Set<unknown>();
  const { clearTimeout: clear, setTimeout: set } = globalThis;
  context.mock.method(
    globalThis,
    'setTimeout',
    (callback: () => void, delayMs?: number) => {
      const timer = set(() => {
        live.delete(timer);
        callback();
      }, delayMs);
      live.add(timer);
      return timer;
    },
  );
  context.mock.method(
    globalThis,
    'clearTimeout',
    (timer: Parameters<typeof clearTimeout>[0]) => {
      live.delete(timer);
      clear(timer);
    },
  );
  return () => live.size;
};

suite('createEventLog', () => {
  test('wraps an event in the CloudEvents envelope, with its time read from the wall clock in UTC', () => {
    const logger = recordingLogger();
    const events = createEventLog({
      logger,
      source: SOURCE,
      wallClock: wallAt(Date.UTC(2026, 9, 5, 19, 23, 0)),
    });

    events.emit('token.rejection', { reason: 'decryptionFailed' });

    const [line] = logger.lines;
    assert.deepEqual(
      { ...line?.object, id: typeof line?.object['id'] },
      {
        data: {
          actorId: null,
          actorType: 'system',
          reason: 'decryptionFailed',
        },
        id: 'string',
        severity: 'warning',
        source: SOURCE,
        specversion: '1.0',
        time: '2026-10-05T19:23:00.000Z',
        type: 'bio.overture.token.rejection',
      },
    );
    assert.equal(line?.message, 'bio.overture.token.rejection');
  });

  test('gives every event its own id', () => {
    const logger = recordingLogger();
    const events = createEventLog({
      logger,
      source: SOURCE,
      wallClock: wallAt(0),
    });

    events.emit('credential.refusal', { origin: 'controller' });
    events.emit('credential.refusal', { origin: 'controller' });

    const [first, second] = logger.lines.map(({ object }) => object['id']);
    assert.notEqual(first, second);
  });

  test('keeps seconds and the Z designator in the time at the epoch itself', () => {
    const logger = recordingLogger();
    const events = createEventLog({
      logger,
      source: SOURCE,
      wallClock: wallAt(0),
    });

    events.emit('revocationChannel.modeChange', {
      fromMode: 'cold',
      reason: 'checkConfirmed',
      toMode: 'normal',
    });

    assert.equal(logger.lines[0]?.object['time'], '1970-01-01T00:00:00.000Z');
  });

  for (const [name, data, level] of [
    ['notice.applied', { entriesDropped: 2, kind: 'principal' }, 'info'],
    ['token.overtaken', { outcome: 'exchangedAgain' }, 'info'],
    ['token.exchangeFailure', { cause: 'timeout' }, 'warn'],
    [
      'category.unmapped',
      {
        catalogue: 'files',
        category: 'resource.pilot',
        resourceId: 'HEART_STUDY',
      },
      'error',
    ],
    [
      'category.unmapped',
      { catalogue: 'files', category: 'global.controlled' },
      'error',
    ],
    [
      'category.unknown',
      { catalogue: 'files', category: 'global.embargoed' },
      'warn',
    ],
    ['bridge.internalError', { stage: 'resolve' }, 'error'],
    [
      'revocationChannel.modeChange',
      { fromMode: 'uncertain', reason: 'checkConfirmed', toMode: 'normal' },
      'info',
    ],
    [
      'revocationChannel.modeChange',
      { fromMode: 'normal', reason: 'gracePeriodLapsed', toMode: 'uncertain' },
      'error',
    ],
    [
      'revocationChannel.modeChange',
      { fromMode: 'normal', reason: 'anonymousPayloadMissing', toMode: 'cold' },
      'error',
    ],
    ['catalogue.renderingMismatch', { catalogue: 'files' }, 'error'],
    [
      'catalogue.filterLimit',
      { catalogue: 'files', filterClauseLimit: 1_024 },
      'error',
    ],
  ] as const) {
    test(`logs ${name} at ${level}, the level its severity maps to`, () => {
      const logger = recordingLogger();
      const events = createEventLog({
        logger,
        source: SOURCE,
        wallClock: wallAt(0),
      });

      events.emit(name, data);

      assert.equal(logger.lines[0]?.level, level);
    });
  }

  test('gives revocationChannel.modeChange the severity of the mode it enters: critical into cold or uncertain, info into normal', () => {
    const logger = recordingLogger();
    const events = createEventLog({
      logger,
      source: SOURCE,
      wallClock: wallAt(0),
    });

    events.emit('revocationChannel.modeChange', {
      fromMode: 'normal',
      reason: 'gracePeriodLapsed',
      toMode: 'uncertain',
    });
    events.emit('revocationChannel.modeChange', {
      fromMode: 'uncertain',
      reason: 'anonymousPayloadMissing',
      toMode: 'cold',
    });
    events.emit('revocationChannel.modeChange', {
      fromMode: 'cold',
      reason: 'checkConfirmed',
      toMode: 'normal',
    });

    assert.deepEqual(
      logger.lines.map(({ object }) => object['severity']),
      ['critical', 'critical', 'info'],
    );
  });

  test('gives revocationChannel.modeChange critical severity when the mode it enters is not one of the three, so a malformed emission is never quieter than an outage', () => {
    const logger = recordingLogger();
    const events = createEventLog({
      logger,
      source: SOURCE,
      wallClock: wallAt(0),
    });

    events.emit('revocationChannel.modeChange', {
      fromMode: 'uncertain',
      reason: 'checkConfirmed',
      toMode: 'recovered',
    } as unknown as {
      fromMode: 'uncertain';
      reason: 'checkConfirmed';
      toMode: 'normal';
    });

    assert.deepEqual(
      logger.lines.map(({ level, object }) => [level, object['severity']]),
      [['error', 'critical']],
    );
  });

  test('gives category.unmapped critical severity for a global category, which names no resource, and error severity for a resource category', () => {
    const logger = recordingLogger();
    const events = createEventLog({
      logger,
      source: SOURCE,
      wallClock: wallAt(0),
    });

    events.emit('category.unmapped', {
      catalogue: 'files',
      category: 'global.controlled',
    });
    events.emit('category.unmapped', {
      catalogue: 'files',
      category: 'resource.pilot',
      resourceId: 'HEART_STUDY',
    });

    assert.deepEqual(
      logger.lines.map(({ object }) => [object['severity'], object['data']]),
      [
        [
          'critical',
          {
            actorId: null,
            actorType: 'system',
            catalogue: 'files',
            category: 'global.controlled',
          },
        ],
        [
          'error',
          {
            actorId: null,
            actorType: 'system',
            catalogue: 'files',
            category: 'resource.pilot',
            resourceId: 'HEART_STUDY',
          },
        ],
      ],
    );
  });

  test('chooses the severity from the fields it logs, so a resource that is not a string reads as no resource', () => {
    const logger = recordingLogger();
    const events = createEventLog({
      logger,
      source: SOURCE,
      wallClock: wallAt(0),
    });

    events.emit(
      'category.unmapped',
      smuggled({
        catalogue: 'files',
        category: 'resource.pilot',
        resourceId: { toString: () => 'HEART_STUDY' },
      }),
    );

    assert.deepEqual(
      [logger.lines[0]?.object['severity'], logger.lines[0]?.object['data']],
      [
        'critical',
        {
          actorId: null,
          actorType: 'system',
          catalogue: 'files',
          category: 'resource.pilot',
        },
      ],
    );
  });

  test('marks a refused credential anonymous, since its holder was never identified', () => {
    const logger = recordingLogger();
    const events = createEventLog({
      logger,
      source: SOURCE,
      wallClock: wallAt(0),
    });

    events.emit('credential.refusal', { origin: 'localExpiry' });
    events.emit('credential.malformed', { reason: 'multiple' });

    assert.deepEqual(
      logger.lines.map(({ object }) => object['data']),
      [
        { actorId: null, actorType: 'anonymous', origin: 'localExpiry' },
        { actorId: null, actorType: 'anonymous', reason: 'multiple' },
      ],
    );
  });

  test('copies only the fields the catalogue gives an event, so a field smuggled in by a cast never reaches the log', () => {
    const logger = recordingLogger();
    const events = createEventLog({
      logger,
      source: SOURCE,
      wallClock: wallAt(0),
    });

    events.emit(
      'token.rejection',
      smuggled({
        actorId: 'subject-of-someone',
        permissions: { HEART_STUDY: {} },
        reason: 'payloadMalformed',
        token: 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0',
      }),
    );

    assert.deepEqual(logger.lines[0]?.object['data'], {
      actorId: null,
      actorType: 'system',
      reason: 'payloadMalformed',
    });
  });

  test('drops an enumerated field holding a value outside its set, such as an error message', () => {
    const logger = recordingLogger();
    const events = createEventLog({
      logger,
      source: SOURCE,
      wallClock: wallAt(0),
    });

    events.emit(
      'token.rejection',
      smuggled({
        reason: 'Unexpected token s, "subject-123" is not valid JSON',
      }),
    );
    events.emit(
      'bridge.internalError',
      smuggled({ stage: { toString: () => 'resolve' } }),
    );

    assert.deepEqual(
      logger.lines.map(({ object }) => object['data']),
      [
        { actorId: null, actorType: 'system' },
        { actorId: null, actorType: 'system' },
      ],
    );
  });

  test('never runs an accessor on the data it is handed, so a getter cannot pass a value to the log', () => {
    const logger = recordingLogger();
    const events = createEventLog({
      logger,
      source: SOURCE,
      wallClock: wallAt(0),
    });
    const reads = { count: 0 };
    const data = Object.defineProperty({}, 'reason', {
      enumerable: true,
      get: () => {
        reads.count += 1;
        return 'decryptionFailed';
      },
    });

    events.emit('token.rejection', smuggled(data));

    assert.equal(reads.count, 0);
    assert.deepEqual(logger.lines[0]?.object['data'], {
      actorId: null,
      actorType: 'system',
    });
  });

  test('drops a count that is not a whole number of at least zero, and a text field that is not a string', () => {
    const logger = recordingLogger();
    const events = createEventLog({
      logger,
      source: SOURCE,
      wallClock: wallAt(0),
    });

    events.emit(
      'notice.applied',
      smuggled({ entriesDropped: -1, kind: 'global' }),
    );
    events.emit(
      'notice.applied',
      smuggled({ entriesDropped: 1.5, kind: 'global' }),
    );
    events.emit(
      'catalogue.resourceListMissing',
      smuggled({ catalogue: { secret: 'eyJ' } }),
    );

    assert.deepEqual(
      logger.lines.map(({ object }) => object['data']),
      [
        { actorId: null, actorType: 'system', kind: 'global' },
        { actorId: null, actorType: 'system', kind: 'global' },
        { actorId: null, actorType: 'system' },
      ],
    );
  });

  test('carries the principal of an unenforced grant as userId, a null subject included', () => {
    const logger = recordingLogger();
    const events = createEventLog({
      logger,
      source: SOURCE,
      wallClock: wallAt(0),
    });

    events.emit('category.unenforced', {
      category: 'resource.pilot',
      entry: 'fieldPartition',
      payloadVersion: 1,
      reason: 'notImplemented',
      resourceId: 'HEART_STUDY',
      userId: null,
    });

    assert.deepEqual(logger.lines[0]?.object['data'], {
      actorId: null,
      actorType: 'system',
      category: 'resource.pilot',
      entry: 'fieldPartition',
      payloadVersion: 1,
      reason: 'notImplemented',
      resourceId: 'HEART_STUDY',
      userId: null,
    });
  });

  test('logs a token refused for its audience, and the probable audience mismatch it shows, by their reasons', () => {
    const logger = recordingLogger();
    const events = createEventLog({
      logger,
      source: SOURCE,
      wallClock: wallAt(0),
    });

    events.emit('token.rejection', { reason: 'audienceRejected' });
    events.emit('revocationChannel.modeChange', {
      fromMode: 'cold',
      reason: 'probableAudienceMismatch',
      toMode: 'cold',
    });

    assert.deepEqual(
      logger.lines.map(({ object }) => object['data']),
      [
        { actorId: null, actorType: 'system', reason: 'audienceRejected' },
        {
          actorId: null,
          actorType: 'system',
          fromMode: 'cold',
          reason: 'probableAudienceMismatch',
          toMode: 'cold',
        },
      ],
    );
  });

  test('drops an event when the logger throws, returning normally, and logs the next once the logger no longer throws', () => {
    const logger = failingLogger();
    const events = createEventLog({
      logger,
      source: SOURCE,
      wallClock: wallAt(0),
    });

    assert.doesNotThrow(() =>
      events.emit('token.rejection', { reason: 'decryptionFailed' }),
    );
    logger.failing.throws = false;
    events.emit('token.rejection', { reason: 'expired' });

    assert.deepEqual(
      logger.lines.map(({ object }) => object['data']),
      [{ actorId: null, actorType: 'system', reason: 'expired' }],
    );
  });

  test('reports a dropped event nowhere else: no second call to the logger, and nothing on the console or stderr', (context) => {
    const logger = failingLogger();
    const events = createEventLog({
      logger,
      source: SOURCE,
      wallClock: wallAt(0),
    });
    const elsewhere = [
      ...(['debug', 'error', 'info', 'log', 'warn'] as const).map((method) =>
        context.mock.method(console, method),
      ),
      context.mock.method(process.stderr, 'write'),
    ];

    events.emit('bridge.internalError', { stage: 'resolve' });

    assert.equal(logger.failing.calls, 1);
    assert.deepEqual(
      elsewhere.map((method) => method.mock.callCount()),
      [0, 0, 0, 0, 0, 0],
    );
  });
});

const AUDIT_EVENTS = readFileSync(
  new URL('../../../../.dev/design/audit-events.md', import.meta.url),
  'utf8',
);

/** One row of the events table in audit-events.md, holding the cells compared against the catalogue. */
interface EventRow {
  actor: string;
  description: string;
  event: string;
  fields: string;
  severity: string;
}

/** What one side, the table or the catalogue, registers for an event. */
interface Registration {
  actor: string;
  fieldNames: readonly string[];
  severity: Severity | SeverityByField | SeverityByValue;
}

const ASPECTS = ['actor', 'fieldNames', 'severity'] as const;

const SEVERITIES: readonly Severity[] = [
  'critical',
  'error',
  'info',
  'warning',
];

/**
 * The severity cells naming a severity per case. category.unmapped's cases are told apart by whether
 * the event carries the resource, which only a resource category's does; revocationChannel.modeChange's
 * by the mode it enters.
 */
const PER_CASE_SEVERITIES: readonly {
  cell: string;
  severity: SeverityByField | SeverityByValue;
}[] = [
  {
    cell: '`critical` for a global category, `error` for a resource category',
    severity: {
      field: 'resourceId',
      withField: 'error',
      withoutField: 'critical',
    },
  },
  {
    cell: '`critical` into cold or uncertain, `info` into normal',
    severity: {
      byValue: { cold: 'critical', normal: 'info', uncertain: 'critical' },
      field: 'toMode',
      otherwise: 'critical',
    },
  },
];

const unreadable = (what: string, cell: string): never => {
  throw new Error(`no ${what} can be read from "${cell}"`);
};

/**
 * The rows of the table under the `## Events` heading of a markdown document, each cell found by its
 * column's header, and each event type without its backticks.
 */
const eventRows = (markdown: string): readonly EventRow[] => {
  const lines = markdown.split('\n');
  const section = lines.slice(lines.indexOf('## Events') + 1);
  const end = section.findIndex((line) => line.startsWith('## '));
  const table = section
    .slice(0, end === -1 ? section.length : end)
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  const header = table[0] ?? [];
  const cellOf = (cells: readonly string[], column: string): string =>
    cells[header.indexOf(column)] ??
    unreadable(`${column} cell`, cells.join(' | '));

  return table.slice(2).map((cells) => ({
    actor: cellOf(cells, 'Actor'),
    description: cellOf(cells, 'Description'),
    event: cellOf(cells, 'Event type').replaceAll('`', ''),
    fields: cellOf(cells, 'Additional required fields'),
    severity: cellOf(cells, 'Severity'),
  }));
};

/**
 * The field names registered in a fields cell: every backticked name outside parentheses, since one
 * inside them is a value its field may hold. A cell reading `none` registers no field.
 */
const fieldNamesIn = (cell: string): readonly string[] => {
  const fieldNames = Array.from(
    cell.replaceAll(/\([^)]*\)/gu, '').matchAll(/`(\w+)`/gu),
    ([, fieldName]) => fieldName ?? '',
  );
  return fieldNames.length > 0 || cell === 'none'
    ? fieldNames
    : unreadable('field name', cell);
};

/** The severity registered in a severity cell: one backticked severity, or one per case. */
const severityIn = (
  cell: string,
): Severity | SeverityByField | SeverityByValue =>
  SEVERITIES.find((severity) => cell === `\`${severity}\``) ??
  PER_CASE_SEVERITIES.find((perCase) => perCase.cell === cell)?.severity ??
  unreadable('severity', cell);

const tableRegistration = (row: EventRow): Registration => ({
  actor: row.actor.toLowerCase(),
  fieldNames: fieldNamesIn(row.fields).toSorted(),
  severity: severityIn(row.severity),
});

const codeRegistration = (definition: EventDefinition): Registration => ({
  actor: definition.actorType,
  fieldNames: Object.keys(definition.fields).toSorted(),
  severity: definition.severity,
});

suite('reading the events table of audit-events.md', () => {
  test('reads the actor, field names and severity of each row under the Events heading alone, leaving out the values in parentheses', () => {
    const markdown = [
      '## Events and the permissions that produce them',
      '',
      '| Event type | Actor |',
      '| --- | --- |',
      '| `grant.creation` | Custodian |',
      '',
      '## Events',
      '',
      '| Event type | Description | Actor | Affected entity | Additional required fields | Severity |',
      '| --- | --- | --- | --- | --- | --- |',
      '| `credential.malformed` | Bridge answered `400` | Anonymous | Request | `reason` (`multiple`, `scheme` or `query`) | `info` |',
      '| `revocationChannel.reset` | Bridge dropped every entry | System | All active sessions | none | `warning` |',
      '| `category.unknown` | Bridge found a category | System | Catalogue + category | `catalogue`, `category`; `resourceId` for a resource category | `warning` |',
      '| `category.unmapped` | Bridge denied a result | System | Catalogue + category + resource | `catalogue`, `category`, `resourceId` | `critical` for a global category, `error` for a resource category |',
      '',
      '## Open items',
      '',
      '| Event type | Actor |',
      '| --- | --- |',
      '| `grant.rateExceeded` | System |',
    ].join('\n');

    assert.deepEqual(
      eventRows(markdown).map((row) => [row.event, tableRegistration(row)]),
      [
        [
          'credential.malformed',
          { actor: 'anonymous', fieldNames: ['reason'], severity: 'info' },
        ],
        [
          'revocationChannel.reset',
          { actor: 'system', fieldNames: [], severity: 'warning' },
        ],
        [
          'category.unknown',
          {
            actor: 'system',
            fieldNames: ['catalogue', 'category', 'resourceId'],
            severity: 'warning',
          },
        ],
        [
          'category.unmapped',
          {
            actor: 'system',
            fieldNames: ['catalogue', 'category', 'resourceId'],
            severity: {
              field: 'resourceId',
              withField: 'error',
              withoutField: 'critical',
            },
          },
        ],
      ],
    );
  });

  test("throws on a fields cell naming no field, and on a severity cell holding anything but one severity or category.unmapped's two", () => {
    assert.throws(() => fieldNamesIn(''), /no field name/u);
    assert.throws(() => severityIn('follows `result`'), /no severity/u);
    assert.throws(
      () =>
        severityIn(
          '`error` for a global category, `critical` for a resource category',
        ),
      /no severity/u,
    );
  });
});

suite('EVENT_CATALOGUE', () => {
  const rows = eventRows(AUDIT_EVENTS);

  test("has exactly one row in the events table of audit-events.md for each of the bridge's events", () => {
    const eventsWithoutOneRow = Object.keys(EVENT_CATALOGUE)
      .map((event) => ({
        event,
        rowCount: rows.filter((row) => row.event === event).length,
      }))
      .filter(({ rowCount }) => rowCount !== 1);

    assert.deepEqual(eventsWithoutOneRow, []);
  });

  test("names one of the bridge's events in every row of the events table whose description begins with Bridge, one row for each event", () => {
    const bridgeRows = rows.filter(({ description }) =>
      description.startsWith('Bridge'),
    );

    const eventsOutsideTheCatalogue = bridgeRows
      .map(({ event }) => event)
      .filter((event) => !Object.hasOwn(EVENT_CATALOGUE, event));

    assert.deepEqual(eventsOutsideTheCatalogue, []);
    assert.equal(bridgeRows.length, Object.keys(EVENT_CATALOGUE).length);
  });

  test("defines each of the bridge's events with the actor, field names and severity registered in its row", () => {
    const disagreements = Object.entries(EVENT_CATALOGUE).flatMap(
      ([event, definition]) =>
        rows
          .filter((row) => row.event === event)
          .flatMap((row) => {
            const code = codeRegistration(definition);
            const table = tableRegistration(row);
            return ASPECTS.filter(
              (aspect) => !isDeepStrictEqual(code[aspect], table[aspect]),
            ).map((aspect) => ({
              aspect,
              code: code[aspect],
              event,
              table: table[aspect],
            }));
          }),
    );

    assert.deepEqual(disagreements, []);
  });

  test('chooses a severity by value only among values the field accepts, so every case the table names can be logged', () => {
    const unacceptedValues = Object.entries(EVENT_CATALOGUE).flatMap(
      ([event, { fields, severity }]) => {
        if (typeof severity === 'string' || !('byValue' in severity)) {
          return [];
        }
        const field = fields[severity.field];
        return Object.keys(severity.byValue)
          .filter(
            (value) => field?.kind !== 'oneOf' || !field.values.includes(value),
          )
          .map((value) => ({ event, field: severity.field, value }));
      },
    );

    assert.deepEqual(unacceptedValues, []);
  });
});

suite('createOverloadTally', () => {
  test('logs nothing until its interval ends, then one token.exchangeFailure counting every overloaded request', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const logger = recordingLogger();
    const events = createEventLog({
      logger,
      source: SOURCE,
      wallClock: wallAt(0),
    });
    const tally = createOverloadTally(events);

    tally.record();
    tally.record();
    tally.record();
    context.mock.timers.tick(59_999);
    const beforeTheInterval = logger.lines.length;
    context.mock.timers.tick(1);

    assert.equal(beforeTheInterval, 0);
    assert.deepEqual(
      logger.lines.map(({ object }) => object['data']),
      [{ actorId: null, actorType: 'system', cause: 'overloaded', count: 3 }],
    );
  });

  test('starts a fresh count after logging, and logs nothing for an interval with no overload', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const logger = recordingLogger();
    const events = createEventLog({
      logger,
      source: SOURCE,
      wallClock: wallAt(0),
    });
    const tally = createOverloadTally(events);

    tally.record();
    context.mock.timers.tick(60_000);
    context.mock.timers.tick(120_000);
    tally.record();
    context.mock.timers.tick(60_000);

    assert.deepEqual(
      logger.lines.map(
        ({ object }) => (object['data'] as { count: number }).count,
      ),
      [1, 1],
    );
  });

  test('logs the count held when it stops, so no overloaded request goes unrecorded', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const logger = recordingLogger();
    const events = createEventLog({
      logger,
      source: SOURCE,
      wallClock: wallAt(0),
    });
    const tally = createOverloadTally(events);

    tally.record();
    tally.record();
    tally.stop();
    context.mock.timers.tick(60_000);

    assert.deepEqual(
      logger.lines.map(
        ({ object }) => (object['data'] as { count: number }).count,
      ),
      [2],
    );
  });

  test('ignores a request shed once it has stopped, arming no timer and logging nothing for it', (context) => {
    const timersLeft = liveTimers(context);
    const logger = recordingLogger();
    const events = createEventLog({
      logger,
      source: SOURCE,
      wallClock: wallAt(0),
    });
    const tally = createOverloadTally(events);

    tally.stop();
    tally.record();
    tally.record();
    const timersAfterRecording = timersLeft();
    tally.stop();

    assert.equal(timersAfterRecording, 0);
    assert.deepEqual(logger.lines, []);
  });
});

suite('createChannelFailureTally', () => {
  /** Each logged failure as its cause and count, in the order of its cause's name. */
  const failuresLogged = (lines: readonly LoggedLine[]) =>
    lines
      .map(({ object }) => object['data'] as { cause: string; count: number })
      .map(({ cause, count }) => ({ cause, count }))
      .toSorted((first, second) => first.cause.localeCompare(second.cause));

  test('logs nothing until its interval ends, then one revocationChannel.failure for each cause, carrying its count', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const logger = recordingLogger();
    const events = createEventLog({
      logger,
      source: SOURCE,
      wallClock: wallAt(0),
    });
    const tally = createChannelFailureTally(events);

    tally.record('status');
    tally.record('timeout');
    tally.record('status');
    tally.record('defect');
    tally.record('network');
    tally.record('timeout');
    tally.record('status');
    context.mock.timers.tick(59_999);
    const beforeTheInterval = logger.lines.length;
    context.mock.timers.tick(1);

    assert.equal(beforeTheInterval, 0);
    assert.deepEqual(failuresLogged(logger.lines), [
      { cause: 'defect', count: 1 },
      { cause: 'network', count: 1 },
      { cause: 'status', count: 3 },
      { cause: 'timeout', count: 2 },
    ]);
    assert.deepEqual(
      logger.lines.map(({ level, object }) => [
        level,
        object['severity'],
        object['type'],
        (object['data'] as { actorType: string }).actorType,
      ]),
      Array.from({ length: 4 }, () => [
        'warn',
        'warning',
        'bio.overture.revocationChannel.failure',
        'system',
      ]),
    );
  });

  test('starts a fresh count for each interval, and logs nothing for an interval with no failure', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const logger = recordingLogger();
    const events = createEventLog({
      logger,
      source: SOURCE,
      wallClock: wallAt(0),
    });
    const tally = createChannelFailureTally(events);

    tally.record('network');
    context.mock.timers.tick(60_000);
    context.mock.timers.tick(120_000);
    const afterQuietIntervals = logger.lines.length;
    tally.record('network');
    tally.record('network');
    context.mock.timers.tick(60_000);

    assert.equal(afterQuietIntervals, 1);
    assert.deepEqual(failuresLogged(logger.lines), [
      { cause: 'network', count: 1 },
      { cause: 'network', count: 2 },
    ]);
  });

  test('logs the counts held when it stops, and nothing once its interval would have ended', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const logger = recordingLogger();
    const events = createEventLog({
      logger,
      source: SOURCE,
      wallClock: wallAt(0),
    });
    const tally = createChannelFailureTally(events);

    tally.record('defect');
    tally.record('timeout');
    tally.record('defect');
    tally.stop();
    context.mock.timers.tick(60_000);

    assert.deepEqual(failuresLogged(logger.lines), [
      { cause: 'defect', count: 2 },
      { cause: 'timeout', count: 1 },
    ]);
  });

  test('ignores a failure recorded once it has stopped, arming no timer and logging nothing for it', (context) => {
    const timersLeft = liveTimers(context);
    const logger = recordingLogger();
    const events = createEventLog({
      logger,
      source: SOURCE,
      wallClock: wallAt(0),
    });
    const tally = createChannelFailureTally(events);

    tally.record('status');
    tally.stop();
    const loggedAtStop = failuresLogged(logger.lines);
    tally.record('status');
    tally.record('defect');
    const timersAfterRecording = timersLeft();
    tally.stop();

    assert.deepEqual(loggedAtStop, [{ cause: 'status', count: 1 }]);
    assert.equal(timersAfterRecording, 0);
    assert.deepEqual(failuresLogged(logger.lines), loggedAtStop);
  });

  test('throws nothing from its timer when the logger throws as an interval is reported, offering every count, and reports the next interval', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const logger = failingLogger();
    const events = createEventLog({
      logger,
      source: SOURCE,
      wallClock: wallAt(0),
    });
    const tally = createChannelFailureTally(events);

    tally.record('network');
    tally.record('status');
    assert.doesNotThrow(() => context.mock.timers.tick(60_000));
    const offeredWhileThrowing = logger.failing.calls;
    logger.failing.throws = false;
    tally.record('timeout');
    context.mock.timers.tick(60_000);

    assert.equal(offeredWhileThrowing, 2);
    assert.deepEqual(failuresLogged(logger.lines), [
      { cause: 'timeout', count: 1 },
    ]);
  });
});
