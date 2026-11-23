import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suite, test } from 'node:test';

import {
	type Enforcement,
	type PermissionsPayload,
	validatePayload,
	validateRegistration,
} from '@overture-stack/usher-types';

// Read from usher-types' source by path: the evaluator is test-only, so no package exports it.
import { type EvaluatedRecord, matchesSqon } from '../../../types/src/sqonEvaluator.js';

import { CONFIGURATION_DEFAULTS } from './configuration.js';
import { compileKey, renderArtifactCreate } from './rendering.js';

/** One record of an artifact-creation case. */
interface ExpectedRecord {
	fields: EvaluatedRecord;
	outcome: string;
	reason: string;
}

/** One case of `artifact-create-expectations.json`, its payload carried inline. */
interface ArtifactCreateCase {
	id: string;
	keyRegistration: unknown;
	payload: unknown;
	records: readonly ExpectedRecord[];
}

const expectations = JSON.parse(
	readFileSync(
		new URL('../../../../.dev/design/conformance/artifact-create-expectations.json', import.meta.url),
		'utf8',
	),
) as {
	cases: readonly ArtifactCreateCase[];
	formatVersion: unknown;
};

type Outcome = 'denied' | 'served' | 'withheld';

const OUTCOMES: ReadonlySet<string> = new Set<Outcome>(['denied', 'served', 'withheld']);

/** The payload of a case, validated. A refused payload fails its case rather than skipping it. */
const payloadOf = ({ id, payload }: ArtifactCreateCase): PermissionsPayload => {
	const validated = validatePayload(payload);

	if (validated.success) {
		return validated.payload;
	}

	return assert.fail(`${id}'s payload is refused: ${JSON.stringify(validated.problems)}`);
};

/** The artifact-creation result of a case's key, rendered from its payload. */
const enforcementOf = (expectationCase: ArtifactCreateCase): Enforcement => {
	const validated = validateRegistration(expectationCase.keyRegistration);

	if (validated.success) {
		return renderArtifactCreate(
			payloadOf(expectationCase),
			compileKey(validated.registration),
			CONFIGURATION_DEFAULTS.filterClauseLimit,
		).enforcement;
	}

	return assert.fail(`${expectationCase.id}'s key registration is refused: ${JSON.stringify(validated.problems)}`);
};

/**
 * A deny refuses the whole catalogue, so it is `denied` and never `withheld`: a refusal and a
 * narrowing that leaves the record out are different answers.
 */
const outcomeOf = (enforcement: Enforcement, record: EvaluatedRecord): Outcome => {
	switch (enforcement.kind) {
		case 'allow':
			return 'served';
		case 'deny':
			return 'denied';
		case 'narrow':
			return matchesSqon(enforcement.sqon, record) ? 'served' : 'withheld';
	}
};

suite('the artifact-creation conformance expectations', () => {
	test('are written in the format this suite reads, holding at least one case and a record in each', () => {
		assert.equal(expectations.formatVersion, 1);
		assert.ok(expectations.cases.length > 0);
		assert.ok(expectations.cases.every(({ records }) => records.length > 0));
	});

	for (const expectationCase of expectations.cases) {
		suite(expectationCase.id, () => {
			for (const [index, record] of expectationCase.records.entries()) {
				test(`record ${index + 1} is ${record.outcome}: ${record.reason}`, () => {
					assert.ok(OUTCOMES.has(record.outcome), 'the outcome is served, withheld or denied');
					assert.equal(outcomeOf(enforcementOf(expectationCase), record.fields), record.outcome);
				});
			}
		});
	}
});
