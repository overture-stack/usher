import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
  EXTERNAL_ID_MAXIMUM_LENGTH,
  externalIdRuleBroken,
} from './externalId.js';

suite("an externalId's form", () => {
  test('keeps every rule with ASCII letters, digits, dots, underscores and hyphens, starting with a letter or a digit', () => {
    const kept = ['STUDY-A1', 'study.c_4', '7up', 'a', 'A'.repeat(128)];

    assert.deepEqual(
      kept.map(externalIdRuleBroken),
      kept.map(() => undefined),
    );
  });

  test('breaks the normalization rule when not in Unicode normalization form C, before any other', () => {
    assert.equal(externalIdRuleBroken('ÉTUDE'), 'normalization');
    assert.equal(externalIdRuleBroken(`é${'x'.repeat(200)}`), 'normalization');
  });

  test('breaks the length rule when empty or longer than 128 characters, counting a character beyond the Basic Multilingual Plane once', () => {
    assert.equal(EXTERNAL_ID_MAXIMUM_LENGTH, 128);
    assert.equal(externalIdRuleBroken(''), 'length');
    assert.equal(externalIdRuleBroken('A'.repeat(129)), 'length');
    assert.equal(externalIdRuleBroken('\u{1F600}'.repeat(128)), 'characters');
    assert.equal(externalIdRuleBroken('\u{1F600}'.repeat(129)), 'length');
  });

  test('breaks the character rule for a first character other than a letter or a digit, or any character beyond the default set', () => {
    const broken = [
      '-STUDY',
      '.STUDY',
      '_STUDY',
      '__proto__',
      'STUDY A1',
      'STUDY:A1',
      'STUDY*',
      'set_id:1',
      'ÉTUDE-1',
      'STUDY-ı',
      'STUDY/A1',
    ];

    assert.deepEqual(
      broken.map(externalIdRuleBroken),
      broken.map(() => 'characters'),
    );
  });

  test('breaks the filter marker rule for a missing-field marker held inside', () => {
    assert.equal(externalIdRuleBroken('A__missing__B'), 'filterMarker');
    assert.equal(externalIdRuleBroken('A__missing_B'), undefined);
  });
});
