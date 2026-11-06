import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { suite, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { build } from 'tsdown';

import {
  readRefusal,
  spawnController,
  unusedPort,
} from './test-support/controller.js';
import config from './tsdown.config.js';

const APP_ROOT = new URL('./', import.meta.url);

// The log stream's numbering of fatal, which a refusal to start is written at.
const FATAL_LEVEL = 60;

// Inside the app, as `dist/` is, so the app's package type and its dependencies apply to what is
// built; a name ending in `.tmp` is one the repository ignores.
const outputFolder = async (): Promise<URL> => {
  const folder = new URL(`build-${randomUUID()}.tmp/`, APP_ROOT);
  await mkdir(folder);
  return folder;
};

const linesOf = (text: string): readonly unknown[] =>
  text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line): unknown => JSON.parse(line));

suite("the controller's build", () => {
  test('gives a main entry that runs under Node alone and refuses an empty environment as the source does', async (context) => {
    const outDir = await outputFolder();
    context.after(() => rm(outDir, { force: true, recursive: true }));
    await build({
      ...config,
      config: false,
      cwd: fileURLToPath(APP_ROOT),
      logLevel: 'warn',
      outDir: fileURLToPath(outDir),
    });
    const refusal = await readRefusal({});
    assert.ok(refusal instanceof Error && 'variables' in refusal);

    // An empty environment names no port, so one nothing listens on is probed.
    const exit = await spawnController(
      {},
      { builtEntry: new URL('main.js', outDir), port: await unusedPort() },
    );
    const [line, ...laterLines] = linesOf(exit.stderr);

    assert.equal(exit.timedOut, false);
    assert.equal(exit.exitCode, 1);
    assert.equal(exit.stdout, '');
    assert.deepEqual(laterLines, []);
    assert.ok(typeof line === 'object' && line !== null);
    // The time is the line's own, so the comparison holds it present at any value.
    assert.deepEqual(line, {
      level: FATAL_LEVEL,
      variables: refusal.variables,
      message: refusal.message,
      time: 'time' in line ? line.time : undefined,
    });
  });
});
