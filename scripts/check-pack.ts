import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { declarationFindings, runtimeFindings } from './packed-bridge.ts';
import { loadFindings } from './packed-load.ts';
import { distFilesOf, type Finding, inspectTarball, type PackageReport, reportOf } from './packed-package.ts';

const BRIDGE = '@overture-stack/usher-bridge--express';
const TYPES = '@overture-stack/usher-types';

const workspaceRoot = resolve(import.meta.dirname, '..');

type PackedTarball = {
	gzipped: Buffer;
	path: string;
	report: PackageReport;
};

// `pnpm pack` is what `pnpm publish` uploads: it applies publishConfig and rewrites the workspace
// and catalogue ranges, which reading the manifests on disk would miss.
const packedTarballs = (packDirectory: string): readonly PackedTarball[] => {
	execFileSync('pnpm', ['--filter', './modules/*', '--recursive', 'pack', '--pack-destination', packDirectory], {
		cwd: workspaceRoot,
		stdio: ['ignore', 'ignore', 'inherit'],
	});

	return readdirSync(packDirectory)
		.filter((fileName) => fileName.endsWith('.tgz'))
		.toSorted()
		.map((fileName) => {
			const path = join(packDirectory, fileName);
			const gzipped = readFileSync(path);

			return { gzipped, path, report: inspectTarball(fileName, gzipped) };
		});
};

const missingFrom = (packageName: string): PackageReport => ({
	files: [],
	findings: [
		{
			level: 'fail',
			message: `${packageName} was not packed, so the checks of the packed Bridge could not run`,
			rule: 'packed',
		},
	],
	packageName,
});

/** The Bridge's declarations, its JavaScript and its loading, each checked on the packed tarballs. */
const bridgeFindings = (bridge: PackedTarball, types: PackedTarball | undefined): readonly Finding[] => {
	const files = distFilesOf(bridge.gzipped);
	const loading: readonly Finding[] =
		types === undefined
			? [
					{
						level: 'fail',
						message: `${TYPES} was not packed, so the packed Bridge could not be installed`,
						rule: 'loads-with-require',
					},
				]
			: loadFindings(bridge.path, types.path);

	return [...declarationFindings(files), ...runtimeFindings(files), ...loading];
};

const checkedReports = (packDirectory: string): readonly PackageReport[] => {
	const tarballs = packedTarballs(packDirectory);
	const bridge = tarballs.find(({ report }) => report.packageName === BRIDGE);
	const types = tarballs.find(({ report }) => report.packageName === TYPES);

	if (bridge === undefined) {
		return [...tarballs.map(({ report }) => report), missingFrom(BRIDGE)];
	}

	return tarballs.map((tarball) =>
		tarball === bridge
			? { ...tarball.report, findings: [...tarball.report.findings, ...bridgeFindings(bridge, types)] }
			: tarball.report,
	);
};

const packDirectory = mkdtempSync(join(tmpdir(), 'usher-check-pack-'));

try {
	const { failed, lines } = reportOf(checkedReports(packDirectory));
	console.log(lines.join('\n'));
	process.exitCode = failed ? 1 : 0;
} catch (error) {
	const reason = error instanceof Error ? error.message : String(error);
	console.error(`FAIL  packing did not complete: ${reason}`);
	process.exitCode = 1;
} finally {
	rmSync(packDirectory, { force: true, recursive: true });
}
