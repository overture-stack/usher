import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { declarationFindings, runtimeFindings } from './packed-bridge.ts';
import type { Finding, PackedFile } from './packed-package.ts';

const failuresOf = (findings: readonly Finding[]): readonly Pick<Finding, 'message' | 'rule'>[] =>
	findings.filter(({ level }) => level === 'fail').map(({ message, rule }) => ({ message, rule }));

const passesOf = (findings: readonly Finding[]): readonly string[] =>
	findings.filter(({ level }) => level === 'pass').map(({ rule }) => rule);

suite('declarationFindings', () => {
	test('passes a declaration naming neither jose nor CryptoKey, importing only names it uses', () => {
		const files: readonly PackedFile[] = [
			{
				path: 'dist/index.d.ts',
				text: 'import { CategoryName } from "@overture-stack/usher-types";\nexport declare const category: (name: CategoryName) => string;\n',
			},
		];

		assert.deepEqual(failuresOf(declarationFindings(files)), []);
		assert.deepEqual(passesOf(declarationFindings(files)), [
			'declaration-names-internals',
			'declaration-unused-import',
		]);
	});

	test('fails a declaration naming CryptoKey, naming the file', () => {
		const files: readonly PackedFile[] = [
			{
				path: 'dist/index.d.ts',
				text: 'export declare const key: CryptoKey;\n',
			},
		];

		assert.deepEqual(failuresOf(declarationFindings(files)), [
			{
				message: 'dist/index.d.ts names CryptoKey, which no public declaration may name',
				rule: 'declaration-names-internals',
			},
		]);
	});

	test('fails a declaration that imports jose by its specifier, even in a type position', () => {
		const files: readonly PackedFile[] = [
			{
				path: 'dist/testing.d.ts',
				text: 'export declare const claims: import("jose").JWTDecryptResult;\n',
			},
		];

		assert.deepEqual(failuresOf(declarationFindings(files)), [
			{
				message: 'dist/testing.d.ts names jose, which no public declaration may name',
				rule: 'declaration-names-internals',
			},
		]);
	});

	test('does not fail a name that only contains jose or CryptoKey', () => {
		const files: readonly PackedFile[] = [
			{
				path: 'dist/index.d.ts',
				text: 'export declare const pair: CryptoKeyPair;\nexport declare const joseLike: number;\n',
			},
		];

		assert.deepEqual(failuresOf(declarationFindings(files)), []);
	});

	test('does not fail documentation that mentions jose or CryptoKey in a comment', () => {
		const files: readonly PackedFile[] = [
			{
				path: 'dist/index.d.ts',
				text: '/** Decrypted with jose under the CryptoKey the Bridge derives. */\nexport declare const value: number;\n// jose\n',
			},
		];

		assert.deepEqual(failuresOf(declarationFindings(files)), []);
	});

	test('fails an import the declaration never uses, naming it', () => {
		const files: readonly PackedFile[] = [
			{
				path: 'dist/index.d.ts',
				text: 'import { Unused } from "some-package";\nexport declare const value: number;\n',
			},
		];

		assert.deepEqual(failuresOf(declarationFindings(files)), [
			{
				message: 'dist/index.d.ts imports Unused, which the file never uses',
				rule: 'declaration-unused-import',
			},
		]);
	});

	test('reads an aliased import by its local name', () => {
		const used: readonly PackedFile[] = [
			{ path: 'dist/index.d.ts', text: 'import { Alpha as Beta } from "x";\nexport declare const c: Beta;\n' },
		];
		const unused: readonly PackedFile[] = [
			{ path: 'dist/index.d.ts', text: 'import { Alpha as Beta } from "x";\nexport declare const c: Alpha;\n' },
		];

		assert.deepEqual(failuresOf(declarationFindings(used)), []);
		assert.deepEqual(failuresOf(declarationFindings(unused)), [
			{
				message: 'dist/index.d.ts imports Beta, which the file never uses',
				rule: 'declaration-unused-import',
			},
		]);
	});

	test('does not count a mention in a comment as a use of an import', () => {
		const files: readonly PackedFile[] = [
			{
				path: 'dist/index.d.ts',
				text: 'import { Gamma } from "x";\n/** Gamma is documented here. */\nexport declare const d: number;\n',
			},
		];

		assert.deepEqual(failuresOf(declarationFindings(files)), [
			{
				message: 'dist/index.d.ts imports Gamma, which the file never uses',
				rule: 'declaration-unused-import',
			},
		]);
	});

	test('counts a type-only import as used when a type position names it', () => {
		const files: readonly PackedFile[] = [
			{
				path: 'dist/index.d.ts',
				text: 'import type { Notice } from "x";\nexport declare const n: Notice | undefined;\n',
			},
		];

		assert.deepEqual(failuresOf(declarationFindings(files)), []);
	});

	test('ignores JavaScript files, and fails when the tarball holds no declaration file', () => {
		assert.deepEqual(failuresOf(declarationFindings([{ path: 'dist/index.js', text: 'export {};' }])), [
			{
				message: 'the tarball holds no declaration file',
				rule: 'declaration-names-internals',
			},
		]);
	});
});

