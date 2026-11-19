// The schema migration command's process entry, and the one place it reads its environment. It runs
// apart from the Controller's processes, which never hold the schema migration role's password. A
// refusal writes one structured line naming the variables at fault to standard error, as the
// Controller's start does, and ends the process with a non-zero code; a run that applies its
// migrations writes one line at info naming them to standard output, where the Controller writes
// its own, and ends with zero. A run allowed a database connection that does not verify the server
// writes one line at warning naming the variable allowing it there first, as the Controller's start
// does. A failure nothing caught writes its line and ends the process at once.
import { readFile } from 'node:fs/promises';
import { constants } from 'node:os';
import { resolve } from 'node:path';

import {
	ENVIRONMENT_VARIABLES,
	SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES,
	readSchemaMigrationConfiguration,
} from './configuration/index.js';
import { createEventLog } from './eventLog/index.js';
import { reportFailure, reportUncaughtFailure, StartRefusal } from './failures/index.js';
import {
	migrate,
	MIGRATIONS_REFUSE_TO_RUN,
	MigrationRefusal,
	type SeedFile,
	type SeedFileOutcome,
	type MigrationOutcome,
	type RefusedOption,
} from './migrations/index.js';
import { connectionProblemOf, UNVERIFIED_CONNECTION_ALLOWED } from './store/index.js';

// The log stream's numbering of info, of warn and of error.
const INFO_LEVEL = 30;

const WARNING_LEVEL = 40;

const ERROR_LEVEL = 50;

const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

const SCHEMA_MIGRATIONS_APPLIED = 'schemaMigrations.applied';

const SEED_FILE_UNCHANGED = 'settings.seedFileUnchanged';

const SEED_FILE_CHANGED = 'settings.seedFileChanged';

const SEED_FILE_READ = 'settings.seedFileRead';

const SEED_FILE_MISSING = 'settings.seedFileMissing';

const SEED_FILE_UNREADABLE = 'settings.seedFileUnreadable';

const SEED_FILE_INVALID = 'settings.seedFileInvalid';

// The variable each option a run's refusal can be laid on is read from.
const OPTION_VARIABLES: Readonly<Record<RefusedOption, string>> = {
	databaseUrl: SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.databaseUrl,
	runtimeRole: ENVIRONMENT_VARIABLES.databaseUrl,
	schema: ENVIRONMENT_VARIABLES.databaseSchema,
	seedFile: SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.seedFile,
};

// A failure laid on an option, or met reaching or signing in to the store, is a variable's fault and
// refused as one; any other is the run's own, reported as it is.
const refusalFor = (failure: unknown): unknown => {
	if (failure instanceof MigrationRefusal) {
		return new StartRefusal(
			[{ rule: failure.rule, variable: OPTION_VARIABLES[failure.option] }],
			MIGRATIONS_REFUSE_TO_RUN,
		);
	}
	const problem = connectionProblemOf(failure, {
		passwordVariable: SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.databasePassword,
		urlVariable: SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.databaseUrl,
	});
	return problem === undefined ? failure : new StartRefusal([problem], MIGRATIONS_REFUSE_TO_RUN);
};

// The line names migrations and whether settings were seeded, never a URL, a role, a password or a
// setting's value. Its members come in the log stream's order, as the failure's do: the level, the
// fields, then the message and the time.
const reportApplied = ({ applied, settingsSeeded }: MigrationOutcome): void => {
	const line = {
		level: INFO_LEVEL,
		applied,
		settingsSeeded,
		message: SCHEMA_MIGRATIONS_APPLIED,
		time: new Date().toISOString(),
	};
	process.stdout.write(`${JSON.stringify(line)}\n`);
};

// The line a run writes for the seed file it read or compared: read at info on a first run, unchanged at info, or
// changed at warning, naming each top-level key that differs and never a value. A later run whose file cannot be
// read, or is not one JSON object, writes its reason or its problem at warning. A run with no file writes none.
const reportSeedFile = (path: string, outcome: SeedFileOutcome): void => {
	if (outcome.kind === 'absent') {
		return;
	}
	const line =
		outcome.kind === 'seeded'
			? { level: INFO_LEVEL, path, message: SEED_FILE_READ }
			: outcome.kind === 'unchanged'
				? { level: INFO_LEVEL, path, message: SEED_FILE_UNCHANGED }
				: outcome.kind === 'unreadable'
					? {
							level: WARNING_LEVEL,
							path,
							message: SEED_FILE_UNREADABLE,
							reason: outcome.reason,
						}
					: outcome.kind === 'invalid'
						? {
								level: WARNING_LEVEL,
								path,
								message: SEED_FILE_INVALID,
								problem: outcome.problem,
							}
						: {
								level: WARNING_LEVEL,
								path,
								added: outcome.added,
								changed: outcome.changed,
								message: SEED_FILE_CHANGED,
								removed: outcome.removed,
							};
	process.stdout.write(`${JSON.stringify({ ...line, time: new Date().toISOString() })}\n`);
};

