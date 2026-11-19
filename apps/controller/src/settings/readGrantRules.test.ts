import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { DEFAULT_GRANT_RULES, readGrantRules } from './readGrantRules.js';

const category = (name: string, actions: unknown): unknown => ({ actions, name });
const resource = (accessLevel: string, categories: unknown): unknown => ({ accessLevel, categories });
const entry = (to: string, resources: unknown): unknown => ({ resources, to });
const UNMARKED_READ = category('global.unmarked', ['count', 'view', 'export']);

const refusedRuleOf = (value: unknown): string => {
	const reading = readGrantRules(value);
	assert.equal(reading.kind, 'refused', 'the value is refused');
	return reading.kind === 'refused' ? reading.rule : '';
};

suite('reading grant rules', () => {
	test('defaults to everyone reading open resources, and signed-in readers reading open and registered ones', () => {
		assert.deepEqual(DEFAULT_GRANT_RULES, [
			entry('everyone', [resource('open', [UNMARKED_READ])]),
			entry('signedIn', [resource('open', [UNMARKED_READ]), resource('registered', [UNMARKED_READ])]),
		]);
	});

	test('reads the default rules as they are given', () => {
		assert.deepEqual(readGrantRules(DEFAULT_GRANT_RULES), { kind: 'read', value: DEFAULT_GRANT_RULES });
	});

	test('reads an empty list of entries, which grants nothing to anyone', () => {
		assert.deepEqual(readGrantRules([]), { kind: 'read', value: [] });
	});

	test('reads empty resources and empty actions, which confer nothing', () => {
		const rules = [entry('signedIn', []), entry('everyone', [resource('open', [category('global.unmarked', [])])])];

		assert.deepEqual(readGrantRules(rules), { kind: 'read', value: rules });
	});

	test('reads members in any order, since the order of keys is not judged', () => {
		const reordered = [{ resources: [{ categories: [UNMARKED_READ], accessLevel: 'open' }], to: 'everyone' }];

		assert.deepEqual(readGrantRules(reordered), { kind: 'read', value: reordered });
	});

	test('refuses a value that is not a list of entries', () => {
		[{}, 'everyone', null, 7].forEach((value) => assert.match(refusedRuleOf(value), /list of entries/u));
	});

	test('refuses an entry that is not an object', () => {
		assert.match(refusedRuleOf(['everyone']), /entry/u);
	});

	test('refuses an entry holding a member the rules do not take', () => {
		assert.match(refusedRuleOf([{ ...(entry('everyone', []) as object), extra: true }]), /other than/u);
	});

	test('refuses an entry lacking to or resources', () => {
		assert.match(refusedRuleOf([{ resources: [] }]), /to/u);
		assert.match(refusedRuleOf([{ to: 'everyone' }]), /resources/u);
	});

	test('refuses a recipient other than everyone or signedIn', () => {
		['grant', 'open', 'Everyone'].forEach((to) => assert.match(refusedRuleOf([entry(to, [])]), /to/u));
	});

	test('refuses a second entry for a recipient already given an entry', () => {
		assert.match(refusedRuleOf([entry('everyone', []), entry('everyone', [])]), /twice/u);
	});

	test('refuses a resource whose accessLevel is not open or registered', () => {
		['grant', 'private'].forEach((accessLevel) =>
			assert.match(refusedRuleOf([entry('everyone', [resource(accessLevel, [])])]), /accessLevel/u),
		);
	});

	test('refuses a second resource for an access level already given one', () => {
		assert.match(refusedRuleOf([entry('everyone', [resource('open', []), resource('open', [])])]), /accessLevel/u);
	});

	test('refuses a category other than global.unmarked, which is the only one accepted for now', () => {
		assert.match(
			refusedRuleOf([entry('everyone', [resource('open', [category('global.controlled', ['count'])])])]),
			/global\.unmarked/u,
		);
	});

	test('refuses a second category of the same name on one resource', () => {
		assert.match(
			refusedRuleOf([
				entry('everyone', [resource('open', [UNMARKED_READ, category('global.unmarked', ['count'])])]),
			]),
			/twice/u,
		);
	});

	test('refuses an action outside count, view and export', () => {
		['create', 'update', 'delete', 'read'].forEach((action) =>
			assert.match(
				refusedRuleOf([entry('everyone', [resource('open', [category('global.unmarked', [action])])])]),
				/actions/u,
			),
		);
	});

	test('refuses an action named twice in one category', () => {
		assert.match(
			refusedRuleOf([entry('everyone', [resource('open', [category('global.unmarked', ['view', 'view'])])])]),
			/twice/u,
		);
	});

	test('refuses a plural member holding a single value rather than a list', () => {
		assert.match(refusedRuleOf([entry('everyone', resource('open', []))]), /resources/u);
		assert.match(refusedRuleOf([entry('everyone', [resource('open', UNMARKED_READ)])]), /categories/u);
		assert.match(
			refusedRuleOf([entry('everyone', [resource('open', [category('global.unmarked', 'view')])])]),
			/actions/u,
		);
	});

	test('refuses a category holding a member the rules do not take', () => {
		assert.match(
			refusedRuleOf([entry('everyone', [resource('open', [{ ...(UNMARKED_READ as object), extra: 1 }])])]),
			/other than/u,
		);
	});

	test('names the member at fault and never the value submitted', () => {
		const rule = refusedRuleOf([entry('sekret-recipient-value', [])]);

		assert.equal(rule.includes('sekret-recipient-value'), false);
		assert.match(rule, /to/u);
	});
});
