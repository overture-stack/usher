import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type { OperationOutcome } from '../managementApi/index.js';
import { type DirectoryAlternative, unresolvedByDirectory } from './directoryOutcome.js';

const ALTERNATIVES: readonly DirectoryAlternative[] = ['grantById', 'holderBySubject', 'ownerBySubject'];

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
					"Addresses cannot be resolved without a configured directory, which the variables USHER_DIRECTORY_URL, USHER_DIRECTORY_REALM, USHER_DIRECTORY_CLIENT_ID, USHER_DIRECTORY_CLIENT_SECRET configure; revoke the submitter's grant by its id, through DELETE /admin/grants/{id}.",
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

	test("answers 503 directoryUnavailable as unavailable while the directory cannot answer, naming the operation's own alternative beside trying again", () => {
		assert.deepEqual(
			ALTERNATIVES.map((alternative) => read(unresolvedByDirectory({ kind: 'unavailable' }, alternative))),
			[
				[
					'unavailable',
					503,
					'directoryUnavailable',
					"A submitter named by address is found through the identity provider's directory, which cannot answer now. Revoke the submitter's grant by its id, through DELETE /admin/grants/{id}, or try again later.",
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
});
