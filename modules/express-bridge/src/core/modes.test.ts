import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
  type BridgeEventData,
  createEventLog,
  type EventLog,
} from './events.js';
import { createModeMachine, type ModeMachine } from './modes.js';

type ModeChange = BridgeEventData['revocationChannel.modeChange'];

const GRACE_MS = 60_000;

const recordingEvents = (): EventLog & { changes: ModeChange[] } => {
  const changes: ModeChange[] = [];

  return {
    changes,
    emit: (name, data) => {
      if (name === 'revocationChannel.modeChange') {
        changes.push(data as ModeChange);
      }
    },
  };
};

const machineAt = () => {
  const clock = { reading: 0 };
  const events = recordingEvents();
  const machine = createModeMachine({
    events,
    graceMs: GRACE_MS,
    monotonicClock: { now: () => clock.reading },
  });

  return {
    advanceTo: (ms: number) => {
      clock.reading = ms;
    },
    events,
    machine,
  };
};

/**
 * A mode machine logging through the event log over a host logger that throws on every call while
 * `logging.throws` holds; `logging.calls` counts every call, thrown or not.
 */
const machineLoggingThrough = (): {
  advanceTo: (ms: number) => void;
  logging: { calls: number; throws: boolean };
  machine: ModeMachine;
} => {
  const clock = { reading: 0 };
  const logging = { calls: 0, throws: false };
  const log = (): void => {
    logging.calls += 1;
    if (logging.throws) {
      throw new Error('a defect in the host logger');
    }
  };
  const machine = createModeMachine({
    events: createEventLog({
      logger: { error: log, info: log, warn: log },
      source: 'https://search.example.org/usher-bridge',
      wallClock: { now: () => 0 },
    }),
    graceMs: GRACE_MS,
    monotonicClock: { now: () => clock.reading },
  });

  return {
    advanceTo: (ms: number) => {
      clock.reading = ms;
    },
    logging,
    machine,
  };
};

