import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
  DISPLAY_NAME_MAXIMUM_LENGTH,
  readDisplayName,
  storedDescription,
} from './displayName.js';

const DECOMPOSED = 'é'.normalize('NFD');

suite("reading an application's display name", () => {
  test('trims it at both ends, keeping whitespace inside, and normalizes it to NFC', () => {
    assert.deepEqual(readDisplayName(` \tÉtude\tde cas${DECOMPOSED} \r\n`), {
      displayName: `Étude\tde cas${'é'.normalize('NFC')}`.normalize('NFC'),
      kind: 'read',
    });
  });

  test('refuses one empty once trimmed', () => {
    ['', '   ', '\t\r\n'].forEach((given) =>
      assert.deepEqual(readDisplayName(given), {
        kind: 'refused',
        rule: 'blank',
      }),
    );
  });

  test('counts characters once trimmed and normalized, a decomposed one and one beyond the Basic Multilingual Plane each once', () => {
    const limit = DISPLAY_NAME_MAXIMUM_LENGTH;

    assert.equal(readDisplayName(` ${DECOMPOSED.repeat(limit)} `).kind, 'read');
    assert.equal(readDisplayName('🧬'.repeat(limit)).kind, 'read');
    assert.deepEqual(readDisplayName('D'.repeat(limit + 1)), {
      kind: 'refused',
      rule: 'tooLong',
    });
    assert.deepEqual(readDisplayName(DECOMPOSED.repeat(limit + 1)), {
      kind: 'refused',
      rule: 'tooLong',
    });
  });
});

suite("storing an application's description", () => {
  test('trims it, and stores none for one empty once trimmed or not sent', () => {
    assert.equal(storedDescription('  What it is for \n'), 'What it is for');
    assert.equal(storedDescription(' \t '), null);
    assert.equal(storedDescription(''), null);
    assert.equal(storedDescription(undefined), null);
  });
});
