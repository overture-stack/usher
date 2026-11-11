import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
  deniedExchangeEvent,
  failedExchangeEvent,
  issuedExchangeEvent,
} from './exchangeEvents.js';

const AUDIENCE = '0d4c7e2a-8b1f-4a63-9e05-3f7a2c9d1b68';

suite("the exchange's token.exchange events", () => {
  test('records an issued token at info as succeeded, with its lifetime, its grants counted, its rules, its audience, its computation time as an instant, and its subject as userId', () => {
    const event = issuedExchangeEvent({
      audience: AUDIENCE,
      generatedAt: 1_767_225_600,
      grantCount: 0,
      rules: ['baseline'],
      sourceIp: '192.0.2.10',
      subject: null,
      tokenTtl: 300,
    });

    assert.deepEqual(event, {
      data: {
        audience: AUDIENCE,
        generatedAt: '2026-01-01T00:00:00.000Z',
        grantCount: 0,
        result: 'succeeded',
        rules: ['baseline'],
        sourceIp: '192.0.2.10',
        tokenTtl: 300,
        userId: null,
      },
      severity: 'info',
      type: 'token.exchange',
    });
  });

  test('records an empty rules list where no rule conferred anything', () => {
    const event = issuedExchangeEvent({
      audience: AUDIENCE,
      generatedAt: 1_767_225_600,
      grantCount: 0,
      rules: [],
      sourceIp: '192.0.2.10',
      subject: null,
      tokenTtl: 300,
    });

    assert.deepEqual(event.data['rules'], []);
  });

  test('records a refused credential at warning as denied, under its reason, naming no userId', () => {
    const event = deniedExchangeEvent({
      reason: 'apiKeyVerifierNotConfigured',
      sourceIp: '192.0.2.10',
    });

    assert.deepEqual(event, {
      data: {
        reason: 'apiKeyVerifierNotConfigured',
        result: 'denied',
        sourceIp: '192.0.2.10',
        userId: null,
      },
      severity: 'warning',
      type: 'token.exchange',
    });
  });

  test('names the refused subject where the judgement names it, and leaves the member out where it does not', () => {
    const named = deniedExchangeEvent({
      reason: 'expiredToken',
      refusedSubject: 'subject "ana" \\',
      sourceIp: '192.0.2.10',
    });
    const unnamed = deniedExchangeEvent({
      reason: 'invalidSignature',
      sourceIp: '192.0.2.10',
    });

    assert.equal(named.data['refusedSubject'], 'subject "ana" \\');
    assert.equal(named.data['userId'], null);
    assert.equal(Object.hasOwn(unnamed.data, 'refusedSubject'), false);
  });

  test('records a signing key not confirmed yet at warning as denied, under its code, naming no userId', () => {
    const event = deniedExchangeEvent({
      reason: 'signingKeyUnconfirmed',
      sourceIp: '2001:db8::10',
    });

    assert.deepEqual(event, {
      data: {
        reason: 'signingKeyUnconfirmed',
        result: 'denied',
        sourceIp: '2001:db8::10',
        userId: null,
      },
      severity: 'warning',
      type: 'token.exchange',
    });
  });

  test('records an exchange an unreachable identity provider kept from being judged at error as failed, under the code answered', () => {
    const event = failedExchangeEvent({
      reason: 'identityProviderUnavailable',
      sourceIp: '2001:db8::10',
    });

    assert.deepEqual(event, {
      data: {
        reason: 'identityProviderUnavailable',
        result: 'failed',
        sourceIp: '2001:db8::10',
        userId: null,
      },
      severity: 'error',
      type: 'token.exchange',
    });
  });
});
