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
	grantSummary: { owner: 1, viewer: 2 },
	registeredAt: new Date(Date.UTC(2026, 10, 4, 12, 0, 0, 250)),
	registeredBy: 'subject-administrator',
	retired: false,
	suppressed: true,
	updatedAt: new Date(Date.UTC(2026, 10, 5, 9, 30, 0)),
});

suite('a resource as an answer shows it', () => {
	test('shows a platform administrator every member, the grant summary among them, each instant in UTC with Z and the registrant by subject', () => {
		assert.deepEqual(resourceView(STORED, 'administrator'), {
			accessLevel: 'grant',
			applications: ['0b8f7f43-2b4c-4b55-9a39-6c1b7f6f0a11'],
			categories: ['resource.local-panel'],
			description: null,
			displayName: 'Wastewater surveillance, Montréal',
			externalId: 'STUDY-A1',
			fields: { organization: 'Lakeshore Example Institute' },
			grantSummary: { owner: 1, viewer: 2 },
			registeredAt: '2026-11-04T12:00:00.250Z',
			registeredBy: { subject: 'subject-administrator' },
			retired: false,
			suppressed: true,
			updatedAt: '2026-11-05T09:30:00.000Z',
		});
	});

	test("shows a counted owner the administrator's answer, the grant summary included", () => {
		assert.deepEqual(resourceView(STORED, 'owner'), resourceView(STORED, 'administrator'));
	});

	test('shows anyone else, a holder of a grant on it among them, no grant summary and no registrant at all', () => {
		assert.deepEqual(resourceView(STORED, 'signedIn'), {
			accessLevel: 'grant',
			applications: ['0b8f7f43-2b4c-4b55-9a39-6c1b7f6f0a11'],
			categories: ['resource.local-panel'],
			description: null,
			displayName: 'Wastewater surveillance, Montréal',
			externalId: 'STUDY-A1',
			fields: { organization: 'Lakeshore Example Institute' },
			registeredAt: '2026-11-04T12:00:00.250Z',
			retired: false,
			suppressed: true,
			updatedAt: '2026-11-05T09:30:00.000Z',
		});
	});

	test('shows a platform administrator and a counted owner a null registrant for a resource whose registering administrator is not recorded, and anyone else none', () => {
		const unrecorded: StoredResource = { ...STORED, registeredBy: null };

		const views = (['administrator', 'owner', 'signedIn'] as const).map((reader) =>
			resourceView(unrecorded, reader),
		);

		assert.deepEqual(
			views.map((view) =>
				typeof view === 'object' && view !== null
					? Object.entries(view)
							.filter(([name]) => name === 'registeredBy')
							.map(([, value]) => value)
					: [],
			),
			[[null], [null], []],
		);
	});

	test("shows a listing entry's grants, as given, beside its grant summary", () => {
		const grants = [{ id: '6b1f3c2e-8a4d-4f7b-9c1e-2d3a4b5c6d7e', kind: 'grant' }];

		const view = resourceView(STORED, 'administrator', grants);

		const member = (name: string): unknown =>
			typeof view === 'object' && view !== null ? Reflect.get(view, name) : undefined;
		assert.deepEqual([member('grants'), member('grantSummary')], [grants, { owner: 1, viewer: 2 }]);
	});
});