// The line a first run writes before its refusal when no file is at its path. It names the variable that sets
// the path, and no value.
const reportSeedMissing = (path: string): void => {
	const line = {
		level: ERROR_LEVEL,
		path,
		variable: SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.seedFile,
		message: SEED_FILE_MISSING,
		time: new Date().toISOString(),
	};
	process.stdout.write(`${JSON.stringify(line)}\n`);
};

// The line a first run writes before its refusal when the file at its path cannot be read. It names the reason the
// system gives, as its code, and no value.
const reportSeedUnreadable = (path: string, reason: string): void => {
	const line = {
		level: ERROR_LEVEL,
		path,
		reason,
		message: SEED_FILE_UNREADABLE,
		time: new Date().toISOString(),
	};
	process.stdout.write(`${JSON.stringify(line)}\n`);
};

// The system's code for a failure, such as EACCES, or 'unknown' when it carries none.
const codeOf = (failure: unknown): string =>
	typeof failure === 'object' && failure !== null && 'code' in failure && typeof failure.code === 'string'
		? failure.code
		: 'unknown';

// The seed file at the run's path, read whole before anything is written: its text, nothing when no file is there,
// or the code of the error reading it when it cannot be read.
const loadSeed = (path: string) => async (): Promise<SeedFile> => {
	try {
		return { kind: 'present', text: await readFile(path, 'utf8') };
	} catch (failure) {
		const reason = codeOf(failure);
		return reason === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable', reason };
	}
};

// The line naming the variable that allows an unverified database connection, as the Controller's
// start writes it, in the order the run's other lines keep.
const reportUnverifiedAllowed = (): void => {
	const line = {
		level: WARNING_LEVEL,
		variable: ENVIRONMENT_VARIABLES.databaseAllowUnverifiedConnection,
		message: UNVERIFIED_CONNECTION_ALLOWED,
		time: new Date().toISOString(),
	};
	process.stdout.write(`${JSON.stringify(line)}\n`);
};

process.on('uncaughtException', reportUncaughtFailure('the schema migration command failed'));

// The first stop signal stops the run: its connection ends, which rolls back the migration in flight,
// and the run fails saying it was stopped. The process then exits as one the signal ended does, with
// 128 and the signal's number. The handlers let go at the first, so a second signal ends the process
// at once, as it does by default.
const stopping = new AbortController();
const stoppedBy: { signal?: (typeof STOP_SIGNALS)[number] } = {};
const stop = (signal: (typeof STOP_SIGNALS)[number]): void => {
	STOP_SIGNALS.forEach((name) => {
		process.off(name, stop);
	});
	stoppedBy.signal = signal;
	stopping.abort();
};
STOP_SIGNALS.forEach((signal) => {
	process.on(signal, stop);
});

const run = async (): Promise<void> => {
	const { seedFile, databaseAllowUnverifiedConnection, ...configuration } = readSchemaMigrationConfiguration(
		process.env,
	);
	const path = resolve(seedFile);
	if (databaseAllowUnverifiedConnection) {
		reportUnverifiedAllowed();
	}
	const clock = { now: (): number => Date.now() };
	// The file the run read, kept so a refusal laid on it names what the read found.
	const seedRead: { file?: SeedFile } = {};
	const seed = async (): Promise<SeedFile> => {
		const file = await loadSeed(path)();
		seedRead.file = file;
		return file;
	};
	const outcome = await migrate({
		...configuration,
		seed,
		clock,
		eventLog: createEventLog({ clock, logStream: process.stdout }),
		signal: stopping.signal,
	}).catch((failure: unknown) => {
		if (failure instanceof MigrationRefusal && failure.option === 'seedFile') {
			const read = seedRead.file;
			if (read?.kind === 'unreadable') {
				reportSeedUnreadable(path, read.reason);
			} else {
				reportSeedMissing(path);
			}
		}
		throw refusalFor(failure);
	});
	reportSeedFile(path, outcome.seedFile);
	reportApplied(outcome);
};

run().catch((failure: unknown) => {
	reportFailure('the schema migration command failed')(failure);
	if (stoppedBy.signal !== undefined) {
		process.exitCode = 128 + constants.signals[stoppedBy.signal];
	}
});
