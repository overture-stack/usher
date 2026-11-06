import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { createUsedAssertions } from './createUsedAssertions.js';

suite('the record of assertions presented to the stream', () => {
  test('records an assertion once, and refuses it again while it is accepted', () => {
    const used = createUsedAssertions({ now: () => 1_000 });

    assert.equal(used.record('search', 'jti-1', 2_000), true);
    assert.equal(used.record('search', 'jti-1', 2_000), false);
  });

  test('knows an assertion by its application and its jti together', () => {
    const used = createUsedAssertions({ now: () => 1_000 });

    used.record('search', 'jti-1', 2_000);

    assert.equal(used.record('portal', 'jti-1', 2_000), true);
    assert.equal(used.record('search', 'jti-2', 2_000), true);
  });

  test('forgets an assertion once it is no longer accepted', () => {
    const clock = { at: 1_000 };
    const used = createUsedAssertions({ now: () => clock.at });
    used.record('search', 'jti-1', 2_000);

    clock.at = 2_001;

    assert.equal(used.record('search', 'jti-1', 3_000), true);
  });
});
