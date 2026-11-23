import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type { OperationOutcome } from '../managementApi/index.js';
import { type DirectoryAlternative, unnamedByDirectory, unresolvedByDirectory } from './directoryOutcome.js';

const ALTERNATIVES: readonly DirectoryAlternative[] = [
	'grantById',
	'grantsByResource',
	'holderBySubject',
	'ownerBySubject',
];

const read = (outcome: OperationOutcome): readonly [string, number, string, string, string] =>
	outcome.kind === 'refused'
		? [outcome.kind, outcome.problem.status, outcome.problem.code, outcome.problem.detail, 'error']
		: outcome.kind === 'unavailable'
			? [
					outcome.kind,
					outcome.problem.status,
					outcome.problem.code,
					outcome.problem.detail,
					outcome.severity ?? 'error',
				]
			: ['answered', 0, '', '', ''];

suite('answering an operation the directory resolved nothing for', () => {
	test("answers 503 directoryNotConfigured with no directory configured, at warning, naming the rule and the operation's own alternative", () => {
		assert.deepEqual(
			ALTERNATIVES.map((alternative) => read(unresolvedByDirectory({ kind: 'unconfigured' }, alternative))),
			[
				[
					'unavailable',
					503,
					'directoryNotConfigured',
					"Addresses cannot be resolved without a configured directory, which the variables USHER_DIRECTORY_URL, USHER_DIRECTORY_REALM, USHER_DIRECTORY_CLIENT_ID, USHER_DIRECTORY_CLIENT_SECRET configure; revoke the submitter's grant by its id, through DELETE /admin/grants/{grantId}.",
					'warning',
				],
				[
					'unavailable',
					503,
					'directoryNotConfigured',
					"Addresses cannot be resolved without a configured directory, which the variables USHER_DIRECTORY_URL, USHER_DIRECTORY_REALM, USHER_DIRECTORY_CLIENT_ID, USHER_DIRECTORY_CLIENT_SECRET configure; list a resource's grants, whose holders are named by subject, through GET /admin/resources/{externalId}/grants.",
					'warning',
				],
				[
					'unavailable',
					503,
					'directoryNotConfigured',
					'Addresses cannot be resolved without a configured directory, which the variables USHER_DIRECTORY_URL, USHER_DIRECTORY_REALM, USHER_DIRECTORY_CLIENT_ID, USHER_DIRECTORY_CLIENT_SECRET configure; name the holder by subject.',
					'warning',
				],
				[
					'unavailable',
					503,
					'directoryNotConfigured',
					'Addresses cannot be resolved without a configured directory, which the variables USHER_DIRECTORY_URL, USHER_DIRECTORY_REALM, USHER_DIRECTORY_CLIENT_ID, USHER_DIRECTORY_CLIENT_SECRET configure; name the owner by subject.',
					'warning',
				],
			],
		);
	});

	test("answers 503 directoryUnavailable as unavailable while the directory cannot answer, naming the operation's own alternative beside trying again where that alternative needs no directory", () => {
		assert.deepEqual(
			ALTERNATIVES.map((alternative) => read(unresolvedByDirectory({ kind: 'unavailable' }, alternative))),
			[
				[
					'unavailable',
					503,
					'directoryUnavailable',
					"A submitter named by address is found through the identity provider's directory, which cannot answer now. Revoke the submitter's grant by its id, through DELETE /admin/grants/{grantId}, or try again later.",
					'error',
				],
				[
					'unavailable',
					503,
					'directoryUnavailable',
					"A person named by address is found through the identity provider's directory, which cannot answer now. Try again later.",
					'error',
				],
				[
					'unavailable',
					503,
					'directoryUnavailable',
					"A holder named by address is found through the identity provider's directory, which cannot answer now. Name the holder by subject, or try again later.",
					'error',
				],
				[
					'unavailable',
					503,
					'directoryUnavailable',
					"An owner named by address is found through the identity provider's directory, which cannot answer now. Name the owner by subject, or try again later.",
					'error',
				],
			],
		);
	});

	test('answers a listing that cannot read the people it names 503 directoryUnavailable as unavailable, telling the caller to try again', () => {
		assert.deepEqual(read(unnamedByDirectory()), [
			'unavailable',
			503,
			'directoryUnavailable',
			"This listing shows people as the identity provider's directory holds them, and the directory cannot answer now. Try again later.",
			'error',
		]);
	});
});
