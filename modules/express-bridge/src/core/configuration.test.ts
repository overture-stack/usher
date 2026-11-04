import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type { ValidationProblem } from '@overture-stack/usher-types';

import {
  type BridgeConfiguration,
  CONFIGURATION_DEFAULTS,
  type ConfigurationCheck,
  checkConfiguration,
  START_REFUSAL_RULES,
} from './configuration.js';
import { START_REFUSAL_REASONS } from './events.js';

/** A key in canonical form: 32 bytes, so its last character carries two zero bits. */
const KEY = Buffer.alloc(32, 7).toString('base64url');

const quietLogger = {
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

const minimal = (): BridgeConfiguration => ({
  audience: 'arranger-search',
  controllerUrl: 'https://usher.example.org/api',
  eventSource: 'https://search.example.org/usher-bridge',
  issuer: 'https://usher.example.org',
  key: KEY,
  logger: quietLogger,
  payloadVersions: [1],
});

const checkWith = (members: Record<string, unknown>): ConfigurationCheck =>
  checkConfiguration({ ...minimal(), ...members } as BridgeConfiguration);

const refusalFor = (members: Record<string, unknown>): string | undefined => {
  const check = checkWith(members);
  return check.ok ? undefined : check.reason;
};

const problemsFor = (
  members: Record<string, unknown>,
): readonly ValidationProblem[] | undefined => {
  const check = checkWith(members);
  return check.ok ? undefined : check.problems;
};

suite('checkConfiguration', () => {
  test('accepts the minimal configuration, filling in every default', () => {
    const check = checkConfiguration(minimal());

    assert.equal(check.ok, true);
    const configuration = check.ok ? check.configuration : undefined;
    assert.deepEqual(
      {
        exchangeTimeoutMs: configuration?.exchangeTimeoutMs,
        filterClauseLimit: configuration?.filterClauseLimit,
        graceMs: configuration?.graceMs,
        inFlightMax: configuration?.inFlightMax,
        localRefusalClockToleranceMs:
          configuration?.localRefusalClockToleranceMs,
        pollDeadlineMs: configuration?.pollDeadlineMs,
        pollIntervalMs: configuration?.pollIntervalMs,
        pollRecoveryIntervalMs: configuration?.pollRecoveryIntervalMs,
        pushIdleMs: configuration?.pushIdleMs,
        responseCapBytes: configuration?.responseCapBytes,
        stores: configuration?.stores,
        tokenTtlMs: configuration?.tokenTtlMs,
      },
      {
        exchangeTimeoutMs: 5_000,
        filterClauseLimit: 1_024,
        graceMs: 60_000,
        inFlightMax: 64,
        localRefusalClockToleranceMs: 60_000,
        pollDeadlineMs: 10_000,
        pollIntervalMs: 30_000,
        pollRecoveryIntervalMs: 10_000,
        pushIdleMs: 25_000,
        responseCapBytes: 1_048_576,
        stores: {
          failureHoldMs: 10_000,
          failureMax: 1_000,
          positiveMax: 10_000,
          refusalMax: 10_000,
        },
        tokenTtlMs: 300_000,
      },
    );
    assert.deepEqual(CONFIGURATION_DEFAULTS.stores, configuration?.stores);
    assert.equal(
      CONFIGURATION_DEFAULTS.filterClauseLimit,
      configuration?.filterClauseLimit,
    );
  });

  test('normalizes the controller URL to end in a slash, so a request built relative to it keeps its path', () => {
    const check = checkConfiguration(minimal());

    const exchange = check.ok
      ? new URL('exchange', check.configuration.controllerUrl).href
      : undefined;

    assert.equal(exchange, 'https://usher.example.org/api/exchange');
  });

  test('keeps a value given in place of a default', () => {
    const check = checkConfiguration({
      ...minimal(),
      graceMs: 90_000,
      stores: { failureHoldMs: 30_000 },
    });

    assert.equal(check.ok && check.configuration.graceMs, 90_000);
    assert.equal(check.ok && check.configuration.stores.failureHoldMs, 30_000);
    assert.equal(check.ok && check.configuration.stores.positiveMax, 10_000);
  });

  test('defaults the clocks to Date.now and performance.now', () => {
    const check = checkConfiguration(minimal());

    const wall = check.ok ? check.configuration.clocks.wall.now() : 0;
    const monotonic = check.ok
      ? check.configuration.clocks.monotonic.now()
      : -1;

    assert.ok(Math.abs(wall - Date.now()) < 1_000);
    assert.ok(Math.abs(monotonic - performance.now()) < 1_000);
  });

  suite('the application key', () => {
    for (const [description, key] of [
      ['42 characters', KEY.slice(0, 42)],
      ['44 characters with padding', `${KEY}=`],
      ['standard base64 characters', `${KEY.slice(0, 41)}+/`],
      ['a last character carrying bits past 32 bytes', `${KEY.slice(0, 42)}B`],
      ['a number', 42],
    ] as const) {
      test(`refuses a key of ${description}`, () => {
        assert.equal(refusalFor({ key }), 'keyUnusable');
      });
    }

    for (const [description, key] of [
      ['a trailing newline', `${KEY}\n`],
      ['a trailing CRLF', `${KEY}\r\n`],
      ['spaces and tabs around it', ` \t${KEY}\t `],
    ] as const) {
      test(`accepts a key with ${description}, and holds it without the whitespace`, () => {
        const check = checkWith({ key });

        assert.equal(check.ok ? check.configuration.key : undefined, KEY);
      });
    }

    for (const [description, key] of [
      ['a space inside it', `${KEY.slice(0, 21)} ${KEY.slice(21)}`],
      ['whitespace alone', ' \n'],
    ] as const) {
      test(`refuses a key of ${description}`, () => {
        assert.equal(refusalFor({ key }), 'keyUnusable');
      });
    }
  });

  suite('the controller URL', () => {
    for (const url of [
      'http://127.0.0.1:8080/',
      'http://localhost/usher',
      'http://[::1]:9000',
      'https://usher.internal',
    ]) {
      test(`accepts ${url}`, () => {
        assert.equal(refusalFor({ controllerUrl: url }), undefined);
      });
    }

    for (const url of ['http://usher.internal', 'http://10.0.0.5:8080']) {
      test(`refuses plain http to ${url}, which is not loopback`, () => {
        assert.equal(
          refusalFor({ controllerUrl: url }),
          'controllerUrlInsecure',
        );
      });
    }

    for (const [description, url] of [
      ['an unparseable string', 'usher'],
      ['another scheme', 'ftp://usher.example.org'],
      ['credentials', 'https://bridge:secret@usher.example.org'],
      ['a query', 'https://usher.example.org/api?tenant=1'],
      ['a fragment', 'https://usher.example.org/api#exchange'],
    ]) {
      test(`refuses a controller URL with ${description}`, () => {
        assert.equal(
          refusalFor({ controllerUrl: url }),
          'controllerUrlInvalid',
        );
      });
    }

    test('accepts a URL object as well as a string', () => {
      assert.equal(
        refusalFor({ controllerUrl: new URL('https://usher.example.org') }),
        undefined,
      );
    });
  });

  suite('the intervals', () => {
    test('refuses a poll interval whose jittered worst case, plus twice the deadline, passes the grace period', () => {
      const reason = refusalFor({
        graceMs: 60_000,
        pollDeadlineMs: 10_000,
        pollIntervalMs: 38_000,
      });

      assert.equal(reason, 'intervalsOutOfOrder');
    });

    test('refuses the intervals at exactly the grace period, since the ordering is strict', () => {
      const reason = refusalFor({
        graceMs: 53_000,
        pollDeadlineMs: 10_000,
        pollIntervalMs: 30_000,
      });

      assert.equal(reason, 'intervalsOutOfOrder');
    });

    test('refuses a push idle timeout longer than the poll interval', () => {
      const reason = refusalFor({ pollIntervalMs: 30_000, pushIdleMs: 30_001 });

      assert.equal(reason, 'intervalsOutOfOrder');
    });

    test('accepts a push idle timeout equal to the poll interval', () => {
      const reason = refusalFor({ pollIntervalMs: 30_000, pushIdleMs: 30_000 });

      assert.equal(reason, undefined);
    });

    test('refuses a poll recovery interval longer than the poll interval, under a rule stating so, and accepts one equal to it', () => {
      const longer = refusalFor({
        pollIntervalMs: 30_000,
        pollRecoveryIntervalMs: 30_001,
      });
      const equal = refusalFor({
        pollIntervalMs: 30_000,
        pollRecoveryIntervalMs: 30_000,
      });

      assert.equal(longer, 'intervalsOutOfOrder');
      assert.equal(equal, undefined);
      assert.match(
        START_REFUSAL_RULES.intervalsOutOfOrder,
        /the poll recovery interval is at most the poll interval/u,
      );
    });

    test('defaults the recovery interval to the smaller of 10 s and the poll interval, so a host setting no recovery interval is accepted with a poll interval below 10 s', () => {
      const below = checkWith({ pollIntervalMs: 5_000, pushIdleMs: 5_000 });
      const above = checkWith({ pollIntervalMs: 20_000, pushIdleMs: 5_000 });

      assert.equal(CONFIGURATION_DEFAULTS.pollRecoveryIntervalMs, 10_000);
      assert.equal(
        below.ok && below.configuration.pollRecoveryIntervalMs,
        5_000,
      );
      assert.equal(
        above.ok && above.configuration.pollRecoveryIntervalMs,
        10_000,
      );
    });

    test('refuses a recovery interval set above a poll interval below 10 s, under the rule ordering the intervals', () => {
      const reason = refusalFor({
        pollIntervalMs: 5_000,
        pollRecoveryIntervalMs: 6_000,
        pushIdleMs: 5_000,
      });

      assert.equal(reason, 'intervalsOutOfOrder');
    });

    test('accepts intervals 1 ms inside the ordering', () => {
      const reason = refusalFor({
        graceMs: 53_001,
        pollDeadlineMs: 10_000,
        pollIntervalMs: 30_000,
      });

      assert.equal(reason, undefined);
    });
  });

  suite('the floor on the poll interval and the recovery interval', () => {
    for (const [position, members] of [
      ['pollIntervalMs', { pollIntervalMs: 999, pushIdleMs: 999 }],
      ['pollRecoveryIntervalMs', { pollRecoveryIntervalMs: 999 }],
    ] as const) {
      test(`refuses ${position} at 999 ms by a problem positioned at its name, naming no value`, () => {
        const check = checkWith(members);

        assert.equal(check.ok ? undefined : check.reason, 'numberOutOfRange');
        assert.deepEqual(check.ok ? undefined : check.problems, [
          { position, rule: START_REFUSAL_RULES.numberOutOfRange },
        ]);
        assert.equal(JSON.stringify(check).includes('999'), false);
      });
    }

    for (const [position, members] of [
      ['pollIntervalMs', { pollIntervalMs: 1_000, pushIdleMs: 1_000 }],
      ['pollRecoveryIntervalMs', { pollRecoveryIntervalMs: 1_000 }],
    ] as const) {
      test(`accepts ${position} at 1000 ms`, () => {
        const check = checkWith(members);

        assert.equal(check.ok && check.configuration[position], 1_000);
      });
    }

    test('states the floor in the rule a refusal names', () => {
      assert.match(
        START_REFUSAL_RULES.numberOutOfRange,
        /the poll interval and the poll recovery interval are each at least 1000 milliseconds/u,
      );
    });
  });

  suite('a numeric setting out of range', () => {
    const numericSettings = [
      ...Object.keys(CONFIGURATION_DEFAULTS).filter(
        (name) => !['localRefusalClockToleranceMs', 'stores'].includes(name),
      ),
      ...Object.keys(CONFIGURATION_DEFAULTS.stores)
        .filter((name) => name !== 'failureHoldMs')
        .map((name) => `stores.${name}`),
    ];

    const given = (
      position: string,
      value: unknown,
    ): Record<string, unknown> =>
      position.startsWith('stores.')
        ? { stores: { [position.slice('stores.'.length)]: value } }
        : { [position]: value };

    for (const position of numericSettings) {
      test(`refuses ${position} at 0 by a problem positioned at its name`, () => {
        assert.deepEqual(problemsFor(given(position, 0)), [
          { position, rule: START_REFUSAL_RULES.numberOutOfRange },
        ]);
      });
    }

    test('positions a problem at each setting out of range, in the order the settings are listed', () => {
      const problems = problemsFor({
        exchangeTimeoutMs: 2.5,
        graceMs: 0,
        stores: { refusalMax: -1 },
      });

      assert.deepEqual(
        problems?.map(({ position }) => position),
        ['exchangeTimeoutMs', 'graceMs', 'stores.refusalMax'],
      );
    });

    test('positions no problem for a refusal under any other rule', () => {
      assert.deepEqual(problemsFor({ audience: '' }), []);
      assert.deepEqual(problemsFor({ pushIdleMs: 30_001 }), []);
    });
  });

  suite('the failure hold', () => {
    for (const failureHoldMs of [1_000, 60_000]) {
      test(`accepts ${failureHoldMs} ms, inside its bounds`, () => {
        assert.equal(refusalFor({ stores: { failureHoldMs } }), undefined);
      });
    }

    for (const failureHoldMs of [999, 60_001, 1_500.5, Number.NaN]) {
      test(`refuses ${failureHoldMs} ms`, () => {
        assert.equal(
          refusalFor({ stores: { failureHoldMs } }),
          'failureHoldOutOfBounds',
        );
      });
    }
  });

  suite('the filter clause limit', () => {
    test('keeps a positive whole number given in place of the default', () => {
      const check = checkConfiguration({ ...minimal(), filterClauseLimit: 12 });

      assert.equal(check.ok && check.configuration.filterClauseLimit, 12);
    });

    for (const [description, filterClauseLimit] of [
      ['zero', 0],
      ['a negative number', -1],
      ['a fraction', 1_024.5],
      ['a value that is not a number', '1024'],
    ] as const) {
      test(`refuses ${description}, as it does any bound that is not a positive whole number`, () => {
        assert.equal(refusalFor({ filterClauseLimit }), 'numberOutOfRange');
      });
    }
  });

  suite('the local refusal clock tolerance', () => {
    test('accepts 0', () => {
      assert.equal(refusalFor({ localRefusalClockToleranceMs: 0 }), undefined);
    });

    for (const tolerance of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      test(`refuses ${tolerance}`, () => {
        assert.equal(
          refusalFor({ localRefusalClockToleranceMs: tolerance }),
          'refusalToleranceInvalid',
        );
      });
    }
  });

  suite('the other members', () => {
    for (const [description, members, reason] of [
      ['an empty audience', { audience: '' }, 'audienceEmpty'],
      ['an empty issuer', { issuer: '' }, 'issuerEmpty'],
      ['an empty event source', { eventSource: '' }, 'eventSourceEmpty'],
      ['no payload version', { payloadVersions: [] }, 'payloadVersionsInvalid'],
      [
        'a payload version of 0',
        { payloadVersions: [0] },
        'payloadVersionsInvalid',
      ],
      [
        'a repeated payload version',
        { payloadVersions: [1, 1] },
        'payloadVersionsInvalid',
      ],
      [
        'a fractional payload version',
        { payloadVersions: [1.5] },
        'payloadVersionsInvalid',
      ],
      ['a zero in-flight bound', { inFlightMax: 0 }, 'numberOutOfRange'],
      [
        'a fractional exchange timeout',
        { exchangeTimeoutMs: 2.5 },
        'numberOutOfRange',
      ],
      ['a negative token TTL', { tokenTtlMs: -1 }, 'numberOutOfRange'],
      ['a zero response cap', { responseCapBytes: 0 }, 'numberOutOfRange'],
      [
        'a fractional push idle timeout',
        { pushIdleMs: 2.5 },
        'numberOutOfRange',
      ],
      [
        'a zero poll recovery interval',
        { pollRecoveryIntervalMs: 0 },
        'numberOutOfRange',
      ],
      [
        'a fractional poll recovery interval',
        { pollRecoveryIntervalMs: 2.5 },
        'numberOutOfRange',
      ],
      [
        'a store bound that is not a number',
        { stores: { positiveMax: '10000' } },
        'numberOutOfRange',
      ],
      [
        'a logger missing warn',
        { logger: { error: () => undefined, info: () => undefined } },
        'loggerInvalid',
      ],
      ['a clock with no now', { wallClock: {} }, 'clockInvalid'],
    ] as const) {
      test(`refuses ${description}`, () => {
        assert.equal(refusalFor(members), reason);
      });
    }
  });

  test('names each refusal by a rule with fixed text, for every reason start can give', () => {
    const missing = START_REFUSAL_REASONS.filter(
      (reason) => !Object.hasOwn(START_REFUSAL_RULES, reason),
    );

    assert.deepEqual(missing, []);
    assert.ok(
      Object.values(START_REFUSAL_RULES).every(
        (rule) => typeof rule === 'string' && rule.length > 0,
      ),
    );
  });
});
