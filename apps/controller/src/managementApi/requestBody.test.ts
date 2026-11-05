import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { PROBLEMS } from './problems.js';
import { readJsonBody, readTextMembers } from './requestBody.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const codeOf = (reading: {
  kind: string;
  problem?: { code: string };
}): string => reading.problem?.code ?? reading.kind;

suite("reading a request's body", () => {
  test('reads an empty body, or none, as no body, whatever its media type', () => {
    assert.deepEqual(readJsonBody(undefined, undefined), { kind: 'absent' });
    assert.deepEqual(readJsonBody(bytes(''), 'text/plain'), { kind: 'absent' });
  });

  test('reads one JSON object sent as application/json, with or without a UTF-8 charset', () => {
    const types = [
      'application/json',
      'Application/JSON; charset=utf-8',
      'application/json;charset="UTF-8"',
    ];

    types.forEach((contentType) =>
      assert.deepEqual(readJsonBody(bytes('{"a":"é"}'), contentType), {
        kind: 'object',
        value: { a: 'é' },
      }),
    );
  });

  test('refuses a body in another media type, in none, or in another charset with 415', () => {
    [undefined, 'text/plain', 'application/json; charset=latin1'].forEach(
      (contentType) =>
        assert.deepEqual(
          readJsonBody(bytes('{}'), contentType),
          { kind: 'refused', problem: PROBLEMS.unsupportedMediaType },
          String(contentType),
        ),
    );
  });

  test('refuses as unreadable a body that is not UTF-8, not JSON, or not one object', () => {
    const bodies = [
      Uint8Array.of(0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d),
      bytes('{"a":'),
      bytes('[]'),
      bytes('"text"'),
      bytes('null'),
    ];

    bodies.forEach((body) =>
      assert.equal(
        codeOf(readJsonBody(body, 'application/json')),
        'unreadableBody',
      ),
    );
  });
});

suite("reading a body's text members", () => {
  const MEMBERS = {
    description: { required: false },
    displayName: { required: true },
  };

  test('reads each member sent', () => {
    assert.deepEqual(
      readTextMembers({ description: 'd', displayName: 'n' }, MEMBERS),
      { kind: 'read', members: { description: 'd', displayName: 'n' } },
    );
    assert.deepEqual(readTextMembers({ displayName: 'n' }, MEMBERS), {
      kind: 'read',
      members: { displayName: 'n' },
    });
  });

  test('refuses a member not taken, naming those taken and never the one sent', () => {
    const reading = readTextMembers(
      { displayName: 'n', sentByCaller: 'x' },
      MEMBERS,
    );

    assert.equal(reading.kind, 'refused');
    const detail = reading.kind === 'refused' ? reading.problem.detail : '';
    assert.match(detail, /description and displayName/u);
    assert.equal(detail.includes('sentByCaller'), false);
  });

  test('refuses a required member missing, and a member of another type', () => {
    const readings = [
      readTextMembers({ description: 'd' }, MEMBERS),
      readTextMembers({ displayName: 7 }, MEMBERS),
      readTextMembers({ displayName: null }, MEMBERS),
      readTextMembers({ description: 7, displayName: 'n' }, MEMBERS),
    ];

    readings.forEach((reading) =>
      assert.equal(codeOf(reading), 'unreadableBody'),
    );
  });
});
