import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  inspectTarball,
  type PackageReport,
  reportOf,
} from './packed-package.ts';

const workspaceRoot = resolve(import.meta.dirname, '..');

// `pnpm pack` is what `pnpm publish` uploads: it applies publishConfig and rewrites the workspace
// and catalogue ranges, which reading the manifests on disk would miss.
const packedReports = (packDirectory: string): readonly PackageReport[] => {
  execFileSync(
    'pnpm',
    [
      '--filter',
      './modules/*',
      '--recursive',
      'pack',
      '--pack-destination',
      packDirectory,
    ],
    { cwd: workspaceRoot, stdio: ['ignore', 'ignore', 'inherit'] },
  );

  return readdirSync(packDirectory)
    .filter((fileName) => fileName.endsWith('.tgz'))
    .toSorted()
    .map((fileName) =>
      inspectTarball(fileName, readFileSync(join(packDirectory, fileName))),
    );
};

const packDirectory = mkdtempSync(join(tmpdir(), 'usher-check-pack-'));

try {
  const { failed, lines } = reportOf(packedReports(packDirectory));
  console.log(lines.join('\n'));
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`FAIL  packing did not complete: ${reason}`);
  process.exitCode = 1;
} finally {
  rmSync(packDirectory, { force: true, recursive: true });
}
