import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { CAPABILITY_VOCABULARY } from './capabilityVocabulary.js';

const entitiesIn = (plane: string): readonly string[] => [
	...new Set(CAPABILITY_VOCABULARY.filter((capability) => capability.plane === plane).map(({ entity }) => entity)),
];

const actionsOf = (entity: string): readonly string[] =>
	CAPABILITY_VOCABULARY.filter((capability) => capability.entity === entity)
		.map(({ action }) => action)
		.toSorted();

suite('the capability vocabulary', () => {
	test('names each capability once, as its entity and action joined by a dot, neither part empty or holding a dot', () => {
		const names = CAPABILITY_VOCABULARY.map(({ name }) => name);

		assert.equal(new Set(names).size, names.length);
		CAPABILITY_VOCABULARY.forEach(({ action, entity, name }) => {
			assert.equal(name, `${entity}.${action}`);
			assert.match(entity, /^[^.]+$/u);
			assert.match(action, /^[^.]+$/u);
		});
	});

	test('puts the four entities a token carries in the data plane and every entity of the store in the control plane, none in both', () => {
		const data = entitiesIn('data');
		const control = entitiesIn('control');

		assert.deepEqual(data.toSorted(), ['artifact', 'field', 'record', 'revision']);
		assert.deepEqual(control.toSorted(), [
			'category',
			'custodianship',
			'grant',
			'group',
			'invitation',
			'ownership',
			'resource',
			'role',
		]);
	});

	test('gives each data-plane entity the actions a token may carry on it', () => {
		assert.deepEqual(actionsOf('record'), ['count', 'create', 'delete', 'export', 'update', 'view']);
		assert.deepEqual(actionsOf('artifact'), actionsOf('record'));
		assert.deepEqual(actionsOf('field'), ['count', 'export', 'update', 'view']);
		assert.deepEqual(actionsOf('revision'), ['export', 'view']);
	});

	test('gives each control-plane entity its actions', () => {
		assert.deepEqual(Object.fromEntries(entitiesIn('control').map((entity) => [entity, actionsOf(entity)])), {
			category: ['create'],
			custodianship: ['assign', 'remove'],
			grant: ['create', 'extend', 'reduce', 'revoke', 'view'],
			group: ['addMember', 'create', 'removeMember', 'update', 'view'],
			invitation: ['create'],
			ownership: ['transfer'],
			resource: ['register', 'restore', 'suppress', 'update', 'view'],
			role: ['define'],
		});
	});
});
