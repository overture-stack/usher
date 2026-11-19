// The global setup loads this module under Node's own type stripping, without tsx: it keeps to
// erasable syntax and imports no sibling's values.
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { UserConfig } from 'tsdown';

/** An entry the Controller's build gives, by the name of the file it builds: the Controller, and its schema migration command. */
export type BuiltEntry = 'main' | 'migrate';

const APP_ROOT = new URL('../', import.meta.url);

const BUILD_VARIABLE = 'USHER_TEST_CONTROLLER_BUILD';

/**
 * Builds the Controller with its committed configuration, the output folder alone changed, into a
 * folder of its own inside the app, as `dist/` is, so the app's package type and its dependencies
 * apply to what is built; the folder's name ends in `.tmp`, which the repository ignores. tsdown is
 * loaded only here, so a test file reading the build loads none of it.
 *
 * @returns the folder holding the build.
 */
export const buildController = async (): Promise<URL> => {
	const folder = new URL(`build-${randomUUID()}.tmp/`, APP_ROOT);
	await mkdir(folder);
	const [{ build }, { default: config }] = await Promise.all([
		import('tsdown'),
		import(new URL('tsdown.config.ts', APP_ROOT).href) as Promise<{
			default: UserConfig;
		}>,
	]);
	await build({
		...config,
		config: false,
		cwd: fileURLToPath(APP_ROOT),
		logLevel: 'warn',
		outDir: fileURLToPath(folder),
	});
	return folder;
};

/**
 * Removes a build, settling once it is gone.
 *
 * @param folder the folder {@link buildController} gave.
 */
export const removeBuild = (folder: URL): Promise<void> => rm(folder, { force: true, recursive: true });

/**
 * The environment variable that hands the run's build to the test files. The global setup sets it
 * before any test file starts, and each test file inherits it; a wrapper script building the
 * Controller could set the same one instead.
 *
 * @param folder the folder holding the build.
 */
export const environmentForBuild = (folder: URL): Readonly<Record<string, string>> => ({
	[BUILD_VARIABLE]: fileURLToPath(folder),
});

/**
 * One file of the run's build of the Controller, read from the environment the global setup
 * published, to run under Node alone.
 *
 * @param entry the entry, by the name of the file it builds.
 * @param environment the environment to read; the process's own by default.
 * @throws {Error} when the run built none, as when a test file runs without the global setup.
 */
export const builtEntry = (
	entry: BuiltEntry,
	environment: Readonly<Record<string, string | undefined>> = process.env,
): URL => {
	const folder = environment[BUILD_VARIABLE];
	if (folder !== undefined) {
		return new URL(`${entry}.js`, pathToFileURL(`${folder}/`));
	}
	throw new Error('the controller is not built: run the suite with pnpm test, whose global setup builds it');
};
