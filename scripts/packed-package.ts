import { gunzipSync } from 'node:zlib';

/** A package as written by `pnpm pack`: the manifest inside its tarball and the files it holds. */
export type PackedPackage = {
  /** Each file's path relative to the package root, such as `dist/index.js`. */
  files: readonly string[];
  manifest: Readonly<Record<string, unknown>>;
};

/** One result of checking a packed package. A `fail` fails the check; a `note` is only reported. */
export type Finding = {
  level: 'fail' | 'note';
  message: string;
  rule: string;
};

/** What one tarball holds, the package it names, and what the check found in it. */
export type PackageReport = {
  files: readonly string[];
  findings: readonly Finding[];
  /** The packed manifest's name, or the tarball's file name when the manifest gives none. */
  packageName: string;
};

/** The lines to print for a whole run, and whether any package failed. */
export type Report = {
  failed: boolean;
  lines: readonly string[];
};

type Rule = (packed: PackedPackage) => readonly Finding[];

type ManifestValue = {
  path: readonly string[];
  value: unknown;
};

type ManifestString = {
  path: readonly string[];
  value: string;
};

type TarEntry = {
  content: Buffer;
  path: string;
};

const BLOCK_SIZE = 512;
const CONSUMER_DEPENDENCY_SECTIONS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
];
const DIRECTORY_TYPE = '5';
const FILE_TYPES = new Set(['\0', '0']);
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const LOCAL_PROTOCOLS = ['catalog:', 'file:', 'link:', 'workspace:'];
const MANIFEST_PATH = 'package/package.json';
const PACKAGE_ROOT = 'package/';
/** A README as npm finds one for the registry page: `README` or `README.*` at the root, in any case. */
const README_FILE = /^readme(\.[^/]*)?$/i;
const ROOT_DOCUMENT = /^(licen[cs]e|readme)(\.[^/]*)?$/i;
const RUNTIME_FILE = /\.([cm]?)js$/;
const SOURCE_CONDITION = '@overture-stack/source';
const SOURCE_PATH = /^(\.\/)?src(\/|$)/;
const TEST_DIRECTORY = /(^|\/)(__tests__|fixtures|tests?)\//;
const TEST_FILE_NAME = /\.(spec|test)\./;
const TEST_HELPER_STEM = /^test(?![a-z])|(^m|M)ock$/;
const USTAR_MAGIC = 'ustar\0';

// Test-only modules whose names carry no test marker. Each is kept off its package root, so it can
// reach dist only as a file of its own.
const TEST_ONLY_MODULES = new Set(['propertySupport', 'sqonEvaluator']);

// semver's grammar for a version, as semver.org gives it: a numeric identifier has no leading zero,
// and a prerelease identifier is numeric or holds a letter or a hyphen.
const NUMERIC_IDENTIFIER = String.raw`(?:0|[1-9]\d*)`;
const PRERELEASE_IDENTIFIER = String.raw`(?:${NUMERIC_IDENTIFIER}|\d*[A-Za-z-][0-9A-Za-z-]*)`;
const VERSION = String.raw`${NUMERIC_IDENTIFIER}\.${NUMERIC_IDENTIFIER}\.${NUMERIC_IDENTIFIER}(?:-${PRERELEASE_IDENTIFIER}(?:\.${PRERELEASE_IDENTIFIER})*)?`;

// The two range forms admitting only one version, each matched whole rather than parsed: an exact
// version, bare or after `=`, and a caret on a 0.0.z release, which means >=0.0.z <0.0.(z+1)-0.
// Neither a tilde on 0.0.z, admitting every later 0.0 release, nor a caret on a 0.0.z prerelease,
// admitting later prereleases of 0.0.z and 0.0.z itself, is one of them. A single version written
// any other way, such as with a leading `v`, build metadata or a pair of comparators, is not read.
const SINGLE_VERSION_RANGES = [
  new RegExp(`^=?(${VERSION})$`),
  new RegExp(String.raw`^\^(0\.0\.${NUMERIC_IDENTIFIER})$`),
];

