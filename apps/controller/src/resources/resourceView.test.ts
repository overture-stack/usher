import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { resourceView } from './resourceView.js';
import type { StoredResource } from './types.js';

const STORED: StoredResource = Object.freeze({
  accessLevel: 'grant',
  applications: ['0b8f7f43-2b4c-4b55-9a39-6c1b7f6f0a11'],
  categories: ['resource.local-panel'],
  description: null,
  displayName: 'Wastewater surveillance, Montréal',
  externalId: 'STUDY-A1',
  fields: { organization: 'Lakeshore Example Institute' },
  registeredAt: new Date(Date.UTC(2026, 10, 4, 12, 0, 0, 250)),
  registeredBy: 'subject-administrator',
  retired: false,
  suppressed: true,
  updatedAt: new Date(Date.UTC(2026, 10, 5, 9, 30, 0)),
});

suite('a resource as an answer shows it', () => {
  test('shows a platform administrator every member, an empty grant summary among them, each instant in UTC with Z and the registrant by subject', () => {
    assert.deepEqual(resourceView(STORED, 'administrator'), {
      accessLevel: 'grant',
      applications: ['0b8f7f43-2b4c-4b55-9a39-6c1b7f6f0a11'],
      categories: ['resource.local-panel'],
      description: null,
      displayName: 'Wastewater surveillance, Montréal',
      externalId: 'STUDY-A1',
      fields: { organization: 'Lakeshore Example Institute' },
      grantSummary: {},
      registeredAt: '2026-11-04T12:00:00.250Z',
      registeredBy: { subject: 'subject-administrator' },
      retired: false,
      suppressed: true,
      updatedAt: '2026-11-05T09:30:00.000Z',
    });
  });

  test("shows a counted owner the administrator's answer, the empty grant summary included", () => {
    assert.deepEqual(
      resourceView(STORED, 'owner'),
      resourceView(STORED, 'administrator'),
    );
  });

  test('shows anyone else, a holder of a grant on it among them, no grant summary at all', () => {
    const view = resourceView(STORED, 'signedIn');

    assert.equal(
      typeof view === 'object' && view !== null && 'grantSummary' in view,
      false,
    );
  });
});