suite('runtimeFindings', () => {
	test('passes when each dependency is imported by its bare specifier and no file carries its code', () => {
		const files: readonly PackedFile[] = [
			{
				path: 'dist/index.js',
				text: 'import { jwtDecrypt } from "jose";\nimport { attachAccess } from "@overture-stack/usher-types";\nexport { jwtDecrypt, attachAccess };\n',
			},
		];

		assert.deepEqual(failuresOf(runtimeFindings(files)), []);
		assert.deepEqual(passesOf(runtimeFindings(files)), [
			'runtime-bare-import',
			'runtime-inlined',
			'runtime-bare-import',
			'runtime-inlined',
		]);
	});

	test('accepts a bare specifier in a dynamic import', () => {
		const files: readonly PackedFile[] = [
			{
				path: 'dist/index.js',
				text: 'const jose = await import("jose");\nimport { attachAccess } from "@overture-stack/usher-types";\n',
			},
		];

		assert.deepEqual(failuresOf(runtimeFindings(files)), []);
	});

	test('fails when jose is inlined, naming the file and the marker it carries', () => {
		const files: readonly PackedFile[] = [
			{
				path: 'dist/index.js',
				text: 'import { jwtDecrypt } from "jose";\nimport { attachAccess } from "@overture-stack/usher-types";\n',
			},
			{
				path: 'dist/errors-AbC123.js',
				text: 'class JOSEError extends Error {\n  static code = "ERR_JOSE_GENERIC";\n}\n',
			},
		];

		assert.deepEqual(failuresOf(runtimeFindings(files)), [
			{
				message: 'dist/errors-AbC123.js carries the source of jose, marked by ERR_JOSE_GENERIC',
				rule: 'runtime-inlined',
			},
		]);
	});

	test('fails when usher-types is inlined, naming the file and the marker it carries', () => {
		const files: readonly PackedFile[] = [
			{
				path: 'dist/index.js',
				text: 'import { jwtDecrypt } from "jose";\nimport { attachAccess } from "@overture-stack/usher-types";\n',
			},
			{
				path: 'dist/access-Cd4a.js',
				text: 'var UsherContractError = class extends Error {\n\tconstructor(rule) {\n\t\tsuper(rule);\n\t\tthis.name = "UsherContractError";\n\t}\n};\n',
			},
		];

		assert.deepEqual(failuresOf(runtimeFindings(files)), [
			{
				message:
					'dist/access-Cd4a.js carries the source of @overture-stack/usher-types, marked by this.name = "UsherContractError"',
				rule: 'runtime-inlined',
			},
		]);
	});

	test('does not fail a file that only compares an error name', () => {
		const files: readonly PackedFile[] = [
			{
				path: 'dist/index.js',
				text: 'import { jwtDecrypt } from "jose";\nimport { attachAccess } from "@overture-stack/usher-types";\nif (error.name === "UsherContractError") {}\n',
			},
		];

		assert.deepEqual(failuresOf(runtimeFindings(files)), []);
	});

	test('fails when no file imports jose by its bare specifier', () => {
		const files: readonly PackedFile[] = [
			{
				path: 'dist/index.js',
				text: 'import { attachAccess } from "@overture-stack/usher-types";\n',
			},
		];

		assert.deepEqual(failuresOf(runtimeFindings(files)), [
			{
				message: 'no file under dist imports jose by its bare specifier',
				rule: 'runtime-bare-import',
			},
		]);
	});
});