const failure = (rule: string, message: string): Finding => ({
  level: 'fail',
  message,
  rule,
});

// A private package cannot be published, so a defect that matters only on the registry is noted
// rather than failed until the package is no longer private.
const failureUnlessPrivate = (
  manifest: Readonly<Record<string, unknown>>,
  rule: string,
  message: string,
): Finding => ({
  level: manifest.private === true ? 'note' : 'fail',
  message,
  rule,
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const childrenOf = (
  value: unknown,
): readonly (readonly [string, unknown])[] => {
  if (Array.isArray(value)) {
    return value.map(
      (child: unknown, index) => [String(index), child] as const,
    );
  }

  return isRecord(value) ? Object.entries(value) : [];
};

/** `value` and everything inside it, each with the keys that lead to it from `path`. */
const valuesIn = (
  value: unknown,
  path: readonly string[],
): readonly ManifestValue[] => [
  { path, value },
  ...childrenOf(value).flatMap(([key, child]) =>
    valuesIn(child, [...path, key]),
  ),
];

const stringsIn = (
  value: unknown,
  path: readonly string[],
): readonly ManifestString[] =>
  valuesIn(value, path).flatMap((entry) =>
    typeof entry.value === 'string'
      ? [{ path: entry.path, value: entry.value }]
      : [],
  );

const keyText = (key: string, index: number): string => {
  if (/^\d+$/.test(key)) {
    return `[${key}]`;
  }

  if (IDENTIFIER.test(key)) {
    return index === 0 ? key : `.${key}`;
  }

  return `[${JSON.stringify(key)}]`;
};

/** A manifest location as a reader would write it: `exports["."].import`, `files[1]`. */
const pathText = (path: readonly string[]): string =>
  path.map(keyText).join('');

const isIntendedFile = (file: string): boolean =>
  file === 'package.json' ||
  file.startsWith('dist/') ||
  ROOT_DOCUMENT.test(file);

const isTestShaped = (file: string): boolean => {
  const fileName = file.slice(file.lastIndexOf('/') + 1);
  const stem = fileName.split('.')[0] ?? fileName;

  return (
    TEST_DIRECTORY.test(file) ||
    TEST_FILE_NAME.test(fileName) ||
    TEST_HELPER_STEM.test(stem) ||
    TEST_ONLY_MODULES.has(stem)
  );
};

// The source condition's own target is left to the rule that reports the condition, so the one
// defect is reported once.
const exportTargets = (
  manifest: Readonly<Record<string, unknown>>,
): readonly ManifestString[] =>
  stringsIn(manifest.exports, ['exports']).filter(
    ({ path }) => !path.includes(SOURCE_CONDITION),
  );

const patternSegment = (text: string): string =>
  text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');

/** The shipped files named by an exports target: one file, or each file matched by a `*` pattern. */
const filesNamedBy = (
  target: string,
  files: readonly string[],
): readonly string[] => {
  const relativePath = target.slice('./'.length);

  if (relativePath.includes('*')) {
    const pattern = new RegExp(
      `^${relativePath.split('*').map(patternSegment).join('.+')}$`,
    );

    return files.filter((file) => pattern.test(file));
  }

  return files.filter((file) => file === relativePath);
};

const declarationBeside = (file: string): string =>
  file.replace(RUNTIME_FILE, '.d.$1ts');

/** The one version admitted by `range`, when it is written in a form admitting only one. */
const onlyVersionAdmitted = (range: string): string | undefined =>
  SINGLE_VERSION_RANGES.map((form) => form.exec(range)?.[1]).find(
    (version) => version !== undefined,
  );

const unintendedFiles: Rule = ({ files }) =>
  files
    .filter((file) => !isIntendedFile(file))
    .map((file) =>
      failure(
        'only-intended-files',
        `${file} ships, and only dist, a README, a licence and package.json may`,
      ),
    );

const testFiles: Rule = ({ files }) =>
  files
    .filter((file) => file.startsWith('dist/') && isTestShaped(file))
    .map((file) =>
      failure(
        'no-test-files',
        `${file} is a test file, fixture or test helper`,
      ),
    );

const missingReadme: Rule = ({ files, manifest }) =>
  files.some((file) => README_FILE.test(file))
    ? []
    : [
        failureUnlessPrivate(
          manifest,
          'readme-ships',
          'the tarball holds no README at the package root',
        ),
      ];

const unresolvedExports: Rule = ({ files, manifest }) => {
  const hasExports =
    manifest.exports !== undefined && manifest.exports !== null;

  if (hasExports) {
    return exportTargets(manifest).flatMap(({ path, value }) => {
      if (value.startsWith('./')) {
        if (filesNamedBy(value, files).length > 0) {
          return [];
        }

        const absence = value.includes('*')
          ? 'matches no file the tarball holds'
          : 'the tarball does not hold';

        return [
          failure(
            'exports-resolve',
            `${pathText(path)} names ${value}, which ${absence}`,
          ),
        ];
      }

      return [
        failure(
          'exports-resolve',
          `${pathText(path)} is "${value}", which Node refuses because it does not start with "./"`,
        ),
      ];
    });
  }

  return [failure('exports-resolve', 'the packed manifest has no exports map')];
};

const undeclaredExports: Rule = ({ files, manifest }) => {
  const runtimeFiles = new Set(
    exportTargets(manifest)
      .filter(({ value }) => value.startsWith('./'))
      .flatMap(({ value }) => filesNamedBy(value, files))
      .filter((file) => RUNTIME_FILE.test(file)),
  );

  return [...runtimeFiles]
    .filter((file) => !files.includes(declarationBeside(file)))
    .map((file) =>
      failure(
        'types-beside-exports',
        `${file} ships without ${declarationBeside(file)} beside it`,
      ),
    );
};

// TypeScript takes the first condition it matches, in object order, so a runtime condition ahead of
// `types` sends it to the JavaScript file instead. The source condition is skipped, since its own
// rule reports it.
const typesOutOfOrder: Rule = ({ manifest }) =>
  valuesIn(manifest.exports, ['exports']).flatMap(({ path, value }) => {
    if (isRecord(value) && Object.hasOwn(value, 'types')) {
      const firstCondition = Object.keys(value).find(
        (condition) => condition !== SOURCE_CONDITION,
      );

      return firstCondition === 'types'
        ? []
        : [
            failure(
              'types-first',
              `${pathText(path)} lists "${firstCondition}" before "types", which must come first`,
            ),
          ];
    }

    return [];
  });

const sourceConditions: Rule = ({ manifest }) =>
  valuesIn(manifest, [])
    .filter(({ path }) => path.at(-1) === SOURCE_CONDITION)
    .map(({ path }) =>
      failure(
        'no-source-condition',
        `${pathText(path)} is still in the packed manifest, so publishConfig was not applied`,
      ),
    );

const sourcePaths: Rule = ({ manifest }) =>
  stringsIn(manifest, [])
    .filter(
      ({ path, value }) =>
        SOURCE_PATH.test(value) && !path.includes(SOURCE_CONDITION),
    )
    .map(({ path, value }) =>
      failure(
        'no-source-paths',
        `${pathText(path)} is "${value}", which points into src`,
      ),
    );

// devDependencies are left out: no consumer's install reads them.
const localProtocols: Rule = ({ manifest }) =>
  CONSUMER_DEPENDENCY_SECTIONS.flatMap((section) => {
    const specs = manifest[section];

    return isRecord(specs)
      ? stringsIn(specs, [section])
          .filter(({ value }) =>
            LOCAL_PROTOCOLS.some((protocol) => value.startsWith(protocol)),
          )
          .map(({ path, value }) =>
            failure(
              'no-local-protocol',
              `${pathText(path)} is "${value}", which only this workspace can resolve`,
            ),
          )
      : [];
  });

// A consumer installs one copy of a peer for every package sharing it, so a peer range admitting
// only one version holds the consumer to that version.
const pinnedPeers: Rule = ({ manifest }) => {
  const peers = manifest.peerDependencies;

  return isRecord(peers)
    ? stringsIn(peers, ['peerDependencies']).flatMap(({ path, value }) => {
        const version = onlyVersionAdmitted(value);

        return version === undefined
          ? []
          : [
              failureUnlessPrivate(
                manifest,
                'no-pinned-peer',
                `${pathText(path)} is "${value}", which admits only ${version}`,
              ),
            ];
      })
    : [];
};

const privateNote: Rule = ({ manifest }) =>
  manifest.private === true
    ? [
        {
          level: 'note',
          message:
            'marked private, so it cannot be published until that is lifted',
          rule: 'private',
        },
      ]
    : [];

// In the order their findings are printed.
const RULES: readonly Rule[] = [
  unintendedFiles,
  testFiles,
  missingReadme,
  unresolvedExports,
  undeclaredExports,
  typesOutOfOrder,
  sourceConditions,
  sourcePaths,
  localProtocols,
  pinnedPeers,
  privateNote,
];

/**
 * Checks a packed package against what publishing it should ship, returning every finding in rule
 * order. A package fails when:
 * - it ships anything but `dist`, a README, a licence and `package.json`;
 * - `dist` holds a test file, fixture or test helper;
 * - the package root holds no README, as npm finds one;
 * - the manifest has no exports map, or an exports target is missing from the tarball or does not
 *   start with `./`;
 * - a JavaScript file named by an exports target ships without its declaration file beside it;
 * - a conditions object holding `types` lists another condition first;
 * - the `@overture-stack/source` condition remains, or another field points into `src`;
 * - a dependency, optional dependency or peer dependency range uses a protocol resolvable only
 *   within the workspace;
 * - a peer range admits only one version.
 *
 * A private package gets a `note` saying so, and while it is private, a missing README and a peer
 * range admitting only one version are noted rather than failed.
 */
export const checkPackedPackage = (packed: PackedPackage): readonly Finding[] =>
  RULES.flatMap((rule) => rule(packed));

const fieldText = (header: Buffer, start: number, length: number): string => {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);

  return field.toString('utf8', 0, end === -1 ? field.length : end);
};

// A POSIX ustar header splits a path longer than 100 bytes into a prefix and a name, which pnpm
// does. Any other entry type, such as a pax or GNU long-name header, would rename the entry after it,
// so it stops the read rather than let a path be misattributed.
const entriesFrom = (archive: Buffer, offset: number): readonly TarEntry[] => {
  const header = archive.subarray(offset, offset + BLOCK_SIZE);

  if (header.length < BLOCK_SIZE || header.every((byte) => byte === 0)) {
    return [];
  }

  const name = fieldText(header, 0, 100);
  const isUstar = header.toString('latin1', 257, 263) === USTAR_MAGIC;
  const prefix = isUstar ? fieldText(header, 345, 155) : '';
  const path = prefix === '' ? name : `${prefix}/${name}`;
  const size = Number.parseInt(fieldText(header, 124, 12).trim(), 8);
  const type = header.toString('latin1', 156, 157);
  const hasReadableSize = Number.isInteger(size);
  const hasReadableType = FILE_TYPES.has(type) || type === DIRECTORY_TYPE;

  if (hasReadableSize && hasReadableType) {
    const contentStart = offset + BLOCK_SIZE;
    const rest = entriesFrom(
      archive,
      contentStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE,
    );

    return type === DIRECTORY_TYPE
      ? rest
      : [
          {
            content: archive.subarray(contentStart, contentStart + size),
            path,
          },
          ...rest,
        ];
  }

  throw new Error(
    hasReadableSize
      ? `entry ${path} is of type "${type}", which this reader does not read`
      : `entry ${path} has a size this reader cannot read`,
  );
};

const readTarball = (
  gzipped: Uint8Array,
): { entries: readonly TarEntry[] } | { problem: string } => {
  try {
    return { entries: entriesFrom(gunzipSync(gzipped), 0) };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
};

const parsedRecord = (
  content: Buffer,
): Readonly<Record<string, unknown>> | undefined => {
  try {
    const parsed: unknown = JSON.parse(content.toString('utf8'));

    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Reads a gzipped tarball as written by `pnpm pack` and checks the package inside under
 * {@link checkPackedPackage}. The report lists each file's path with the leading `package/`
 * removed, sorted by code unit. Instead of those findings, the report holds a single `fail`
 * finding when the tarball cannot be read, holds no `package/package.json`, or holds a manifest
 * that is not a JSON object; an unreadable tarball lists no files.
 *
 * @param tarballName the tarball's file name, which names the package when its manifest does not.
 */
export const inspectTarball = (
  tarballName: string,
  gzipped: Uint8Array,
): PackageReport => {
  const read = readTarball(gzipped);

  if ('problem' in read) {
    return {
      files: [],
      findings: [
        failure('tarball', `the tarball cannot be read: ${read.problem}`),
      ],
      packageName: tarballName,
    };
  }

  const files = read.entries
    .map(({ path }) =>
      path.startsWith(PACKAGE_ROOT) ? path.slice(PACKAGE_ROOT.length) : path,
    )
    .toSorted();
  const manifestEntry = read.entries.find(({ path }) => path === MANIFEST_PATH);

  if (manifestEntry === undefined) {
    return {
      files,
      findings: [failure('manifest', `the tarball holds no ${MANIFEST_PATH}`)],
      packageName: tarballName,
    };
  }

  const manifest = parsedRecord(manifestEntry.content);

  if (manifest === undefined) {
    return {
      files,
      findings: [failure('manifest', `${MANIFEST_PATH} is not a JSON object`)],
      packageName: tarballName,
    };
  }

  return {
    files,
    findings: checkPackedPackage({ files, manifest }),
    packageName:
      typeof manifest.name === 'string' ? manifest.name : tarballName,
  };
};

const LEVEL_LABELS = { fail: 'FAIL', note: 'NOTE' } as const;

const findingLine = (
  packageName: string,
  { level, message, rule }: Finding,
): string => `${LEVEL_LABELS[level]}  ${packageName}  ${rule}: ${message}`;

const counted = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

const packageLines = ({
  files,
  findings,
  packageName,
}: PackageReport): readonly string[] => {
  const failures = findings.filter(({ level }) => level === 'fail');
  const notes = findings.filter(({ level }) => level === 'note');
  const verdict =
    failures.length === 0
      ? [`ok    ${packageName}  ships ${files.join(', ')}`]
      : failures.map((finding) => findingLine(packageName, finding));

  return [
    ...verdict,
    ...notes.map((finding) => findingLine(packageName, finding)),
  ];
};

/**
 * The lines a run prints: per package, `ok` with the files it ships or one line per failure, then
 * its notes, each naming the package and the rule; then a count. A run that packed nothing fails.
 */
export const reportOf = (reports: readonly PackageReport[]): Report => {
  if (reports.length === 0) {
    return { failed: true, lines: ['FAIL  no package was packed'] };
  }

  const findings = reports.flatMap((report) => report.findings);
  const failureCount = findings.filter(({ level }) => level === 'fail').length;
  const noteCount = findings.length - failureCount;

  return {
    failed: failureCount > 0,
    lines: [
      ...reports.flatMap(packageLines),
      `checked ${counted(reports.length, 'package')}: ${counted(failureCount, 'failure')}, ${counted(noteCount, 'note')}`,
    ],
  };
};
