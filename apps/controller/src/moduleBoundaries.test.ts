import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { suite, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Each folder under src/ holding TypeScript is a module. From outside a module, which takes in its
// own subfolders, the only way in is its index.ts. The committed contract, openapi.json beside src/, is
// in no module, so importing it enters none; nor is the test support, testing/ beside src/, which a
// test may import and no other file may; any other file outside src/ is refused. From inside, a
// file other than a test never imports that index, since the index re-exports it and the import would
// close a cycle. These checks read the source as text, so a specifier written inside a comment counts
// too, which errs towards refusing.

const SOURCE_ROOT = dirname(fileURLToPath(import.meta.url));

interface SourceFile {
	/** The path from src/, with forward slashes. */
	path: string;

	text: string;
}

const sourceFiles = async (): Promise<readonly SourceFile[]> => {
	const entries = await readdir(SOURCE_ROOT, { recursive: true });
	const paths = entries.filter((entry) => entry.endsWith('.ts')).toSorted();
	return Promise.all(
		paths.map(async (path) => ({
			path: path.split(sep).join('/'),
			text: await readFile(join(SOURCE_ROOT, path), 'utf8'),
		})),
	);
};

const SPECIFIERS = [
	/\b(?:import|export)\b[^;]*?\bfrom\s*['"](?<specifier>[^'"]+)['"]/gu,
	/\bimport\s*['"](?<specifier>[^'"]+)['"]/gu,
	/\bimport\s*\(\s*['"](?<specifier>[^'"]+)['"]\s*\)/gu,
];

const relativeSpecifiers = (text: string): readonly string[] =>
	SPECIFIERS.flatMap((pattern) =>
		[...text.matchAll(pattern)].flatMap(({ groups }) => groups?.['specifier'] ?? []),
	).filter((specifier) => specifier.startsWith('.'));

const folderOf = (path: string): string => {
	const folder = dirname(path);
	return folder === '.' ? '' : folder;
};

const topLevelFolderOf = (path: string): string => folderOf(path).split('/')[0] ?? '';

const isTest = (path: string): boolean => path.endsWith('.test.ts');

// The committed contract, as a target relative to src/.
const COMMITTED_CONTRACT = '../openapi.json';

const isCommittedContract = (target: string): boolean => target === COMMITTED_CONTRACT;

// The test support, as a folder relative to src/: a test beside its source reaches it, and no other file may.
const TEST_SUPPORT = '../testing/';

const isTestSupportFor = (importer: string, target: string): boolean =>
	isTest(importer) && target.startsWith(TEST_SUPPORT);

// src/ itself is no module: its files are entered by path.
const isWithin = (folder: string, module: string): boolean =>
	module === '' || folder === module || folder.startsWith(`${module}/`);

const isNamed = (path: string, fileName: string): boolean => path === fileName || path.endsWith(`/${fileName}`);

// The source file a relative specifier names, from src/: `.js` names the `.ts` beside it.
const targetOf = (importer: string, specifier: string): string =>
	relative(SOURCE_ROOT, join(SOURCE_ROOT, folderOf(importer), specifier.replace(/\.js$/u, '.ts')))
		.split(sep)
		.join('/');

const commentsRemoved = (text: string): string =>
	text.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/^\s*\/\/.*$/gmu, '');

const statementsOf = (text: string): readonly string[] =>
	commentsRemoved(text)
		.split(';')
		.map((statement) => statement.trim())
		.filter((statement) => statement !== '');

const NAMED_RE_EXPORT = /^export\s+(?:type\s+)?\{[^}*]*\}\s+from\s+['"][^'"]+['"]$/u;

const RUNTIME_DECLARATION =
	/^\s*(?:export\s+)?(?:default\b|const\b|let\b|var\b|function\b|async\b|class\b|enum\b|abstract\b|declare\s+(?:const|let|var|function|class|enum)\b)/mu;

const VALUE_IMPORT = /^\s*import\s+(?!type\b)/mu;

suite("the controller's modules", () => {
	test('are entered from outside only through their index', async () => {
		const files = await sourceFiles();

		const crossings = files.flatMap(({ path, text }) =>
			relativeSpecifiers(text).flatMap((specifier) => {
				const target = targetOf(path, specifier);
				const module = topLevelFolderOf(target);
				return isCommittedContract(target) ||
					isTestSupportFor(path, target) ||
					isWithin(folderOf(path), module) ||
					target === `${module}/index.ts`
					? []
					: [`${path} imports ${specifier}`];
			}),
		);

		assert.ok(files.some(({ path }) => isNamed(path, 'index.ts')));
		assert.deepEqual(crossings, []);
	});

	test('import their own index only from tests', async () => {
		const sources = (await sourceFiles()).filter(({ path }) => !isTest(path));

		const ownIndexImports = sources.flatMap(({ path, text }) =>
			relativeSpecifiers(text).flatMap((specifier) => {
				const target = targetOf(path, specifier);
				const module = folderOf(target);
				return module !== '' && target === `${module}/index.ts` && isWithin(folderOf(path), module)
					? [`${path} imports ${specifier}, its own module's index`]
					: [];
			}),
		);

		assert.ok(sources.length > 0);
		assert.deepEqual(ownIndexImports, []);
	});

	test('re-export by name in each index, and hold nothing else there', async () => {
		const indexes = (await sourceFiles()).filter(({ path }) => isNamed(path, 'index.ts'));

		const departures = indexes.flatMap(({ path, text }) =>
			statementsOf(text)
				.filter((statement) => !NAMED_RE_EXPORT.test(statement))
				.map((statement) => `${path}: ${statement}`),
		);

		assert.ok(indexes.length > 0);
		assert.deepEqual(departures, []);
	});

	test('hold no runtime code in a types file', async () => {
		const typeFiles = (await sourceFiles()).filter(({ path }) => isNamed(path, 'types.ts'));

		const departures = typeFiles
			.filter(({ text }) => {
				const code = commentsRemoved(text);
				return RUNTIME_DECLARATION.test(code) || VALUE_IMPORT.test(code);
			})
			.map(({ path }) => path);

		assert.ok(typeFiles.length > 0);
		assert.deepEqual(departures, []);
	});

	test('each have an index test, one per top-level folder', async () => {
		const paths = (await sourceFiles()).map(({ path }) => path);
		const modules = [...new Set(paths.map(topLevelFolderOf))].filter((module) => module !== '');

		const untested = modules
			.filter((module) => !paths.includes(`${module}/index.test.ts`))
			.map((module) => `${module} has no index.test.ts`);

		assert.ok(modules.length > 0);
		assert.deepEqual(untested, []);
	});
});
