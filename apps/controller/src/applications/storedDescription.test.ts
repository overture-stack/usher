import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { storedDescription } from './storedDescription.js';

suite("storing an application's description", () => {
  test('trims it, and stores none for one empty once trimmed or not sent', () => {
    assert.equal(storedDescription('  What it is for \n'), 'What it is for');
    assert.equal(storedDescription(' \t '), null);
    assert.equal(storedDescription(''), null);
    assert.equal(storedDescription(undefined), null);
  });
});
