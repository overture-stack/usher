import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { admissionShare, SHARE_FLOOR } from './admissionShare.js';

suite("an application's admission share", () => {
  test('divides the pool equally among the registered applications, rounded down', () => {
    const shares = [
      admissionShare(10, 1),
      admissionShare(10, 2),
      admissionShare(10, 3),
      admissionShare(10, 4),
      admissionShare(10, 10),
      admissionShare(25, 4),
    ];

    assert.deepEqual(shares, [10, 5, 3, 2, 1, 6]);
  });

  test('admits at least one exchange per application, however many more applications than connections are registered', () => {
    const shares = [
      admissionShare(10, 11),
      admissionShare(10, 20),
      admissionShare(1, 2),
    ];

    assert.equal(SHARE_FLOOR, 1);
    assert.deepEqual(shares, [1, 1, 1]);
  });

  test('reads a registered count below one as the one application an admitted exchange is for', () => {
    assert.deepEqual([admissionShare(10, 0), admissionShare(10, -3)], [10, 10]);
  });
});
