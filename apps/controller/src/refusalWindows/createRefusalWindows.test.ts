import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
  createRefusalWindows,
  PER_TOKEN_WINDOW_LIMIT,
  REFUSAL_WINDOW_CEILING_MILLISECONDS,
  REFUSAL_WINDOW_COOLDOWN_MILLISECONDS,
} from './createRefusalWindows.js';
import type {
  ClosedWindow,
  RefusalKey,
  RefusalWindows,
  WindowCount,
} from './types.js';

const START = 1_800_000_000_000;

const MINUTE = 60_000;

const SEARCH = '4b1f6c2e-8d3a-4e5f-9a7b-0c1d2e3f4a5b';

const PORTAL = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';

// Stands in for the digest of a token that verified; the module never sees a token.
const digestOf = (token: number): string => `digest-${token}`;

const verified = (
  token: number,
  reason = 'expiredToken',
  route: RefusalKey['route'] = 'management',
): RefusalKey => ({ reason, route, tokenDigest: digestOf(token) });

interface Counting {
  time: { now: number };
  windows: RefusalWindows;
}

const counting = (): Counting => {
  const time = { now: START };
  return {
    time,
    windows: createRefusalWindows({ now: () => time.now }),
  };
};

const opened = (count: WindowCount): number => {
  assert.equal(count.kind, 'opened');
  return count.kind === 'opened' ? count.window : Number.NaN;
};

// What a test compares of a closed window: everything but the number the instance gave it.
const shapeOf = ({
  count,
  firstSeenAt,
  key,
  lastSeenAt,
}: ClosedWindow): Omit<ClosedWindow, 'window'> => ({
  count,
  firstSeenAt,
  key,
  lastSeenAt,
});

suite('counting refusals under their keys', () => {
  test('counts every refusal of one token for one reason in the window its first refusal opened, that first one included', () => {
    const { time, windows } = counting();

    const first = windows.count(verified(1));
    time.now += MINUTE;
    const second = windows.count(verified(1));
    time.now += MINUTE;
    const third = windows.count(verified(1));

    assert.equal(first.kind, 'opened');
    assert.deepEqual(second, { closed: [], kind: 'counted' });
    assert.deepEqual(third, { closed: [], kind: 'counted' });
    assert.deepEqual(windows.closeAll().map(shapeOf), [
      {
        count: 3,
        firstSeenAt: START,
        key: verified(1),
        lastSeenAt: START + 2 * MINUTE,
      },
    ]);
  });

  test('opens a window of its own for each reason one token is refused for, and for each token', () => {
    const { windows } = counting();

    const counts = [
      windows.count(verified(1, 'expiredToken')),
      windows.count(verified(1, 'revokedPrincipal')),
      windows.count(verified(2, 'expiredToken')),
    ];

    assert.deepEqual(
      counts.map(({ kind }) => kind),
      ['opened', 'opened', 'opened'],
    );
    assert.equal(new Set(counts.map(opened)).size, 3);
  });

  test("keeps each route's windows apart, one token refused for one reason at two routes opening two", () => {
    const { windows } = counting();

    const counts = [
      windows.count(verified(1, 'expiredToken', 'management')),
      windows.count(verified(1, 'expiredToken', 'exchange')),
    ];

    assert.deepEqual(
      counts.map(({ kind }) => kind),
      ['opened', 'opened'],
    );
  });

  test('counts every refusal of a credential that did not verify for one reason in one window, whatever the credential', () => {
    const { windows } = counting();

    const counts = [
      windows.count({ reason: 'invalidSignature', route: 'logout' }),
      windows.count({ reason: 'invalidSignature', route: 'logout' }),
      windows.count({ reason: 'otherIssuer', route: 'logout' }),
    ];

    assert.deepEqual(
      counts.map(({ kind }) => kind),
      ['opened', 'counted', 'opened'],
    );
  });

  test('counts the refusals of credentials that did not verify at the exchange per application and reason', () => {
    const { windows } = counting();

    const counts = [
      windows.count({
        applicationId: SEARCH,
        reason: 'invalidSignature',
        route: 'exchange',
      }),
      windows.count({
        applicationId: PORTAL,
        reason: 'invalidSignature',
        route: 'exchange',
      }),
      windows.count({
        applicationId: SEARCH,
        reason: 'invalidSignature',
        route: 'exchange',
      }),
    ];

    assert.deepEqual(
      counts.map(({ kind }) => kind),
      ['opened', 'opened', 'counted'],
    );
  });

  test("never counts a verified token's refusal in the window of credentials refused for that reason without verifying", () => {
    const { windows } = counting();

    const unverified = windows.count({
      applicationId: SEARCH,
      reason: 'expiredToken',
      route: 'exchange',
    });
    const ofToken = windows.count(verified(1, 'expiredToken', 'exchange'));

    assert.equal(unverified.kind, 'opened');
    assert.equal(ofToken.kind, 'opened');
  });
});

