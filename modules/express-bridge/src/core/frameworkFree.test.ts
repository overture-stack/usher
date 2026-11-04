import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const coreDirectory = new URL('./', import.meta.url);

const IMPORT_FROM =
  /\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu;

const importedSpecifiers = (source: string): readonly string[] =>
  [...source.matchAll(IMPORT_FROM)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? '',
  );

test('keeps every file of the core free of Express, so a bridge for another framework can reuse it', () => {
  const files = readdirSync(coreDirectory).filter((name) =>
    name.endsWith('.ts'),
  );

  const expressImports = files.flatMap((name) =>
    importedSpecifiers(readFileSync(new URL(name, coreDirectory), 'utf8'))
      .filter(
        (specifier) =>
          specifier === 'express' || specifier.startsWith('express/'),
      )
      .map((specifier) => `${name}: ${specifier}`),
  );

  assert.ok(files.length >= 3, 'the scan found the core files');
  assert.deepEqual(expressImports, []);
});
