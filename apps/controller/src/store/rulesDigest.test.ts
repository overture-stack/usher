import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { baselineChange, rulesDigestOf } from './rulesDigest.js';

suite('the digest of the baseline and the signed-in rule', () => {
  test('is 32 bytes as base64url, the same for the same rules', () => {
    const rules = {
      baseline: ['count', 'view', 'export'],
      signedInRule: ['count', 'view', 'export'],
    } as const;

    const digest = rulesDigestOf(rules);

    assert.match(digest, /^[\w-]{43}$/u);
    assert.equal(rulesDigestOf({ ...rules }), digest);
  });

  test('is the same for a rule naming its actions in another order', () => {
    assert.equal(
      rulesDigestOf({ baseline: ['view', 'count'], signedInRule: ['export'] }),
      rulesDigestOf({ baseline: ['count', 'view'], signedInRule: ['export'] }),
    );
  });

  test('differs when either rule confers another action, and when an action moves from one rule to the other', () => {
    const recorded = rulesDigestOf({
      baseline: ['count'],
      signedInRule: ['count', 'view'],
    });

    const digests = [
      rulesDigestOf({
        baseline: ['count', 'view'],
        signedInRule: ['count', 'view'],
      }),
      rulesDigestOf({ baseline: ['count'], signedInRule: ['count'] }),
      rulesDigestOf({ baseline: [], signedInRule: ['count', 'view'] }),
      rulesDigestOf({ baseline: ['count', 'view'], signedInRule: ['count'] }),
    ];

    assert.equal(new Set([recorded, ...digests]).size, digests.length + 1);
  });
});

suite('the baseline change a start records', () => {
  test("names each rule's actions, sorted, as baseline.change", () => {
    const event = baselineChange(
      {
        baseline: ['view', 'count'],
        signedInRule: ['export', 'view', 'count'],
      },
      false,
    );

    assert.equal(event.type, 'baseline.change');
    assert.deepEqual(event.data, {
      baseline: ['count', 'view'],
      signedInRule: ['count', 'export', 'view'],
    });
    assert.equal(event.actor, undefined);
  });

  test("records at info at the store's first start, and at warning when it replaces recorded rules", () => {
    const rules = { baseline: ['count'], signedInRule: ['view'] } as const;

    assert.equal(baselineChange(rules, false).severity, 'info');
    assert.equal(baselineChange(rules, true).severity, 'warning');
  });
});
