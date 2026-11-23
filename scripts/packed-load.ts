import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Finding } from './packed-package.ts';

const BRIDGE = '@overture-stack/usher-bridge--express';

// Each entry point with a name it must export: the root's `createUsherMiddleware`, the first thing a
// host imports, and the testing entry's `anonymousAccess`.
const ENTRY_POINTS = [
	{ exportName: 'createUsherMiddleware', specifier: BRIDGE },
	{ exportName: 'anonymousAccess', specifier: `${BRIDGE}/testing` },
] as const;

const WAYS = ['require', 'import'] as const;

type Outcome = {
	detail: string;
	exportName: string;
	exports: boolean;
	loaded: boolean;
	specifier: string;
	way: (typeof WAYS)[number];
};

// Runs in a child `node` inside the install directory, so each specifier resolves to the installed
// tarballs. A failure is recorded per entry point, so one broken entry does not hide the others.
const PROBE = `import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const entryPoints = ${JSON.stringify(ENTRY_POINTS)};
const outcomes = [];

for (const { exportName, specifier } of entryPoints) {
	for (const way of ${JSON.stringify(WAYS)}) {
		try {
			const loaded = way === 'require' ? require(specifier) : await import(specifier);
			outcomes.push({ detail: '', exportName, exports: exportName in loaded, loaded: true, specifier, way });
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);

			outcomes.push({ detail, exportName, exports: false, loaded: false, specifier, way });
		}
	}
}

// The outcomes are the last line, so a module that writes to stdout cannot corrupt them.
process.stdout.write('\\n' + JSON.stringify(outcomes));
`;

const reasonOf = (error: unknown): string => {
	const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr).trim() : '';
	const firstLine = stderr.split('\n').find((line) => line.trim() !== '') ?? '';
	const message = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);

	return firstLine === '' ? message : firstLine;
};

const outcomesOf = (stdout: string): readonly Outcome[] => {
	const parsed: unknown = JSON.parse(stdout.trimEnd().split('\n').at(-1) ?? '');

	if (!Array.isArray(parsed)) {
		throw new Error('the probe printed no outcomes');
	}

	return parsed as readonly Outcome[];
};

const findingOf = ({ detail, exportName, exports, loaded, specifier, way }: Outcome): Finding => {
	const rule = `loads-with-${way}`;

	if (!loaded) {
		return { level: 'fail', message: `${specifier} does not load through ${way}(): ${detail}`, rule };
	}

	if (!exports) {
		return {
			level: 'fail',
			message: `${specifier} loads through ${way}() but does not export ${exportName}`,
			rule,
		};
	}

	return {
		level: 'pass',
		message: `${specifier} loads through ${way}() and exports ${exportName}`,
		rule,
	};
};

/**
 * Installs the packed Bridge with the packed `usher-types` into a throwaway directory, then loads
 * each entry point with `require()` and with `import()`, one finding for each pair. Peers are not
 * installed (`--legacy-peer-deps`): the Bridge imports nothing from express at run time, and the
 * probe would fail naming any package it reaches for that is missing. The directory is removed
 * whether or not the check passes.
 */
export const loadFindings = (bridgeTarball: string, typesTarball: string): readonly Finding[] => {
	const directory = mkdtempSync(join(tmpdir(), 'usher-check-pack-load-'));

	try {
		writeFileSync(join(directory, 'package.json'), '{ "private": true }\n');
		writeFileSync(join(directory, 'probe.mjs'), PROBE);

		try {
			execFileSync(
				'npm',
				[
					'install',
					'--ignore-scripts',
					'--legacy-peer-deps',
					'--no-audit',
					'--no-fund',
					'--no-save',
					'--prefer-offline',
					bridgeTarball,
					typesTarball,
				],
				{ cwd: directory, stdio: ['ignore', 'ignore', 'pipe'] },
			);
		} catch (error) {
			return [
				{
					level: 'fail',
					message: `the packed tarballs did not install: ${reasonOf(error)}`,
					rule: 'loads-with-require',
				},
			];
		}

		const stdout = execFileSync(process.execPath, ['probe.mjs'], {
			cwd: directory,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		return outcomesOf(stdout).map(findingOf);
	} catch (error) {
		return [
			{
				level: 'fail',
				message: `the packed Bridge was not probed: ${reasonOf(error)}`,
				rule: 'loads-with-require',
			},
		];
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
};
