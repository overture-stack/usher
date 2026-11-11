import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
  PAYLOAD_MEMBER_NAMES,
  validatePayload,
} from '@overture-stack/usher-types';

import type { Calculation } from '../tokenCalculation/index.js';
import { anonymousPayload } from './anonymousPayload.js';

const AUDIENCE = '0d4c7e2a-8b1f-4a63-9e05-3f7a2c9d1b68';

const ISSUED_AT = 1_767_225_600;

const CALCULATION: Calculation = {
  globalCategories: ['global.controlled'],
  grantCount: 0,
  permissions: {
    'étude « Nord » "A1"': {
      'global.unmarked': { record: ['count', 'view', 'export'] },
    },
  },
  resourceCategories: { 'étude « Nord » "A1"': ['resource.local-panel'] },
  rules: ['baseline'],
  servedResources: ['étude « Nord » "A1"', 'STUDY-C3'],
};

const ISSUING = {
  audience: AUDIENCE,
  issuedAt: ISSUED_AT,
  issuer: 'https://usher.example.org',
  lifetimeSeconds: 300,
};

suite("the anonymous visitor's payload", () => {
  test('names no subject, the issuer, the audience as one string, and payload version 1, issued and computed now and expiring a token lifetime later', () => {
    const payload = anonymousPayload(CALCULATION, ISSUING);

    assert.deepEqual(payload, {
      aud: AUDIENCE,
      exp: ISSUED_AT + 300,
      generatedAt: ISSUED_AT,
      globalCategories: ['global.controlled'],
      iat: ISSUED_AT,
      iss: 'https://usher.example.org',
      payloadVersion: 1,
      permissions: CALCULATION.permissions,
      resourceCategories: CALCULATION.resourceCategories,
      servedResources: ['étude « Nord » "A1"', 'STUDY-C3'],
      sub: null,
    });
  });

  test('carries every member of payload version 1 and no other, whatever else the calculation holds', () => {
    const payload = anonymousPayload(
      { ...CALCULATION, ...{ jti: 'not a member', nbf: ISSUED_AT } },
      ISSUING,
    );

    assert.deepEqual(
      Object.keys(payload).toSorted(),
      [...PAYLOAD_MEMBER_NAMES].toSorted(),
    );
    assert.equal(validatePayload(payload).success, true);
  });

  test("is a payload usher-types' validator accepts for an audience serving nothing", () => {
    const payload = anonymousPayload(
      {
        globalCategories: [],
        grantCount: 0,
        permissions: {},
        resourceCategories: {},
        rules: [],
        servedResources: [],
      },
      ISSUING,
    );

    assert.equal(validatePayload(payload).success, true);
  });
});