suite('closing a window after its cooldown', () => {
  test('closes a window once its key has gone 10 minutes without a refusal, with its count and the instants of its first and latest refusals', () => {
    const { time, windows } = counting();
    windows.count(verified(1));
    time.now += 4 * MINUTE;
    windows.count(verified(1));

    time.now += REFUSAL_WINDOW_COOLDOWN_MILLISECONDS - 1;
    const notYet = windows.closeDue();
    time.now += 1;
    const due = windows.closeDue();

    assert.deepEqual(notYet, []);
    assert.deepEqual(due.map(shapeOf), [
      {
        count: 2,
        firstSeenAt: START,
        key: verified(1),
        lastSeenAt: START + 4 * MINUTE,
      },
    ]);
    assert.deepEqual(windows.closeAll(), []);
  });

  test('keeps a window open while refusals under its key come less than 10 minutes apart', () => {
    const { time, windows } = counting();
    windows.count(verified(1));

    const kinds = Array.from({ length: 5 }, () => {
      time.now += REFUSAL_WINDOW_COOLDOWN_MILLISECONDS - 1;
      return windows.count(verified(1)).kind;
    });

    assert.deepEqual(kinds, [
      'counted',
      'counted',
      'counted',
      'counted',
      'counted',
    ]);
    assert.deepEqual(windows.closeDue(), []);
  });

  test('closes a window that saw one refusal with a count of one, its latest refusal its first', () => {
    const { time, windows } = counting();
    windows.count(verified(1));

    time.now += REFUSAL_WINDOW_COOLDOWN_MILLISECONDS;

    assert.deepEqual(windows.closeDue().map(shapeOf), [
      { count: 1, firstSeenAt: START, key: verified(1), lastSeenAt: START },
    ]);
  });

  test('opens a new window for the first refusal after the cooldown, closing the one before it first', () => {
    const { time, windows } = counting();
    const first = opened(windows.count(verified(1)));
    time.now += MINUTE;
    windows.count(verified(1));

    time.now += REFUSAL_WINDOW_COOLDOWN_MILLISECONDS;
    const next = windows.count(verified(1));

    assert.equal(next.kind, 'opened');
    assert.notEqual(opened(next), first);
    assert.deepEqual(
      next.closed.map(({ count, window }) => ({ count, window })),
      [{ count: 2, window: first }],
    );
  });

  test('closes the windows due in the order they opened, leaving the others open', () => {
    const { time, windows } = counting();
    const first = opened(windows.count(verified(1)));
    time.now += MINUTE;
    const second = opened(windows.count(verified(2)));
    time.now += MINUTE;
    windows.count(verified(3));

    time.now += REFUSAL_WINDOW_COOLDOWN_MILLISECONDS - MINUTE;
    const due = windows.closeDue();

    assert.deepEqual(
      due.map(({ window }) => window),
      [first, second],
    );
    assert.deepEqual(
      windows.closeAll().map(({ key }) => key),
      [verified(3)],
    );
  });
});

suite('closing a window at its ceiling', () => {
  // Refusals under one key every 9 minutes, the last at 54 minutes, so no gap reaches the cooldown.
  const STEP = 9 * MINUTE;
  const STEPS = 6;

  const refusedEveryStep = ({ time, windows }: Counting): readonly string[] =>
    Array.from({ length: STEPS }, () => {
      time.now += STEP;
      return windows.count(verified(1)).kind;
    });

  test('closes a window 60 minutes after it opened, however often refusals come under its key', () => {
    const subject = counting();
    const { time, windows } = subject;
    windows.count(verified(1));
    const counted = refusedEveryStep(subject);

    time.now = START + REFUSAL_WINDOW_CEILING_MILLISECONDS - 1;
    const notYet = windows.closeDue();
    time.now += 1;
    const due = windows.closeDue();

    assert.deepEqual(
      counted,
      Array.from({ length: STEPS }, () => 'counted'),
    );
    assert.deepEqual(notYet, []);
    assert.deepEqual(due.map(shapeOf), [
      {
        count: STEPS + 1,
        firstSeenAt: START,
        key: verified(1),
        lastSeenAt: START + STEPS * STEP,
      },
    ]);
  });

  test('opens a new window for a refusal at the ceiling, closing the one before it first', () => {
    const subject = counting();
    const { time, windows } = subject;
    const first = opened(windows.count(verified(1)));
    refusedEveryStep(subject);

    time.now = START + REFUSAL_WINDOW_CEILING_MILLISECONDS;
    const next = windows.count(verified(1));

    assert.equal(next.kind, 'opened');
    assert.deepEqual(
      next.closed.map(({ count, window }) => ({ count, window })),
      [{ count: STEPS + 1, window: first }],
    );
  });
});

