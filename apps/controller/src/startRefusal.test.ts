import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { StartRefusal } from './startRefusal.js';

suite('a refusal to start', () => {
  test('names each variable with the rule it broke, and lists the variables in the order found', () => {
    const refusal = new StartRefusal([
      { rule: 'is missing', variable: 'USHER_ISSUER' },
      { rule: 'is not a URL', variable: 'USHER_CACHE_URL' },
    ]);

    assert.equal(refusal.name, 'StartRefusal');
    assert.equal(
      refusal.message,
      'the controller refuses to start: USHER_ISSUER is missing; USHER_CACHE_URL is not a URL',
    );
    assert.deepEqual(refusal.variables, ['USHER_ISSUER', 'USHER_CACHE_URL']);
    assert.ok(refusal instanceof Error);
  });
});
