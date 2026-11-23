import type { Finding, PackedFile } from './packed-package.ts';

const JOSE = 'jose';
const USHER_TYPES = '@overture-stack/usher-types';

// The names no public declaration may carry: jose's own types and the key type they take. Each is
// matched whole, so `CryptoKeyPair` is not a use of `CryptoKey`.
const INTERNAL_NAMES = [JOSE, 'CryptoKey'];

// `import ... from "..."`, with the clause before `from` captured. Dynamic `import("...")` types have
// no `from`, so they are left to the names check.
const IMPORT_STATEMENT = /\bimport\s+(?:type\s+)?([^;'"]*?)\s*from\s*["']([^"']+)["'];?/g;

const DECLARATION_FILE = /\.d\.ts$/;
const RUNTIME_FILE = /\.[cm]?js$/;

// A marker is a string that only the dependency's own source sets, and that the Bridge never writes,
// so it appears in the Bridge's output only when that source is inlined. Both are public error
// identifiers: jose's base error class sets the code every jose error inherits, `ERR_JOSE_GENERIC`,
// and usher-types' contract error sets its name in its constructor. A consumer may match on either,
// so a release that dropped one would break them.
const RUNTIME_DEPENDENCIES = [
	{ marker: /ERR_JOSE_GENERIC/, markerName: 'ERR_JOSE_GENERIC', specifier: JOSE },
	{
		marker: /\.name\s*=\s*["']UsherContractError["']/,
		markerName: 'this.name = "UsherContractError"',
		specifier: USHER_TYPES,
	},
];

const escapeForRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const identifierPattern = (name: string): RegExp => new RegExp(`(?<![\\w$])${escapeForRegExp(name)}(?![\\w$])`);

const failure = (rule: string, message: string): Finding => ({ level: 'fail', message, rule });

const passed = (rule: string, message: string): Finding => ({ level: 'pass', message, rule });

/** The failures when there are any, otherwise one pass saying what held. */
const resultOf = (rule: string, failures: readonly Finding[], passMessage: string): readonly Finding[] =>
	failures.length > 0 ? failures : [passed(rule, passMessage)];

// Comments go first, so a name in a comment is not read as a use of an import.
const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The local name each binding of an import clause introduces: the alias where there is one. */
const localNamesIn = (clause: string): readonly string[] =>
	clause
		.replace(/[{}]/g, ',')
		.split(',')
		.map((binding) => binding.trim().replace(/^type\s+/, ''))
		.filter((binding) => binding !== '')
		.map((binding) => binding.split(/\s+as\s+/).at(-1) ?? binding);

const importedNamesIn = (code: string): readonly string[] =>
	[...code.matchAll(IMPORT_STATEMENT)].flatMap(([, clause = '']) => localNamesIn(clause));

const declarationsIn = (files: readonly PackedFile[]): readonly PackedFile[] =>
	files.filter(({ path }) => DECLARATION_FILE.test(path));

/**
 * Checks the declarations of the packed Bridge, every `.d.ts` file in `dist`. Two rules: no
 * declaration's code names jose or `CryptoKey`, and every name an import introduces is used somewhere
 * else in its file, counting type positions. Comments count for neither: documentation may mention
 * jose, and a name only a comment mentions is not a use.
 */
export const declarationFindings = (files: readonly PackedFile[]): readonly Finding[] => {
	const declarations = declarationsIn(files);

	if (declarations.length === 0) {
		return [failure('declaration-names-internals', 'the tarball holds no declaration file')];
	}

	const internalNames = declarations.flatMap(({ path, text }) =>
		INTERNAL_NAMES.filter((name) => identifierPattern(name).test(withoutComments(text))).map((name) =>
			failure('declaration-names-internals', `${path} names ${name}, which no public declaration may name`),
		),
	);
	const unusedImports = declarations.flatMap(({ path, text }) => {
		const code = withoutComments(text);
		const body = code.replace(IMPORT_STATEMENT, '');

		return importedNamesIn(code)
			.filter((name) => !identifierPattern(name).test(body))
			.map((name) => failure('declaration-unused-import', `${path} imports ${name}, which the file never uses`));
	});

	return [
		...resultOf(
			'declaration-names-internals',
			internalNames,
			`the ${declarations.length} declaration files name neither jose nor CryptoKey`,
		),
		...resultOf(
			'declaration-unused-import',
			unusedImports,
			`the ${declarations.length} declaration files import only names they use`,
		),
	];
};

const bareImportPattern = (specifier: string): RegExp =>
	new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s+)["']${escapeForRegExp(specifier)}["']`);

/**
 * Checks the JavaScript of the packed Bridge, every `.js` file in `dist`. Two rules, each for jose and
 * for usher-types: some file imports the dependency by its bare specifier, so the host's install
 * supplies it, and no file carries the dependency's own source, as its marker shows.
 */
export const runtimeFindings = (files: readonly PackedFile[]): readonly Finding[] => {
	const runtimeFiles = files.filter(({ path }) => RUNTIME_FILE.test(path));

	return RUNTIME_DEPENDENCIES.flatMap(({ marker, markerName, specifier }) => [
		...resultOf(
			'runtime-bare-import',
			runtimeFiles.some(({ text }) => bareImportPattern(specifier).test(text))
				? []
				: [failure('runtime-bare-import', `no file under dist imports ${specifier} by its bare specifier`)],
			`${specifier} is imported by its bare specifier`,
		),
		...resultOf(
			'runtime-inlined',
			runtimeFiles
				.filter(({ text }) => marker.test(text))
				.map(({ path }) =>
					failure('runtime-inlined', `${path} carries the source of ${specifier}, marked by ${markerName}`),
				),
			`no file under dist carries the source of ${specifier}`,
		),
	]);
};