suite('the cap on windows open per token', () => {
  // Opens a per-token window for each of the tokens numbered from the one given, one refusal each.
  const openFor = (
    windows: RefusalWindows,
    from: number,
    tokens: number,
  ): readonly WindowCount[] =>
    Array.from({ length: tokens }, (_, index) =>
      windows.count(verified(from + index)),
    );

  test('holds 10,000 windows open per token at once', () => {
    const { windows } = counting();

    const counts = openFor(windows, 0, PER_TOKEN_WINDOW_LIMIT);

    assert.equal(PER_TOKEN_WINDOW_LIMIT, 10_000);
    assert.ok(counts.every(({ kind }) => kind === 'opened'));
    assert.equal(windows.closeAll().length, PER_TOKEN_WINDOW_LIMIT);
  });

  test("counts a verified token's refusal past the cap in an overflow window for its route and reason, opened by the first and counting the rest", () => {
    const { time, windows } = counting();
    openFor(windows, 0, PER_TOKEN_WINDOW_LIMIT);

    time.now += MINUTE;
    const past = [
      windows.count(verified(PER_TOKEN_WINDOW_LIMIT)),
      windows.count(verified(PER_TOKEN_WINDOW_LIMIT + 1)),
      windows.count(verified(PER_TOKEN_WINDOW_LIMIT)),
      windows.count(verified(PER_TOKEN_WINDOW_LIMIT + 2, 'revokedPrincipal')),
    ];
    const closed = windows.closeAll();

    assert.deepEqual(
      past.map(({ kind }) => kind),
      ['opened', 'counted', 'counted', 'opened'],
    );
    assert.deepEqual(closed.slice(PER_TOKEN_WINDOW_LIMIT).map(shapeOf), [
      {
        count: 3,
        firstSeenAt: START + MINUTE,
        key: { reason: 'expiredToken', route: 'management' },
        lastSeenAt: START + MINUTE,
      },
      {
        count: 1,
        firstSeenAt: START + MINUTE,
        key: { reason: 'revokedPrincipal', route: 'management' },
        lastSeenAt: START + MINUTE,
      },
    ]);
  });

  test('keeps counting a refusal of a token whose window is already open, at the cap', () => {
    const { windows } = counting();
    openFor(windows, 0, PER_TOKEN_WINDOW_LIMIT);

    const again = windows.count(verified(0));

    assert.equal(again.kind, 'counted');
    assert.equal(windows.closeAll().length, PER_TOKEN_WINDOW_LIMIT);
  });

  test('takes no place under the cap for a window of credentials that did not verify', () => {
    const { windows } = counting();
    windows.count({ reason: 'invalidSignature', route: 'management' });
    windows.count({
      applicationId: SEARCH,
      reason: 'missingCredential',
      route: 'exchange',
    });

    const counts = openFor(windows, 0, PER_TOKEN_WINDOW_LIMIT);

    assert.ok(counts.every(({ kind }) => kind === 'opened'));
  });

  test('frees the place of each window per token it closes, due ones closed first once the cap is reached', () => {
    const { time, windows } = counting();
    windows.count(verified(0));
    time.now += MINUTE;
    openFor(windows, 1, PER_TOKEN_WINDOW_LIMIT - 1);

    time.now += REFUSAL_WINDOW_COOLDOWN_MILLISECONDS - MINUTE;
    const next = windows.count(verified(PER_TOKEN_WINDOW_LIMIT));

    assert.equal(next.kind, 'opened');
    assert.deepEqual(
      next.closed.map(({ key }) => key),
      [verified(0)],
    );
    assert.deepEqual(
      windows.closeAll().at(-1)?.key,
      verified(PER_TOKEN_WINDOW_LIMIT),
    );
  });

  test('closes an overflow window after its cooldown, as every window closes', () => {
    const { time, windows } = counting();
    openFor(windows, 0, PER_TOKEN_WINDOW_LIMIT);
    windows.count(verified(PER_TOKEN_WINDOW_LIMIT));
    time.now += MINUTE;
    windows.count(verified(0));

    time.now += REFUSAL_WINDOW_COOLDOWN_MILLISECONDS - MINUTE;
    const due = windows.closeDue();

    assert.deepEqual(
      due.map(({ key }) => key),
      [
        ...Array.from({ length: PER_TOKEN_WINDOW_LIMIT - 1 }, (_, index) =>
          verified(index + 1),
        ),
        { reason: 'expiredToken', route: 'management' },
      ],
    );
  });
});

suite("an instance's stop", () => {
  test('closes every open window whatever the clock, and the next refusal under a key opens a new one', () => {
    const { time, windows } = counting();
    const first = opened(windows.count(verified(1)));
    windows.count({ reason: 'invalidSignature', route: 'logout' });
    time.now += MINUTE;
    windows.count(verified(1));

    const closed = windows.closeAll();
    const next = windows.count(verified(1));

    assert.deepEqual(closed.map(shapeOf), [
      {
        count: 2,
        firstSeenAt: START,
        key: verified(1),
        lastSeenAt: START + MINUTE,
      },
      {
        count: 1,
        firstSeenAt: START,
        key: { reason: 'invalidSignature', route: 'logout' },
        lastSeenAt: START,
      },
    ]);
    assert.equal(next.kind, 'opened');
    assert.notEqual(opened(next), first);
    assert.deepEqual(next.closed, []);
  });
});
