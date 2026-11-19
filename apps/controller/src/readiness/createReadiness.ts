import type { Readiness } from '../http/index.js';
import { MIGRATION_UNKNOWN, migrationUnknownFields, type UnknownMigration } from '../migrations/index.js';
import type { ReadinessSettings, StoreProbe } from './types.js';

/**
 * How long one answer of the store's is reused, in milliseconds, counted from the moment the probe
 * giving it began. Readiness is asked without a credential, so however often it is asked, the store
 * is probed at most once in this interval; and it is short beside how often an orchestrator asks,
 * every few seconds at the least, so each of its asks still gets a fresh answer.
 */
export const STORE_PROBE_INTERVAL_MILLISECONDS = 1000;

/** The line written, at warning, when the Controller becomes unready, naming the `cause`. */
export const READINESS_LOST = 'readiness.lost';

/** The line written, at info, when the Controller is ready again. */
export const READINESS_RESTORED = 'readiness.restored';

// The cause naming a probe's failure that carries no code of its own.
const STORE_FAILED = 'storeFailed';

const MIGRATION_UNKNOWN_CAUSE = 'migrationUnknown';

// The cause naming a stored grant rule that breaks its rule, which the exchange answers as it answers no token.
const STORED_SETTINGS_INVALID_CAUSE = 'storedSettingsInvalid';

type ProbeOutcome = { answer: StoreProbe; kind: 'answered' } | { cause: string; kind: 'failed' };

interface StoreAnswer {
	outcome: ProbeOutcome;

	/** When the probe giving it began, on the monotonic clock. */
	probedAt: number;
}

// An unready judgement for unknown migrations alone carries them.
type Judgement =
	| {
			cause: string;
			ready: false;
			unknownMigrations?: readonly UnknownMigration[];
	  }
	| { ready: true };

const READY: Judgement = Object.freeze({ ready: true });

const unknownOf = (judgement: Judgement): readonly UnknownMigration[] | undefined =>
	judgement.ready ? undefined : judgement.unknownMigrations;

// A failure by its code, a SQLSTATE or a system error's or the store timeout's, since a store's
// message may quote a value.
const causeOf = (failure: unknown): string => {
	const code: unknown =
		typeof failure === 'object' && failure !== null && 'code' in failure ? failure.code : undefined;
	return typeof code === 'string' ? code : STORE_FAILED;
};

/**
 * Creates the Controller's readiness: ready while it has started and is not stopping, its log
 * stream has taken every line, and its store answers within the store timeout, recording no
 * migration this release does not know and not reading as read-only when the instance's role
 * writes. Those are checked in that order, and the store asked only once the others hold. The store
 * is probed once at a time, every request arriving meanwhile awaiting the probe in flight, and its
 * answer is reused for {@link STORE_PROBE_INTERVAL_MILLISECONDS} after the probe began. Each change
 * is written to the log as it is seen, when readiness is asked: becoming unready as
 * {@link READINESS_LOST} at warning, naming its `cause` (`stopping`, `logUnwritable`, the code of
 * the probe's failure, such as `storeTimeout`, `migrationRecordUnreadable` or a SQLSTATE,
 * `storeFailed` for one carrying none, `migrationUnknown` or `readOnly`), and becoming ready again
 * as {@link READINESS_RESTORED} at info. Each time the cause becomes `migrationUnknown`, from ready
 * or from another cause, the migrations are written too, as {@link MIGRATION_UNKNOWN} at error with
 * `refused` `readiness`, and not again while that stays the cause, however many probes find them.
 *
 * @param settings the lifecycle, the log stream, the log, the monotonic clock, the store's probe and
 *   whether the instance's role writes.
 */
export const createReadiness = ({
	isLogWritable,
	isServing,
	log,
	monotonicNow,
	probeStore,
	writesStore,
}: ReadinessSettings): Readiness => {
	const state: {
		judged: Judgement | undefined;
		last: StoreAnswer | undefined;
		probing: Promise<ProbeOutcome> | undefined;
	} = { judged: undefined, last: undefined, probing: undefined };

	const probe = (probedAt: number): Promise<ProbeOutcome> => {
		const probing = probeStore()
			.then(
				(answer): ProbeOutcome => ({ answer, kind: 'answered' }),
				(failure: unknown): ProbeOutcome => ({
					cause: causeOf(failure),
					kind: 'failed',
				}),
			)
			.then((outcome) => {
				state.last = { outcome, probedAt };
				state.probing = undefined;
				return outcome;
			});
		state.probing = probing;
		return probing;
	};

	const storeOutcome = (): Promise<ProbeOutcome> => {
		const now = monotonicNow();
		const { last, probing } = state;
		if (last !== undefined && now - last.probedAt < STORE_PROBE_INTERVAL_MILLISECONDS) {
			return Promise.resolve(last.outcome);
		}
		return probing ?? probe(now);
	};

	const judgedStore = (outcome: ProbeOutcome): Judgement => {
		if (outcome.kind === 'failed') {
			return { cause: outcome.cause, ready: false };
		}
		const { grantRulesValid, readOnly, unknownMigrations } = outcome.answer;
		if (unknownMigrations.length > 0) {
			return {
				cause: MIGRATION_UNKNOWN_CAUSE,
				ready: false,
				unknownMigrations,
			};
		}
		if (!grantRulesValid) {
			return { cause: STORED_SETTINGS_INVALID_CAUSE, ready: false };
		}
		return readOnly && writesStore() ? { cause: 'readOnly', ready: false } : READY;
	};

	const judged = async (): Promise<Judgement> => {
		if (isServing() && isLogWritable()) {
			return judgedStore(await storeOutcome());
		}
		return { cause: isServing() ? 'logUnwritable' : 'stopping', ready: false };
	};

	// Lines mark changes alone, so a run of failed probes writes one, and a run of probes finding
	// unknown migrations one naming them; the Controller counts as ready until judged otherwise, its
	// start having proved the store.
	const noteChange = (judgement: Judgement): void => {
		const previous = state.judged ?? READY;
		state.judged = judgement;
		if (judgement.ready && previous.ready === false) {
			log.info(READINESS_RESTORED);
		}
		if (judgement.ready === false && previous.ready) {
			log.warning(READINESS_LOST, { cause: judgement.cause });
		}
		const unknown = unknownOf(judgement);
		if (unknown !== undefined && unknownOf(previous) === undefined) {
			log.error(MIGRATION_UNKNOWN, migrationUnknownFields(unknown, 'readiness'));
		}
	};

	return {
		isReady: async () => {
			const judgement = await judged();
			noteChange(judgement);
			return judgement.ready;
		},
	};
};
