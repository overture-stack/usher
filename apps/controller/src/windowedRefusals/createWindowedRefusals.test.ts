import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type { Actor, AuditEvent, LineFields } from '../eventLog/index.js';
import {
  REFUSAL_WINDOW_COOLDOWN_MILLISECONDS,
  type RefusalKey,
} from '../refusalWindows/index.js';
import {
  CLOSING_UNRECORDED,
  createWindowedRefusals,
  WINDOW_CLOCK_READING_MILLISECONDS,
} from './createWindowedRefusals.js';
import type { WindowClosing, WindowedRefusals } from './types.js';

const START = 1_800_000_000_000;

const MINUTE = 60_000;

const SEARCH = '4b1f6c2e-8d3a-4e5f-9a7b-0c1d2e3f4a5b';

const OPENING_ID = '0f4c1a2b-3d5e-4f60-8a7b-9c0d1e2f3a4b';

const SYSTEM: Actor = { type: 'system' };

const OF_TOKEN: RefusalKey = {
  reason: 'expiredToken',
  route: 'management',
  tokenDigest: 'digest-1',
};

// Each route's closing event, its type naming the route, so a test sees which one closed a window.
const closingOf =
  (type: AuditEvent['type']) =>
  ({
    applicationId,
    count,
    firstSeenAt,
    lastSeenAt,
    reason,
    windowId,
  }: WindowClosing): AuditEvent => ({
    data: {
      ...(applicationId === undefined ? {} : { applicationId }),
      count,
      firstSeenAt,
      lastSeenAt,
      reason,
      ...(windowId === undefined ? {} : { windowId }),
    },
    severity: 'warning',
    type,
  });

interface Recorded {
  actor: Actor;
  event: AuditEvent;
}

interface Line {
  fields: LineFields | undefined;
  message: string;
}

interface Windowed {
  lines: Line[];
  recorded: Recorded[];
  refusals: WindowedRefusals;
  time: { now: number };
}

const windowed = ({
  recordEvent,
}: {
  recordEvent?: (
    actor: Actor,
    event: AuditEvent,
  ) => Promise<string | undefined>;
} = {}): Windowed => {
  const time = { now: START };
  const recorded: Recorded[] = [];
  const lines: Line[] = [];
  const refusals = createWindowedRefusals({
    clock: { now: () => time.now },
    closingEvents: {
      exchange: closingOf('token.exchangeRefusalTally'),
      logout: closingOf('logoutToken.refusalTally'),
      management: closingOf('managementToken.refusalTally'),
    },
    log: {
      error: (message, fields) => {
        lines.push({ fields, message });
      },
    },
    trail: {
      recordEvent: async (actor, event) => {
        recorded.push({ actor, event });
        return recordEvent === undefined
          ? `closing-${recorded.length}`
          : recordEvent(actor, event);
      },
    },
  });
  return { lines, recorded, refusals, time };
};

// The refusal's own recording, as a route makes it: the id of the event it committed.
const openedWith =
  (id: string | undefined) => (): Promise<string | undefined> =>
    Promise.resolve(id);

const sameId = (id: string | undefined): string | undefined => id;

// Lets every closing the windows began settle.
const settled = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

suite('the refusals opening and counted in windows', () => {
  test('records the refusal opening a window through the route, giving its recording back, and writes nothing for a later refusal under its key', async () => {
    const { recorded, refusals } = windowed();
    const opens: string[] = [];
    const open = (): Promise<string> => {
      opens.push('open');
      return Promise.resolve(OPENING_ID);
    };

    const first = await refusals.refuse(OF_TOKEN, open, sameId);
    const second = await refusals.refuse(OF_TOKEN, open, sameId);

    assert.deepEqual(first, { kind: 'opened', opening: OPENING_ID });
    assert.deepEqual(second, { kind: 'counted' });
    assert.deepEqual(opens, ['open']);
    assert.deepEqual(recorded, []);
  });

  test('throws again a failure its opening throws', async () => {
    const { refusals } = windowed();

    await assert.rejects(
      refusals.refuse(
        OF_TOKEN,
        () => Promise.reject(new Error('defect')),
        sameId,
      ),
      /defect/u,
    );
  });
});