suite('createModeMachine', () => {
  suite('leaving cold', () => {
    test('stays cold after a check until an anonymous payload is accepted, then turns normal', () => {
      const { events, machine } = machineAt();

      const atStart = machine.mode();
      machine.confirmCheck(0);
      const afterCheck = machine.mode();
      machine.anonymousAccepted();

      assert.deepEqual(
        [atStart, afterCheck, machine.mode()],
        ['cold', 'cold', 'normal'],
      );
      assert.deepEqual(events.changes, [
        {
          fromMode: 'cold',
          reason: 'anonymousPayloadAccepted',
          toMode: 'normal',
        },
      ]);
    });

    test('names the check as the reason when the anonymous payload arrived first', () => {
      const { events, machine } = machineAt();

      machine.anonymousAccepted();
      const beforeCheck = machine.mode();
      machine.confirmCheck(0);

      assert.equal(beforeCheck, 'cold');
      assert.deepEqual(events.changes, [
        { fromMode: 'cold', reason: 'checkConfirmed', toMode: 'normal' },
      ]);
    });

    test('logs a probable key mismatch once while cold, however often the self-test fails', () => {
      const { events, machine } = machineAt();

      machine.confirmCheck(0);
      machine.probableKeyMismatch();
      machine.probableKeyMismatch();

      assert.equal(machine.mode(), 'cold');
      assert.deepEqual(events.changes, [
        { fromMode: 'cold', reason: 'probableKeyMismatch', toMode: 'cold' },
      ]);
    });

    test('logs a probable audience mismatch once while cold, however often the anonymous token is refused for its audience', () => {
      const { events, machine } = machineAt();

      machine.probableAudienceMismatch();
      machine.confirmCheck(0);
      machine.probableAudienceMismatch();
      machine.probableAudienceMismatch();

      assert.equal(machine.mode(), 'cold');
      assert.deepEqual(events.changes, [
        {
          fromMode: 'cold',
          reason: 'probableAudienceMismatch',
          toMode: 'cold',
        },
      ]);
    });

    test('logs a probable audience mismatch even after a probable key mismatch, each once', () => {
      const { events, machine } = machineAt();

      machine.probableKeyMismatch();
      machine.probableAudienceMismatch();
      machine.probableKeyMismatch();
      machine.probableAudienceMismatch();

      assert.deepEqual(
        events.changes.map(({ reason }) => reason),
        ['probableKeyMismatch', 'probableAudienceMismatch'],
      );
    });

    test('logs no probable audience mismatch once the bridge has left cold', () => {
      const { events, machine } = machineAt();
      machine.confirmCheck(0);
      machine.anonymousAccepted();

      machine.probableAudienceMismatch();

      assert.equal(machine.mode(), 'normal');
      assert.deepEqual(
        events.changes.map(({ reason }) => reason),
        ['anonymousPayloadAccepted'],
      );
    });
  });

  suite('the grace period', () => {
    test('stays normal at exactly the grace period after the check, and turns uncertain 1 ms later', () => {
      const { advanceTo, events, machine } = machineAt();
      machine.confirmCheck(0);
      machine.anonymousAccepted();

      advanceTo(GRACE_MS);
      const atGrace = machine.mode();
      advanceTo(GRACE_MS + 1);

      assert.equal(atGrace, 'normal');
      assert.equal(machine.mode(), 'uncertain');
      assert.deepEqual(events.changes.at(-1), {
        fromMode: 'normal',
        reason: 'gracePeriodLapsed',
        toMode: 'uncertain',
      });
    });

    test('times the grace period from the latest check, never moving it back for an earlier one', () => {
      const { advanceTo, machine } = machineAt();
      machine.confirmCheck(0);
      machine.anonymousAccepted();
      machine.confirmCheck(59_000);
      machine.confirmCheck(10_000);

      advanceTo(119_000);
      const atLatestGrace = machine.mode();
      advanceTo(119_001);

      assert.equal(atLatestGrace, 'normal');
      assert.equal(machine.mode(), 'uncertain');
    });

    test('logs a lapse on its own timer when no request reads the mode, under mock timers', (context) => {
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const { advanceTo, events, machine } = machineAt();
      machine.confirmCheck(0);
      machine.anonymousAccepted();

      advanceTo(GRACE_MS);
      context.mock.timers.tick(GRACE_MS);
      const beforeLapse = events.changes.length;
      advanceTo(GRACE_MS + 1);
      context.mock.timers.tick(1);

      assert.equal(beforeLapse, 1);
      assert.deepEqual(events.changes.at(-1), {
        fromMode: 'normal',
        reason: 'gracePeriodLapsed',
        toMode: 'uncertain',
      });
    });

    test('throws nothing from its timer when the logger throws as the lapse is logged, and reads uncertain afterwards without logging the lapse again', (context) => {
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const { advanceTo, logging, machine } = machineLoggingThrough();
      machine.confirmCheck(0);
      machine.anonymousAccepted();
      logging.throws = true;

      advanceTo(GRACE_MS + 1);
      assert.doesNotThrow(() => context.mock.timers.tick(GRACE_MS + 1));
      const callsAfterLapse = logging.calls;
      const mode = machine.mode();

      assert.equal(callsAfterLapse, 2);
      assert.equal(mode, 'uncertain');
      assert.equal(logging.calls, callsAfterLapse);
    });

    test('re-arms its timer at each check, so a renewed grace period logs no early lapse', (context) => {
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const { advanceTo, events, machine } = machineAt();
      machine.confirmCheck(0);
      machine.anonymousAccepted();
      advanceTo(59_000);
      context.mock.timers.tick(59_000);
      machine.confirmCheck(59_000);

      advanceTo(GRACE_MS + 1);
      context.mock.timers.tick(2_001);
      const afterFirstGrace = events.changes.length;
      advanceTo(119_001);
      context.mock.timers.tick(59_000);

      assert.equal(afterFirstGrace, 1);
      assert.equal(events.changes.length, 2);
    });

    test('logs a change once, however often the mode is read', () => {
      const { advanceTo, events, machine } = machineAt();
      machine.confirmCheck(0);
      machine.anonymousAccepted();
      advanceTo(GRACE_MS + 1);

      machine.mode();
      machine.mode();
      machine.mode();

      assert.equal(events.changes.length, 2);
    });
  });

  suite('uncertain and its exits', () => {
    test('returns to normal when a check is confirmed again', () => {
      const { advanceTo, events, machine } = machineAt();
      machine.confirmCheck(0);
      machine.anonymousAccepted();
      advanceTo(120_000);
      machine.mode();

      machine.confirmCheck(120_000);

      assert.equal(machine.mode(), 'normal');
      assert.deepEqual(events.changes.at(-1), {
        fromMode: 'uncertain',
        reason: 'checkConfirmed',
        toMode: 'normal',
      });
    });

    test('logs both the move into uncertain and the recovery to normal, each at the severity of the mode it enters', () => {
      const clock = { reading: 0 };
      const lines: Array<{
        level: string;
        severity: unknown;
        toMode: unknown;
      }> = [];
      const at =
        (level: string) =>
        (object: object): void => {
          const { data, severity } = object as {
            data: { toMode?: unknown };
            severity: unknown;
          };
          lines.push({ level, severity, toMode: data.toMode });
        };
      const machine = createModeMachine({
        events: createEventLog({
          logger: { error: at('error'), info: at('info'), warn: at('warn') },
          source: 'https://search.example.org/usher-bridge',
          wallClock: { now: () => 0 },
        }),
        graceMs: GRACE_MS,
        monotonicClock: { now: () => clock.reading },
      });
      machine.confirmCheck(0);
      machine.anonymousAccepted();
      clock.reading = 120_000;
      machine.mode();

      machine.confirmCheck(120_000);
      machine.stop();

      assert.deepEqual(lines.slice(-2), [
        { level: 'error', severity: 'critical', toMode: 'uncertain' },
        { level: 'info', severity: 'info', toMode: 'normal' },
      ]);
    });

    test('turns cold when a notice drops the anonymous payload while uncertain', () => {
      const { advanceTo, events, machine } = machineAt();
      machine.confirmCheck(0);
      machine.anonymousAccepted();
      advanceTo(120_000);
      machine.mode();

      machine.anonymousDropped();

      assert.equal(machine.mode(), 'cold');
      assert.deepEqual(events.changes.at(-1), {
        fromMode: 'uncertain',
        reason: 'anonymousPayloadMissing',
        toMode: 'cold',
      });
    });
  });

  suite('normal without an anonymous payload', () => {
    test('stays normal within the grace period after the anonymous payload is dropped', () => {
      const { advanceTo, machine } = machineAt();
      machine.confirmCheck(0);
      machine.anonymousAccepted();

      machine.anonymousDropped();
      advanceTo(30_000);

      assert.equal(machine.mode(), 'normal');
    });

    test('turns cold, not uncertain, when the grace period passes with no anonymous payload held', () => {
      const { advanceTo, events, machine } = machineAt();
      machine.confirmCheck(0);
      machine.anonymousAccepted();
      machine.anonymousDropped();

      advanceTo(GRACE_MS + 1);

      assert.equal(machine.mode(), 'cold');
      assert.deepEqual(events.changes.at(-1), {
        fromMode: 'normal',
        reason: 'anonymousPayloadMissing',
        toMode: 'cold',
      });
    });

    test('serves again once a check follows the refetch after that cold spell', () => {
      const { advanceTo, machine } = machineAt();
      machine.confirmCheck(0);
      machine.anonymousAccepted();
      machine.anonymousDropped();
      advanceTo(GRACE_MS + 1);
      machine.mode();

      machine.anonymousAccepted();
      const refetchedOnly = machine.mode();
      machine.confirmCheck(GRACE_MS + 1);

      assert.equal(refetchedOnly, 'uncertain');
      assert.equal(machine.mode(), 'normal');
    });
  });

  test('cancels its timer when stopped, so nothing is logged afterward', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const { advanceTo, events, machine } = machineAt();
    machine.confirmCheck(0);
    machine.anonymousAccepted();

    machine.stop();
    advanceTo(GRACE_MS + 1);
    context.mock.timers.tick(GRACE_MS + 1);

    assert.equal(events.changes.length, 1);
  });
});
