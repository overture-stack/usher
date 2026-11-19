import pg from 'pg';

import { SETTING_DEFINITIONS } from './settingDefinitions.js';
import type { SignInTokenMaximumHistory } from './signInTokenMaximum.js';
import type { SettingsProblem } from './types.js';

const SETTING = 'signInTokenMaximumLifetimeSeconds';

const MISSING_RULE = 'is missing from the store';

/** One recorded change of the sign-in token maximum: when it was recorded, and the value it set. */
export interface SignInTokenMaximumRow {
	/** The instant the change was recorded, in seconds since the Unix epoch. */
	recordedAt: number;

	/** The value the change set, as the store holds it. */
	value: unknown;
}

/** What reading the history of the sign-in token maximum gave: every change, or each rule a change breaks. */
export type SignInTokenMaximumHistoryReading =
	{ history: SignInTokenMaximumHistory; kind: 'read' } | { kind: 'refused'; problems: readonly SettingsProblem[] };

/**
 * The statement reading every recorded change of the sign-in token maximum, oldest first, each with the
 * instant it was recorded in seconds since the Unix epoch and the value it set. The change records are
 * read as they stand; the index on their table and key serves the read.
 *
 * @param schema the database schema holding the change records.
 */
export const signInTokenMaximumHistoryStatement = (schema: string): string =>
	`SELECT EXTRACT(EPOCH FROM recorded_at)::double precision AS "recordedAt", new_row -> 'value' AS value FROM ${pg.escapeIdentifier(schema)}.change_records WHERE table_name = 'settings' AND row_key = '{"name": "${SETTING}"}'::jsonb AND operation <> 'DELETE' ORDER BY recorded_at`;

/**
 * Reads the history of the sign-in token maximum from its recorded changes, each value read by the
 * setting's definition. A history holding no change is a problem, as a missing row is, and so is a
 * recorded value that breaks its rule. No problem quotes a value.
 *
 * @param rows the recorded changes, oldest first.
 */
export const readSignInTokenMaximumHistory = (
	rows: readonly SignInTokenMaximumRow[],
): SignInTokenMaximumHistoryReading => {
	const readings = rows.map(({ recordedAt, value }) => ({
		reading: SETTING_DEFINITIONS[SETTING].read(value),
		recordedAt,
	}));
	const problems = readings.flatMap<SettingsProblem>(({ reading }) =>
		reading.kind === 'refused' ? [{ rule: reading.rule, setting: SETTING }] : [],
	);
	if (problems.length > 0) {
		return { kind: 'refused', problems };
	}
	const [first, ...rest] = readings.flatMap(({ reading, recordedAt }) =>
		reading.kind === 'read' ? [{ recordedAt, seconds: reading.value }] : [],
	);
	return first === undefined
		? { kind: 'refused', problems: [{ rule: MISSING_RULE, setting: SETTING }] }
		: { history: [first, ...rest], kind: 'read' };
};