suite('closing a window', () => {
  test("closes a window once its cooldown has passed, recording its route's closing event as the system, naming its opening event, its count and the instants of its first and latest refusals", async (context) => {
    context.mock.timers.enable({ apis: ['setInterval'] });
    const { recorded, refusals, time } = windowed();
    refusals.start();
    await refusals.refuse(OF_TOKEN, openedWith(OPENING_ID), sameId);
    time.now += MINUTE;
    await refusals.refuse(OF_TOKEN, openedWith('unused'), sameId);
    time.now += MINUTE;
    await refusals.refuse(OF_TOKEN, openedWith('unused'), sameId);

    time.now += REFUSAL_WINDOW_COOLDOWN_MILLISECONDS;
    context.mock.timers.tick(WINDOW_CLOCK_READING_MILLISECONDS);
    await settled();

    assert.deepEqual(recorded, [
      {
        actor: SYSTEM,
        event: closingOf('managementToken.refusalTally')({
          count: 3,
          firstSeenAt: START,
          lastSeenAt: START + 2 * MINUTE,
          reason: 'expiredToken',
          windowId: OPENING_ID,
        }),
      },
    ]);
    await refusals.stop();
  });

  test('names the application a window of credentials refused at the exchange without verifying counts for', async () => {
    const { recorded, refusals } = windowed();
    const key: RefusalKey = {
      applicationId: SEARCH,
      reason: 'invalidSignature',
      route: 'exchange',
    };
    await refusals.refuse(key, openedWith(OPENING_ID), sameId);
    await refusals.refuse(key, openedWith('unused'), sameId);

    await refusals.stop();

    assert.deepEqual(
      recorded.map(({ event }) => event),
      [
        closingOf('token.exchangeRefusalTally')({
          applicationId: SEARCH,
          count: 2,
          firstSeenAt: START,
          lastSeenAt: START,
          reason: 'invalidSignature',
          windowId: OPENING_ID,
        }),
      ],
    );
  });

  test('records a closing event for a window that saw only the refusal opening it, its count one', async () => {
    const { lines, recorded, refusals } = windowed();
    await refusals.refuse(OF_TOKEN, openedWith(OPENING_ID), sameId);

    await refusals.stop();

    assert.deepEqual(
      recorded.map(({ event }) => event),
      [
        closingOf('managementToken.refusalTally')({
          count: 1,
          firstSeenAt: START,
          lastSeenAt: START,
          reason: 'expiredToken',
          windowId: OPENING_ID,
        }),
      ],
    );
    assert.deepEqual(lines, []);
  });

  test("closes each route's windows with that route's own closing event, one after another in the order they closed", async () => {
    const { recorded, refusals } = windowed();
    const keys: readonly RefusalKey[] = [
      { reason: 'invalidSignature', route: 'logout' },
      { reason: 'otherIssuer', route: 'management' },
      { applicationId: SEARCH, reason: 'otherIssuer', route: 'exchange' },
    ];
    await keys.reduce(async (earlier, key) => {
      await earlier;
      await refusals.refuse(key, openedWith(OPENING_ID), sameId);
      await refusals.refuse(key, openedWith('unused'), sameId);
    }, Promise.resolve());

    await refusals.stop();

    assert.deepEqual(
      recorded.map(({ event }) => event.type),
      [
        'logoutToken.refusalTally',
        'managementToken.refusalTally',
        'token.exchangeRefusalTally',
      ],
    );
  });

  test('records a closing event only once the opening it names has settled', async () => {
    const { recorded, refusals } = windowed();
    const pending: { commit?: (id: string) => void } = {};
    const opening = refusals.refuse(
      OF_TOKEN,
      () =>
        new Promise<string>((resolve) => {
          pending.commit = resolve;
        }),
      sameId,
    );
    await refusals.refuse(OF_TOKEN, openedWith('unused'), sameId);

    const stopped = refusals.stop();
    await settled();
    const beforeCommit = recorded.length;
    pending.commit?.(OPENING_ID);
    await Promise.all([opening, stopped]);

    assert.equal(beforeCommit, 0);
    assert.equal(recorded[0]?.event.data['windowId'], OPENING_ID);
  });
});

suite('a store that does not take an opening or a closing event', () => {
  test('closes a window whose opening event did not commit naming no opening, its count still every refusal in it', async () => {
    const { recorded, refusals } = windowed();
    await refusals.refuse(OF_TOKEN, openedWith(undefined), sameId);

    await refusals.stop();

    assert.deepEqual(
      recorded.map(({ event }) => event),
      [
        closingOf('managementToken.refusalTally')({
          count: 1,
          firstSeenAt: START,
          lastSeenAt: START,
          reason: 'expiredToken',
        }),
      ],
    );
  });

  test('closes a window whose opening threw as one whose opening did not commit', async () => {
    const { recorded, refusals } = windowed();
    await refusals
      .refuse(OF_TOKEN, () => Promise.reject(new Error('defect')), sameId)
      .catch(() => undefined);
    await refusals.refuse(OF_TOKEN, openedWith('unused'), sameId);

    await refusals.stop();

    assert.deepEqual(
      recorded.map(({ event }) => event.data),
      [
        {
          count: 2,
          firstSeenAt: START,
          lastSeenAt: START,
          reason: 'expiredToken',
        },
      ],
    );
  });

  test('writes a closing event the store did not take to the log at error, as its type and every member it carries', async () => {
    const { lines, refusals } = windowed({
      recordEvent: () => Promise.resolve(undefined),
    });
    await refusals.refuse(OF_TOKEN, openedWith(OPENING_ID), sameId);
    await refusals.refuse(OF_TOKEN, openedWith('unused'), sameId);

    await refusals.stop();

    assert.deepEqual(lines, [
      {
        fields: {
          data: {
            count: 2,
            firstSeenAt: START,
            lastSeenAt: START,
            reason: 'expiredToken',
            windowId: OPENING_ID,
          },
          eventType: 'bio.overture.managementToken.refusalTally',
        },
        message: CLOSING_UNRECORDED,
      },
    ]);
    assert.equal(CLOSING_UNRECORDED, 'refusalWindow.closingUnrecorded');
  });
});

suite('the stop', () => {
  test('closes every open window, settling once each closing event is recorded, and reads the clock no more', async (context) => {
    context.mock.timers.enable({ apis: ['setInterval'] });
    const { recorded, refusals, time } = windowed();
    refusals.start();
    const second: RefusalKey = { reason: 'otherIssuer', route: 'logout' };
    await refusals.refuse(OF_TOKEN, openedWith(OPENING_ID), sameId);
    await refusals.refuse(OF_TOKEN, openedWith('unused'), sameId);
    await refusals.refuse(second, openedWith(OPENING_ID), sameId);
    await refusals.refuse(second, openedWith('unused'), sameId);

    await refusals.stop();
    const atStop = recorded.length;
    await refusals.refuse(OF_TOKEN, openedWith(OPENING_ID), sameId);
    await refusals.refuse(OF_TOKEN, openedWith('unused'), sameId);
    time.now += REFUSAL_WINDOW_COOLDOWN_MILLISECONDS;
    context.mock.timers.tick(WINDOW_CLOCK_READING_MILLISECONDS);
    await settled();

    assert.equal(atStop, 2);
    assert.equal(recorded.length, 2);
  });
});
