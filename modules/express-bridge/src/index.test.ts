import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { validateRegistration } from '@overture-stack/usher-types';

import * as bridge from './index.js';
import type {
  KeyRegistration,
  OpenKeyRegistration,
  RecordKeyRegistration,
} from './index.js';

suite('the package root', () => {
  test('exports the bridge, the Express layer and the credential reader as functions', () => {
    const exported = [
      bridge.createBridgeCore,
      bridge.createUsherMiddleware,
      bridge.readBearerCredential,
    ];

    assert.deepEqual(
      exported.map((member) => typeof member),
      ['function', 'function', 'function'],
    );
  });

  test('exports no seam taking the imported keys, and nothing the tests use', () => {
    const names = Object.keys(bridge);

    assert.deepEqual(
      names.filter((name) =>
        [
          'createBridgeCoreWithSeams',
          'defaultSeams',
          'importApplicationKey',
          'mintUsherToken',
          'startControllerMock',
          'TEST_KEY',
          'TEST_KEY_BYTES',
        ].includes(name),
      ),
      [],
    );
  });

  test("exports the suspended marker's header name, which every application's interface reads", () => {
    assert.equal(bridge.SUSPENDED_HEADER, 'Usher-Suspended');
  });

  test('exports the registration types an adapter builds its registrations from, as usher-types defines them', () => {
    const registrations: readonly KeyRegistration[] = [
      {
        categories: {
          global: {
            'global.controlled': {
              content: { fieldName: 'data_category', value: ['controlled'] },
              op: 'in',
            },
          },
        },
        kind: 'record',
        resourceFieldName: 'study_id',
      } satisfies RecordKeyRegistration,
      { kind: 'open' } satisfies OpenKeyRegistration,
    ];

    const accepted = registrations.map(
      (registration) => validateRegistration(registration).success,
    );

    assert.deepEqual(accepted, [true, true]);
  });

  test('exports the defaults frozen, so no host can change them for another', () => {
    assert.equal(Object.isFrozen(bridge.CONFIGURATION_DEFAULTS), true);
    assert.equal(Object.isFrozen(bridge.ANSWERS), true);
  });
});
