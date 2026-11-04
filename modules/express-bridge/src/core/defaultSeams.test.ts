import assert from 'node:assert/strict';
import { suite, test } from 'node:test';
import { setImmediate as flushed } from 'node:timers/promises';

import { checkConfiguration } from './configuration.js';
import type { ControllerFetch } from './controllerClient.js';
import { defaultSeams } from './defaultSeams.js';
import { importApplicationKey } from './keys.js';
import { TEST_KEY } from './testTokens.js';

const quietLogger = {
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

const until = async (
  condition: () => boolean,
  giveUpAt = performance.now() + 5_000,
): Promise<void> => {
  if (condition()) {
    return;
  }
  assert.ok(performance.now() < giveUpAt, 'the awaited condition never held');
  await flushed();
  return until(condition, giveUpAt);
};

const settle = async (rounds = 50): Promise<void> => {
  if (rounds > 0) {
    await flushed();
    return settle(rounds - 1);
  }
};

suite('defaultSeams', () => {
  test('builds a channel polling at the configured recovery interval once a poll and its retry both fail', async (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
    context.mock.method(Math, 'random', () => 0.5);
    const check = checkConfiguration({
      audience: 'arranger-search',
      controllerUrl: 'https://usher.example.org/controller/',
      eventSource: 'https://search.example.org/usher-bridge',
      issuer: 'https://usher.example.org',
      key: TEST_KEY,
      logger: quietLogger,
      monotonicClock: { now: () => Date.now() },
      payloadVersions: [1],
      pollRecoveryIntervalMs: 4_000,
    });
    assert.ok(check.ok, 'the configuration was refused');
    const { key, ...configuration } = check.configuration;
    const keys = await importApplicationKey(key);
    const polls: string[] = [];
    const fetch: ControllerFetch = async (url) => {
      polls.push(url.pathname);
      throw new TypeError('fetch failed');
    };
    const { createChannel } = defaultSeams({ fetch });
    assert.ok(createChannel, 'the default seams build no channel');
    const channel = createChannel({
      configuration,
      core: {
        applyNotice: () => undefined,
        confirmChannel: () => undefined,
        reset: () => undefined,
      },
      events: { emit: () => undefined },
      keys,
    });

    channel.start();
    await until(() => polls.length === 1);
    await settle();
    context.mock.timers.tick(0);
    await until(() => polls.length === 2);
    await settle();
    context.mock.timers.tick(3_999);
    await settle();
    const beforeRecovery = polls.length;
    context.mock.timers.tick(1);
    await until(() => polls.length === 3);
    await channel.stop();

    assert.equal(beforeRecovery, 2);
    assert.deepEqual(polls, [
      '/controller/notices',
      '/controller/notices',
      '/controller/notices',
    ]);
  });
});
