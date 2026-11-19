import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { isUsableResource } from './bridgeWire.js';

suite('a value naming a resource in the payload contract', () => {
  test('is a non-empty string other than __proto__, holding no marker Arranger reads specially', () => {
    assert.deepEqual(
      [
        'STUDY-A1',
        'étude « Nord »',
        '',
        '__proto__',
        'STUDY-*',
        'set_id:7',
        '__missing__',
        7,
        null,
      ].map(isUsableResource),
      [true, true, false, false, false, false, false, false, false],
    );
  });
});
