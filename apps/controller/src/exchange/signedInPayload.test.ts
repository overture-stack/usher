import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
  PAYLOAD_MEMBER_NAMES,
  validatePayload,
} from '@overture-stack/usher-types';

import type { Calculation } from '../tokenCalculation/index.js';
import { signedInPayload } from './signedInPayload.js';

const AUDIENCE = '0d4c7e2a-8b1f-4a63-9e05-3f7a2c9d1b68';

const ISSUED_AT = 1_767_225_600;

const CALCULATION: Calculation = {
  globalCategories: ['global.controlled'],
  grantCount: 0,
  permissions: {
    MEMBERS_ARCHIVE: { 'global.unmarked': { record: ['view'] } },
    'étude « Nord » "A1"': {
      'global.unmarked': { record: ['count', 'view', 'export'] },
    },
  },
  resourceCategories: {
    MEMBERS_ARCHIVE: [],
    'étude « Nord » "A1"': ['resource.local-panel'],
  },
  rules: ['baseline', 'signedIn'],
  servedResources: ['étude « Nord » "A1"', 'MEMBERS_ARCHIVE', 'STUDY-C3'],
};

const ISSUING = {
  audience: AUDIENCE,
  issuedAt: ISSUED_AT,
  issuer: 'https://usher.example.org',
  lifetimeSeconds: 300,
  signInExpiresAt: ISSUED_AT + 3600,
  subject: 'subject "ana" \\',
};

suite("a signed-in principal's payload", () => {
  test("names the identity provider's subject, the issuer, the audience as one string, and payload version 1, issued and computed now", () => {
    const payload = signedInPayload(CALCULATION, ISSUING);

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
      servedResources: ['étude « Nord » "A1"', 'MEMBERS_ARCHIVE', 'STUDY-C3'],
      sub: 'subject "ana" \\',
    });
  });

  test('expires a token lifetime after it is issued when the sign-in token outlives that', () => {
    const { exp } = signedInPayload(CALCULATION, {
      ...ISSUING,
      signInExpiresAt: ISSUED_AT + 301,
    });

    assert.equal(exp, ISSUED_AT + 300);
  });

  test('expires with the sign-in token when that expires sooner than a token lifetime', () => {
    const { exp } = signedInPayload(CALCULATION, {
      ...ISSUING,
      signInExpiresAt: ISSUED_AT + 90,
    });

    assert.equal(exp, ISSUED_AT + 90);
  });

  test('expires one second after it is issued for a sign-in token expiring one second after the issuing second', () => {
    const { exp, iat } = signedInPayload(CALCULATION, {
      ...ISSUING,
      signInExpiresAt: ISSUED_AT + 1,
    });

    assert.deepEqual({ exp, iat }, { exp: ISSUED_AT + 1, iat: ISSUED_AT });
  });

  test("carries every member of payload version 1 and no other, whatever else the calculation holds, and is a payload usher-types' validator accepts", () => {
    const payload = signedInPayload(
      { ...CALCULATION, ...{ jti: 'not a member', nbf: ISSUED_AT } },
      ISSUING,
    );

    assert.deepEqual(
      Object.keys(payload).toSorted(),
      [...PAYLOAD_MEMBER_NAMES].toSorted(),
    );
    assert.equal(validatePayload(payload).success, true);
  });
});
