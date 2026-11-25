import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { CAPABILITY_VOCABULARY } from './capabilityVocabulary.js';
import { SEEDED_ROLES } from './seededRoles.js';

const READ = ['record.count', 'record.export', 'record.view'];

// Whoever may read a category's records may make sets from them by default.
const SETS = ['artifact.create'];

const OWNER = [
	'grant.create',
	'grant.extend',
	'grant.reduce',
	'grant.revoke',
	'grant.view',
	'invitation.create',
	'ownership.transfer',
	'resource.restore',
	'resource.suppress',
	'resource.update',
	'resource.view',
];

const planeOf = (name: string): string | undefined =>
	CAPABILITY_VOCABULARY.find((capability) => capability.name === name)?.plane;

suite('the seeded roles', () => {
	test('climb the data plane: viewer reads and makes sets, editor also creates and updates, curator also deletes', () => {
		assert.deepEqual(SEEDED_ROLES.viewer, {
			capabilities: [...SETS, ...READ].toSorted(),
			plane: 'data',
		});
		assert.deepEqual(SEEDED_ROLES.editor, {
			capabilities: [...SETS, ...READ, 'record.create', 'record.update'].toSorted(),
			plane: 'data',
		});
		assert.deepEqual(SEEDED_ROLES.curator, {
			capabilities: [...SETS, ...READ, 'record.create', 'record.delete', 'record.update'].toSorted(),
			plane: 'data',
		});
	});

	test('let a submitter create and update records, and read none or make sets from them', () => {
		assert.deepEqual(SEEDED_ROLES.submitter, {
			capabilities: ['record.create', 'record.update'],
			plane: 'data',
		});
	});

	test("let an owner administer access to a resource, and an administrator do all of an owner's and the platform-wide acts beside them", () => {
		assert.deepEqual(SEEDED_ROLES.owner, {
			capabilities: OWNER,
			plane: 'control',
		});
		assert.deepEqual(SEEDED_ROLES.admin, {
			capabilities: [
				...OWNER,
				'category.create',
				'group.addMember',
				'group.create',
				'group.removeMember',
				'group.update',
				'group.view',
				'resource.register',
				'role.define',
			].toSorted(),
			plane: 'control',
		});
	});

	test('carry capabilities of the vocabulary and of their own plane alone, a custodianship capability in none', () => {
		Object.values(SEEDED_ROLES).forEach(({ capabilities, plane }) => {
			capabilities.forEach((name) => {
				assert.equal(planeOf(name), plane, name);
				assert.equal(name.startsWith('custodianship.'), false, name);
			});
		});
	});

	test('list each role once and its capabilities sorted, each once', () => {
		assert.deepEqual(Object.keys(SEEDED_ROLES).toSorted(), [
			'admin',
			'curator',
			'editor',
			'owner',
			'submitter',
			'viewer',
		]);
		Object.values(SEEDED_ROLES).forEach(({ capabilities }) => {
			assert.deepEqual(capabilities, [...new Set(capabilities)].toSorted());
		});
	});
});
