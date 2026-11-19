import pg from 'pg';

import { failureCodeOf } from '../failures/index.js';
import type { EventLog } from '../eventLog/index.js';
import { SETTING_DEFINITIONS } from './settingDefinitions.js';
import { type HeldSettings, type StoredSetting, readHeldSettings } from './readStoredSettings.js';
import {
	type SignInTokenMaximumRow,
	readSignInTokenMaximumHistory,
	signInTokenMaximumHistoryStatement,
} from './readSignInTokenMaximumHistory.js';
import type { SignInTokenMaximumHistory } from './signInTokenMaximum.js';
import type { SettingName } from './types.js';

/** The line naming a stored row that breaks its rule on a reread, the held value kept. */
export const SETTING_STORED_INVALID = 'settings.storedInvalid';

/** The line naming a reread of the settings that failed, the held values kept. */
export const SETTING_READ_FAILED = 'settings.readFailed';

/** The source the start hands the settings it read to, and that the instance rereads while it runs. */
export interface SettingsSource {
	/** The settings held, every setting but the grant rules, as the last valid reading gave them. */
	current(): HeldSettings;

	/** The history of the sign-in token maximum held, every recorded change oldest first, as the last valid reading gave it. */
	maximumHistory(): SignInTokenMaximumHistory;

	/** Holds the settings and the sign-in token maximum's history a start read, with the generation they were read at. */
	hold(settings: HeldSettings, generation: string, maximums: SignInTokenMaximumHistory): void;

	/** Rereads the settings now, once any reread in flight has ended, so a change this instance made holds at once. */
	reread(): Promise<void>;

	/** Starts the reread timer, which runs until the source stops. */
	start(): void;

	/** Stops the reread timer, and settles once a reread in flight has ended. */
	stop(): Promise<void>;
}

/** The statement reading the settings generation, one row. */
const generationStatement = (schema: string): string =>
	`SELECT generation::text AS generation FROM ${pg.escapeIdentifier(schema)}.settings_generation`;

/** The statement reading every setting but the grant rules, one row each. */
const heldStatement = (schema: string): string =>
	`SELECT name, value FROM ${pg.escapeIdentifier(schema)}.settings WHERE name <> 'grantRules'`;

const codeOf = (failure: unknown): Readonly<Record<string, string>> => {
	const code = failureCodeOf(failure);
	return code === undefined ? {} : { code };
};

// A setting name the store holds, as the store names it.
const isSettingName = (name: string): name is SettingName => Object.hasOwn(SETTING_DEFINITIONS, name);

/**
 * Creates the Controller's live settings: held values read once at the start, and reread on a timer that
 * runs from start to stop, whatever notice streams are open. On each tick the settings generation is read;
 * when it differs from the one held, every setting but the grant rules is read and validated. A row that
 * breaks its rule keeps every held value, is written at error as `settings.storedInvalid` naming the setting
 * and the rule, and the new generation is taken, so the line is written once per generation; the next change
 * raises the generation and is read.
 * A failed read is written at error as `settings.readFailed` with its code, and holds nothing. The timer
 * re-arms at each tick when `noticeRereadMilliseconds` differs from the interval it runs at.
 *
 * @param options the log the lines are written to, the reader of the control pool, and the schema.
 */
export const createSettingsSource = (options: {
	log: Pick<EventLog, 'error'>;
	reader: { query: <Row extends object>(text: string) => Promise<{ rows: readonly Row[] }> };
	schema: string;
}): SettingsSource => {
	const { log, reader, schema } = options;
	const state: {
		armedMilliseconds: number | undefined;
		held: { generation: string; maximums: SignInTokenMaximumHistory; settings: HeldSettings } | undefined;
		reading: Promise<void> | undefined;
		stopped: boolean;
		timer: ReturnType<typeof setInterval> | undefined;
	} = {
		armedMilliseconds: undefined,
		held: undefined,
		reading: undefined,
		stopped: false,
		timer: undefined,
	};

	const arm = (milliseconds: number): void => {
		clearInterval(state.timer);
		state.armedMilliseconds = milliseconds;
		state.timer = setInterval(tick, milliseconds);
		state.timer.unref();
	};

	const heldNow = (): { generation: string; maximums: SignInTokenMaximumHistory; settings: HeldSettings } => {
		if (state.held === undefined) {
			throw new Error('the settings are read before any of them is used');
		}
		return state.held;
	};

	const reread = async (): Promise<void> => {
		const [generationRow] = (await reader.query<{ generation: string }>(generationStatement(schema))).rows;
		if (generationRow === undefined || generationRow.generation === heldNow().generation) {
			return;
		}
		const rows = (await reader.query<StoredSetting>(heldStatement(schema))).rows;
		const historyRows = (await reader.query<SignInTokenMaximumRow>(signInTokenMaximumHistoryStatement(schema)))
			.rows;
		const settingsReading = readHeldSettings(rows.filter((row) => isSettingName(row.name)));
		const historyReading = readSignInTokenMaximumHistory(historyRows);
		if (settingsReading.kind === 'refused' || historyReading.kind === 'refused') {
			[
				...(settingsReading.kind === 'refused' ? settingsReading.problems : []),
				...(historyReading.kind === 'refused' ? historyReading.problems : []),
			].forEach(({ rule, setting }) => {
				log.error(SETTING_STORED_INVALID, { rule, setting });
			});
			state.held = { ...heldNow(), generation: generationRow.generation };
			return;
		}
		state.held = {
			generation: generationRow.generation,
			maximums: historyReading.history,
			settings: settingsReading.settings,
		};
	};

	const runReread = (): Promise<void> => {
		const reading = reread()
			.catch((failure: unknown) => {
				log.error(SETTING_READ_FAILED, codeOf(failure));
			})
			.finally(() => {
				if (state.reading === reading) {
					state.reading = undefined;
				}
				if (
					!state.stopped &&
					state.held !== undefined &&
					state.held.settings.noticeRereadMilliseconds !== state.armedMilliseconds
				) {
					arm(state.held.settings.noticeRereadMilliseconds);
				}
			});
		state.reading = reading;
		return reading;
	};

	const tick = (): void => {
		if (!state.stopped && state.reading === undefined) {
			void runReread();
		}
	};

	return {
		current: (): HeldSettings => heldNow().settings,

		hold: (settings: HeldSettings, generation: string, maximums: SignInTokenMaximumHistory): void => {
			state.held = { generation, maximums, settings };
		},

		maximumHistory: (): SignInTokenMaximumHistory => heldNow().maximums,

		reread: async (): Promise<void> => {
			await state.reading;
			await runReread();
		},

		start: (): void => {
			arm(heldNow().settings.noticeRereadMilliseconds);
		},

		stop: async (): Promise<void> => {
			state.stopped = true;
			clearInterval(state.timer);
			state.timer = undefined;
			await state.reading;
		},
	};
};
