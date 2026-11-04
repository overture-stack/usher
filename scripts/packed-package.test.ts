import assert from 'node:assert/strict';
import { suite, test } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  checkPackedPackage,
  type Finding,
  inspectTarball,
  type PackageReport,
  reportOf,
} from './packed-package.ts';

const SHIPPED_FILES = [
  'README.md',
  'dist/index.d.ts',
  'dist/index.js',
  'package.json',
];

/**
 * The bridge's manifest as pnpm 12.9.1 packs it with usher-types at 0.1.0, less `private`, with
 * `overrides` spread over it.
 */
const packedManifest = (
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> => ({
  dependencies: {
    'eventsource-parser': '^4.1.1',
    jose: '^6.2.12',
    undici: '^8.11.2',
  },
  devDependencies: {
    '@overture-stack/usher-types': '^0.1.0',
    express4: 'npm:express@^4.22.3',
    tsdown: '0.23.0',
  },
  engines: { node: '>=24' },
  exports: {
    '.': {
      types: './dist/index.d.ts',
      import: './dist/index.js',
      default: './dist/index.js',
    },
  },
  files: ['dist'],
  name: '@overture-stack/usher-express-bridge',
  peerDependencies: {
    '@overture-stack/usher-types': '^0.1.0',
    '@types/express-serve-static-core': '^4.17.33 || ^5.1.3',
    express: '^4.22.3 || ^5.2.1',
  },
  peerDependenciesMeta: {
    '@types/express-serve-static-core': { optional: true },
  },
  scripts: {
    build: 'tsdown',
    test: 'tsx --conditions=@overture-stack/source --test',
    typecheck: 'tsc --noEmit',
  },
  type: 'module',
  version: '0.0.0',
  ...overrides,
});

const failuresOf = (
  manifest: Readonly<Record<string, unknown>>,
  files: readonly string[] = SHIPPED_FILES,
): readonly Pick<Finding, 'message' | 'rule'>[] =>
  checkPackedPackage({ files, manifest })
    .filter((finding) => finding.level === 'fail')
    .map(({ message, rule }) => ({ message, rule }));

const rulesFailed = (
  manifest: Readonly<Record<string, unknown>>,
  files: readonly string[] = SHIPPED_FILES,
): readonly string[] => failuresOf(manifest, files).map(({ rule }) => rule);

type TarFixtureEntry = {
  content?: string;
  name: string;
  prefix?: string;
  type?: string;
};

const BLOCK_SIZE = 512;

/** A POSIX ustar header as pnpm writes one: name, octal size, type flag, magic, version, prefix. */
const ustarHeader = ({
  content = '',
  name,
  prefix = '',
  type = '0',
}: TarFixtureEntry): Buffer => {
  const header = Buffer.alloc(BLOCK_SIZE);
  header.write(name, 0, 100, 'utf8');
  header.write(
    Buffer.byteLength(content).toString(8).padStart(11, '0'),
    124,
    'latin1',
  );
  header.write(type, 156, 'latin1');
  header.write('ustar\0', 257, 'latin1');
  header.write('00', 263, 'latin1');
  header.write(prefix, 345, 155, 'utf8');

  return header;
};

const paddedContent = (content: string): Buffer => {
  const bytes = Buffer.from(content, 'utf8');
  const padding = (BLOCK_SIZE - (bytes.length % BLOCK_SIZE)) % BLOCK_SIZE;

  return Buffer.concat([bytes, Buffer.alloc(padding)]);
};

const tarball = (entries: readonly TarFixtureEntry[]): Buffer =>
  gzipSync(
    Buffer.concat([
      ...entries.flatMap((entry) => [
        ustarHeader(entry),
        paddedContent(entry.content ?? ''),
      ]),
      Buffer.alloc(BLOCK_SIZE * 2),
    ]),
  );

const manifestEntry = (
  manifest: Readonly<Record<string, unknown>>,
): TarFixtureEntry => ({
  content: JSON.stringify(manifest),
  name: 'package/package.json',
});

suite('checkPackedPackage', () => {
  suite('a package packed as intended', () => {
    test('raises no finding for the bridge as pnpm packs it', () => {
      assert.deepEqual(
        checkPackedPackage({
          files: SHIPPED_FILES,
          manifest: packedManifest(),
        }),
        [],
      );
    });

    test('accepts a README and a licence beside package.json, in either spelling', () => {
      const files = [...SHIPPED_FILES, 'LICENCE.txt', 'LICENSE', 'readme'];

      assert.deepEqual(failuresOf(packedManifest(), files), []);
    });

    test('reads the source condition from exports alone, passing a test script that names it', () => {
      const manifest = packedManifest();

      assert.match(JSON.stringify(manifest), /@overture-stack\/source/);
      assert.deepEqual(failuresOf(manifest), []);
    });
  });

  suite('only-intended-files', () => {
    test('fails each source file that ships, naming it', () => {
      const files = [...SHIPPED_FILES, 'src/core/keys.ts', 'src/index.ts'];

      assert.deepEqual(failuresOf(packedManifest(), files), [
        {
          message:
            'src/core/keys.ts ships, and only dist, a README, a licence and package.json may',
          rule: 'only-intended-files',
        },
        {
          message:
            'src/index.ts ships, and only dist, a README, a licence and package.json may',
          rule: 'only-intended-files',
        },
      ]);
    });

    test('fails the build and compiler configuration at the package root', () => {
      const files = [...SHIPPED_FILES, 'tsconfig.json', 'tsdown.config.ts'];

      assert.deepEqual(rulesFailed(packedManifest(), files), [
        'only-intended-files',
        'only-intended-files',
      ]);
    });

    test('fails a README or a manifest below the package root', () => {
      const files = [...SHIPPED_FILES, 'docs/README.md', 'docs/package.json'];

      assert.deepEqual(rulesFailed(packedManifest(), files), [
        'only-intended-files',
        'only-intended-files',
      ]);
    });
  });

  suite('no-test-files', () => {
    test('fails a compiled test file in dist', () => {
      const files = [
        ...SHIPPED_FILES,
        'dist/core/boundedMap.test.d.ts',
        'dist/index.test.js',
        'dist/payload.property.test.js',
      ];

      assert.deepEqual(failuresOf(packedManifest(), files), [
        {
          message:
            'dist/core/boundedMap.test.d.ts is a test file, fixture or test helper',
          rule: 'no-test-files',
        },
        {
          message: 'dist/index.test.js is a test file, fixture or test helper',
          rule: 'no-test-files',
        },
        {
          message:
            'dist/payload.property.test.js is a test file, fixture or test helper',
          rule: 'no-test-files',
        },
      ]);
    });

    test('fails a fixture or anything under a test directory in dist', () => {
      const files = [
        ...SHIPPED_FILES,
        'dist/__tests__/helpers.js',
        'dist/fixtures/principals.json',
        'dist/test/helpers.js',
        'dist/tests/helpers.js',
      ];

      assert.deepEqual(rulesFailed(packedManifest(), files), [
        'no-test-files',
        'no-test-files',
        'no-test-files',
        'no-test-files',
      ]);
    });

    test('fails each test helper and the test-only evaluator in dist', () => {
      const helpers = [
        'dist/core/controllerMock.js',
        'dist/core/testTokens.js',
        'dist/express/testExpress.d.ts',
        'dist/propertySupport.js',
        'dist/sqonEvaluator.d.ts',
        'dist/sqonEvaluator.js',
        'dist/testSupport.js',
      ];

      assert.deepEqual(
        failuresOf(packedManifest(), [...SHIPPED_FILES, ...helpers]).map(
          ({ message }) => message,
        ),
        helpers.map(
          (helper) => `${helper} is a test file, fixture or test helper`,
        ),
      );
    });

    test('passes a module whose name only contains test or mock', () => {
      const files = [
        ...SHIPPED_FILES,
        'dist/attestation.js',
        'dist/hammock.js',
        'dist/latest.js',
        'dist/testament.js',
      ];

      assert.deepEqual(failuresOf(packedManifest(), files), []);
    });
  });

  suite('readme-ships', () => {
    const withoutReadme = SHIPPED_FILES.filter((file) => file !== 'README.md');

    test('fails a package whose tarball holds no README', () => {
      assert.deepEqual(failuresOf(packedManifest(), withoutReadme), [
        {
          message: 'the tarball holds no README at the package root',
          rule: 'readme-ships',
        },
      ]);
    });

    test('notes a missing README, without failing it, while the package is private', () => {
      const manifest = packedManifest({ private: true });

      assert.deepEqual(checkPackedPackage({ files: withoutReadme, manifest }), [
        {
          level: 'note',
          message: 'the tarball holds no README at the package root',
          rule: 'readme-ships',
        },
        {
          level: 'note',
          message:
            'marked private, so it cannot be published until that is lifted',
          rule: 'private',
        },
      ]);
    });

    for (const readme of [
      'README.md',
      'README',
      'readme.md',
      'Readme.markdown',
      'README.txt',
    ]) {
      test(`accepts ${readme} at the package root, as npm finds it in any case`, () => {
        assert.deepEqual(
          failuresOf(packedManifest(), [...withoutReadme, readme]),
          [],
        );
      });
    }

    for (const readme of ['dist/README.md', 'dist/readme', 'LICENCE.md']) {
      test(`fails a package whose only README is ${readme}`, () => {
        assert.deepEqual(
          rulesFailed(packedManifest(), [...withoutReadme, readme]),
          ['readme-ships'],
        );
      });
    }
  });

  suite('exports-resolve', () => {
    test('fails each condition naming a file the tarball does not hold', () => {
      const files = ['README.md', 'dist/index.d.ts', 'package.json'];

      assert.deepEqual(failuresOf(packedManifest(), files), [
        {
          message:
            'exports["."].import names ./dist/index.js, which the tarball does not hold',
          rule: 'exports-resolve',
        },
        {
          message:
            'exports["."].default names ./dist/index.js, which the tarball does not hold',
          rule: 'exports-resolve',
        },
      ]);
    });

    test('fails every condition when dist was never built', () => {
      assert.deepEqual(
        rulesFailed(packedManifest(), ['README.md', 'package.json']),
        ['exports-resolve', 'exports-resolve', 'exports-resolve'],
      );
    });

    test('fails a target without the leading ./ that Node requires', () => {
      const manifest = packedManifest({
        exports: {
          '.': {
            types: './dist/index.d.ts',
            import: 'dist/index.js',
            default: './dist/index.js',
          },
        },
      });

      assert.deepEqual(failuresOf(manifest), [
        {
          message:
            'exports["."].import is "dist/index.js", which Node refuses because it does not start with "./"',
          rule: 'exports-resolve',
        },
      ]);
    });

    test('fails a packed manifest with no exports map', () => {
      const { exports: omitted, ...withoutExports } = packedManifest();

      assert.ok(omitted);

      assert.deepEqual(failuresOf(withoutExports), [
        {
          message: 'the packed manifest has no exports map',
          rule: 'exports-resolve',
        },
      ]);
    });

    test('resolves an exports map given as a single string', () => {
      const manifest = packedManifest({ exports: './dist/index.js' });

      assert.deepEqual(failuresOf(manifest), []);
    });

    test('resolves a subpath pattern against the files that ship', () => {
      const manifest = packedManifest({
        exports: {
          '.': './dist/index.js',
          './core/*': './dist/core/*.js',
        },
      });
      const files = [
        ...SHIPPED_FILES,
        'dist/core/keys.d.ts',
        'dist/core/keys.js',
      ];

      assert.deepEqual(failuresOf(manifest, files), []);
      assert.deepEqual(rulesFailed(manifest), ['exports-resolve']);
    });

    test('skips a null target, which blocks a subpath', () => {
      const manifest = packedManifest({
        exports: { '.': './dist/index.js', './internal/*': null },
      });

      assert.deepEqual(failuresOf(manifest), []);
    });
  });

  suite('types-beside-exports', () => {
    test('fails a JavaScript target that ships without its declaration beside it', () => {
      const manifest = packedManifest({
        exports: {
          '.': { import: './dist/index.js', default: './dist/index.js' },
        },
      });

      assert.deepEqual(
        failuresOf(manifest, ['README.md', 'dist/index.js', 'package.json']),
        [
          {
            message: 'dist/index.js ships without dist/index.d.ts beside it',
            rule: 'types-beside-exports',
          },
        ],
      );
    });

    test('fails a declaration that sits apart from its JavaScript', () => {
      const manifest = packedManifest({
        exports: {
          '.': {
            types: './dist/types/index.d.ts',
            import: './dist/index.js',
          },
        },
      });
      const files = [
        'README.md',
        'dist/index.js',
        'dist/types/index.d.ts',
        'package.json',
      ];

      assert.deepEqual(rulesFailed(manifest, files), ['types-beside-exports']);
    });

    test('accepts .mjs and .cjs targets with .d.mts and .d.cts beside them', () => {
      const manifest = packedManifest({
        exports: {
          '.': { import: './dist/index.mjs', require: './dist/index.cjs' },
        },
      });
      const files = [
        'README.md',
        'dist/index.cjs',
        'dist/index.d.cts',
        'dist/index.d.mts',
        'dist/index.mjs',
        'package.json',
      ];

      assert.deepEqual(failuresOf(manifest, files), []);
    });
  });

  suite('types-first', () => {
    test('fails a conditions object that lists another condition before types', () => {
      const manifest = packedManifest({
        exports: {
          '.': {
            import: './dist/index.js',
            types: './dist/index.d.ts',
            default: './dist/index.js',
          },
        },
      });

      assert.deepEqual(failuresOf(manifest), [
        {
          message:
            'exports["."] lists "import" before "types", which must come first',
          rule: 'types-first',
        },
      ]);
    });

    test('fails a nested conditions object that lists types last', () => {
      const manifest = packedManifest({
        exports: {
          '.': {
            types: './dist/index.d.ts',
            node: { default: './dist/index.js', types: './dist/index.d.ts' },
          },
        },
      });

      assert.deepEqual(failuresOf(manifest), [
        {
          message:
            'exports["."].node lists "default" before "types", which must come first',
          rule: 'types-first',
        },
      ]);
    });

    test('passes types first at every level, and a conditions object holding no types', () => {
      const manifest = packedManifest({
        exports: {
          '.': {
            types: './dist/index.d.ts',
            node: { types: './dist/index.d.ts', default: './dist/index.js' },
            default: './dist/index.js',
          },
          './core/*': { default: './dist/core/*.js' },
        },
      });
      const files = [
        ...SHIPPED_FILES,
        'dist/core/keys.d.ts',
        'dist/core/keys.js',
      ];

      assert.deepEqual(failuresOf(manifest, files), []);
    });
  });

  suite('no-source-condition', () => {
    test('fails the source condition left in the exports map, once for the one defect', () => {
      const manifest = packedManifest({
        exports: {
          '.': {
            '@overture-stack/source': './src/index.ts',
            types: './dist/index.d.ts',
            import: './dist/index.js',
            default: './dist/index.js',
          },
        },
      });

      assert.deepEqual(failuresOf(manifest), [
        {
          message:
            'exports["."]["@overture-stack/source"] is still in the packed manifest, so publishConfig was not applied',
          rule: 'no-source-condition',
        },
      ]);
    });

    test('fails the source condition nested under another condition', () => {
      const manifest = packedManifest({
        exports: {
          '.': {
            types: './dist/index.d.ts',
            node: {
              '@overture-stack/source': './src/index.ts',
              default: './dist/index.js',
            },
          },
        },
      });

      assert.deepEqual(rulesFailed(manifest), ['no-source-condition']);
    });
  });

  suite('no-source-paths', () => {
    test('fails a top-level field that points into src', () => {
      const manifest = packedManifest({
        main: './src/index.ts',
        types: 'src/index.ts',
      });

      assert.deepEqual(failuresOf(manifest), [
        {
          message: 'main is "./src/index.ts", which points into src',
          rule: 'no-source-paths',
        },
        {
          message: 'types is "src/index.ts", which points into src',
          rule: 'no-source-paths',
        },
      ]);
    });

    test('fails a files entry that would ship src', () => {
      const manifest = packedManifest({ files: ['dist', 'src'] });

      assert.deepEqual(failuresOf(manifest), [
        {
          message: 'files[1] is "src", which points into src',
          rule: 'no-source-paths',
        },
      ]);
    });

    test('fails an exports target that points into src under an ordinary condition', () => {
      const manifest = packedManifest({
        exports: {
          '.': {
            types: './dist/index.d.ts',
            import: './src/index.ts',
            default: './dist/index.js',
          },
        },
      });

      assert.deepEqual(rulesFailed(manifest), [
        'exports-resolve',
        'no-source-paths',
      ]);
    });

    test('passes a path that only begins with the letters src', () => {
      const manifest = packedManifest({
        bin: { srcmap: './srcmap.js' },
        description: 'src-free build of the bridge',
      });

      assert.deepEqual(failuresOf(manifest), []);
    });
  });

  suite('no-local-protocol', () => {
    test('fails the workspace range of the bridge peer left unrewritten', () => {
      const manifest = packedManifest({
        peerDependencies: {
          '@overture-stack/usher-types': 'workspace:^',
          express: '^4.22.3 || ^5.2.1',
        },
      });

      assert.deepEqual(failuresOf(manifest), [
        {
          message:
            'peerDependencies["@overture-stack/usher-types"] is "workspace:^", which only this workspace can resolve',
          rule: 'no-local-protocol',
        },
      ]);
    });

    for (const section of [
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      for (const spec of [
        'catalog:',
        'file:../types',
        'link:../types',
        'workspace:*',
      ]) {
        test(`fails "${spec}" in ${section}`, () => {
          const manifest = packedManifest({ [section]: { zod: spec } });

          assert.deepEqual(rulesFailed(manifest), ['no-local-protocol']);
        });
      }
    }

    test('leaves devDependencies alone, since no consumer installs them', () => {
      const manifest = packedManifest({
        devDependencies: { '@overture-stack/usher-types': 'workspace:^' },
      });

      assert.deepEqual(failuresOf(manifest), []);
    });

    test('accepts an npm: alias, which a consumer resolves from the registry', () => {
      const manifest = packedManifest({
        dependencies: { express4: 'npm:express@^4.22.3' },
      });

      assert.deepEqual(failuresOf(manifest), []);
    });
  });

  suite('no-pinned-peer', () => {
    const bridgeAsPacked = (
      overrides: Readonly<Record<string, unknown>> = {},
    ): Readonly<Record<string, unknown>> =>
      packedManifest({
        peerDependencies: {
          '@overture-stack/usher-types': '^0.0.0',
          '@types/express-serve-static-core': '^4.17.33 || ^5.1.3',
          express: '^4.22.3 || ^5.2.1',
        },
        ...overrides,
      });

    test('fails the bridge peer on usher-types at ^0.0.0, naming the one version it admits', () => {
      assert.deepEqual(failuresOf(bridgeAsPacked()), [
        {
          message:
            'peerDependencies["@overture-stack/usher-types"] is "^0.0.0", which admits only 0.0.0',
          rule: 'no-pinned-peer',
        },
      ]);
    });

    test('notes the same peer, without failing it, while the package is private', () => {
      const manifest = bridgeAsPacked({ private: true });

      assert.deepEqual(checkPackedPackage({ files: SHIPPED_FILES, manifest }), [
        {
          level: 'note',
          message:
            'peerDependencies["@overture-stack/usher-types"] is "^0.0.0", which admits only 0.0.0',
          rule: 'no-pinned-peer',
        },
        {
          level: 'note',
          message:
            'marked private, so it cannot be published until that is lifted',
          rule: 'private',
        },
      ]);
    });

    for (const [range, version] of [
      ['1.2.3', '1.2.3'],
      ['=1.2.3', '1.2.3'],
      ['1.0.0-rc.6', '1.0.0-rc.6'],
      ['=0.0.0-alpha.1', '0.0.0-alpha.1'],
      ['^0.0.17', '0.0.17'],
    ] as const) {
      test(`fails "${range}", which admits only ${version}`, () => {
        const manifest = packedManifest({ peerDependencies: { zod: range } });

        assert.deepEqual(failuresOf(manifest), [
          {
            message: `peerDependencies.zod is "${range}", which admits only ${version}`,
            rule: 'no-pinned-peer',
          },
        ]);
      });
    }

    for (const [range, reason] of [
      ['^0.1.0', 'every later 0.1 release'],
      ['^1.2.3', 'every later 1.x release'],
      ['~0.0.3', 'every later 0.0 release'],
      ['^0.0.3-rc.1', 'later prereleases of 0.0.3, and 0.0.3 itself'],
      ['0.0.x', 'every 0.0 release'],
      ['>=1.2.3', 'every release from 1.2.3'],
      ['1.2.3 - 2.0.0', 'every release from 1.2.3 to 2.0.0'],
      ['1.2.3 || ^2.0.0', '1.2.3 and every 2.x release'],
      ['*', 'every release'],
    ] as const) {
      test(`passes "${range}", which admits ${reason}`, () => {
        const manifest = packedManifest({ peerDependencies: { zod: range } });

        assert.deepEqual(failuresOf(manifest), []);
      });
    }

    test('passes a version refused by semver for a leading zero, since it admits nothing', () => {
      const manifest = packedManifest({
        peerDependencies: { cookie: '01.2.3', zod: '1.2.3-01' },
      });

      assert.deepEqual(failuresOf(manifest), []);
    });

    test('passes an exact version in dependencies or optionalDependencies, which a consumer installs for the package alone', () => {
      const manifest = packedManifest({
        dependencies: { jose: '6.2.12' },
        optionalDependencies: { undici: '=8.11.2' },
      });

      assert.deepEqual(failuresOf(manifest), []);
    });
  });

  suite('private', () => {
    test('notes a private package without failing it', () => {
      const manifest = packedManifest({ private: true });

      assert.deepEqual(checkPackedPackage({ files: SHIPPED_FILES, manifest }), [
        {
          level: 'note',
          message:
            'marked private, so it cannot be published until that is lifted',
          rule: 'private',
        },
      ]);
    });

    test('raises no note for a package marked private: false', () => {
      const manifest = packedManifest({ private: false });

      assert.deepEqual(
        checkPackedPackage({ files: SHIPPED_FILES, manifest }),
        [],
      );
    });
  });
});

suite('inspectTarball', () => {
  test('lists each file relative to the package root, with the manifest read from it', () => {
    const manifest = packedManifest();
    const report = inspectTarball(
      'bridge.tgz',
      tarball([
        { content: 'export {};', name: 'package/dist/index.js' },
        manifestEntry(manifest),
        { content: '# Bridge', name: 'package/README.md' },
        { content: 'export {};', name: 'package/dist/index.d.ts' },
      ]),
    );

    assert.deepEqual(report, {
      files: SHIPPED_FILES,
      findings: [],
      packageName: '@overture-stack/usher-express-bridge',
    });
  });

  test('joins the ustar prefix to the name, as pnpm writes a long path', () => {
    const longDirectory = `package/dist/${'a'.repeat(60)}/${'b'.repeat(60)}`;
    const report = inspectTarball(
      'bridge.tgz',
      tarball([
        { name: 'deep.js', prefix: longDirectory },
        manifestEntry(packedManifest()),
      ]),
    );

    assert.ok(
      report.files.includes(`dist/${'a'.repeat(60)}/${'b'.repeat(60)}/deep.js`),
    );
  });

  test('skips a directory entry, which holds no file', () => {
    const report = inspectTarball(
      'bridge.tgz',
      tarball([
        { name: 'package/dist/', type: '5' },
        { name: 'package/dist/index.js' },
        { name: 'package/dist/index.d.ts' },
        { name: 'package/README.md' },
        manifestEntry(packedManifest()),
      ]),
    );

    assert.deepEqual(report.files, SHIPPED_FILES);
  });

  test('fails a tarball holding an entry type other than a file or a directory', () => {
    const report = inspectTarball(
      'bridge.tgz',
      tarball([
        { content: 'path=x\n', name: 'PaxHeader/index.js', type: 'x' },
        manifestEntry(packedManifest()),
      ]),
    );

    assert.deepEqual(
      report.findings.map(({ level, rule }) => ({ level, rule })),
      [{ level: 'fail', rule: 'tarball' }],
    );
    assert.equal(report.packageName, 'bridge.tgz');
  });

  test('fails bytes that are not a gzipped tarball', () => {
    const report = inspectTarball('bridge.tgz', Buffer.from('not a tarball'));

    assert.deepEqual(
      report.findings.map(({ rule }) => rule),
      ['tarball'],
    );
  });

  test('fails a tarball that holds no package.json', () => {
    const report = inspectTarball(
      'bridge.tgz',
      tarball([{ name: 'package/dist/index.js' }]),
    );

    assert.deepEqual(report, {
      files: ['dist/index.js'],
      findings: [
        {
          level: 'fail',
          message: 'the tarball holds no package/package.json',
          rule: 'manifest',
        },
      ],
      packageName: 'bridge.tgz',
    });
  });

  test('fails a package.json that is not a JSON object', () => {
    const report = inspectTarball(
      'bridge.tgz',
      tarball([{ content: '[1, 2]', name: 'package/package.json' }]),
    );

    assert.deepEqual(
      report.findings.map(({ message, rule }) => ({ message, rule })),
      [
        {
          message: 'package/package.json is not a JSON object',
          rule: 'manifest',
        },
      ],
    );
  });
});

suite('reportOf', () => {
  const cleanReport = (packageName: string): PackageReport => ({
    files: SHIPPED_FILES,
    findings: [
      {
        level: 'note',
        message:
          'marked private, so it cannot be published until that is lifted',
        rule: 'private',
      },
    ],
    packageName,
  });

  test('prints ok with the files shipped, then each note, and passes', () => {
    assert.deepEqual(reportOf([cleanReport('@overture-stack/usher-types')]), {
      failed: false,
      lines: [
        'ok    @overture-stack/usher-types  ships README.md, dist/index.d.ts, dist/index.js, package.json',
        'NOTE  @overture-stack/usher-types  private: marked private, so it cannot be published until that is lifted',
        'checked 1 package: 0 failures, 1 note',
      ],
    });
  });

  test('prints one line per failure naming the package and the rule, and fails', () => {
    const failing: PackageReport = {
      files: [...SHIPPED_FILES, 'src/index.ts'],
      findings: checkPackedPackage({
        files: [...SHIPPED_FILES, 'src/index.ts'],
        manifest: packedManifest({ private: true }),
      }),
      packageName: '@overture-stack/usher-express-bridge',
    };

    assert.deepEqual(
      reportOf([failing, cleanReport('@overture-stack/usher-types')]),
      {
        failed: true,
        lines: [
          'FAIL  @overture-stack/usher-express-bridge  only-intended-files: src/index.ts ships, and only dist, a README, a licence and package.json may',
          'NOTE  @overture-stack/usher-express-bridge  private: marked private, so it cannot be published until that is lifted',
          'ok    @overture-stack/usher-types  ships README.md, dist/index.d.ts, dist/index.js, package.json',
          'NOTE  @overture-stack/usher-types  private: marked private, so it cannot be published until that is lifted',
          'checked 2 packages: 1 failure, 2 notes',
        ],
      },
    );
  });

  test('fails when no package was packed, rather than pass with nothing checked', () => {
    assert.deepEqual(reportOf([]), {
      failed: true,
      lines: ['FAIL  no package was packed'],
    });
  });
});
