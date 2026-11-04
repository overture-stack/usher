import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import type { Migration } from './types.js';

/** The folder holding the controller's migrations, one SQL file each. */
export const MIGRATIONS_FOLDER: URL = new URL('./sql/', import.meta.url);

// Four digits giving the order, then words naming what the migration does.
const MIGRATION_FILE = /^(?<number>\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/u;

const SQL_EXTENSION = '.sql';

const readMigration = async (
  folder: URL,
  fileName: string,
): Promise<Migration> => {
  const bytes = await readFile(new URL(fileName, folder));
  return {
    checksum: createHash('sha256').update(bytes).digest('hex'),
    name: fileName.slice(0, -SQL_EXTENSION.length),
    sql: bytes.toString('utf8'),
  };
};

const numberOf = (fileName: string): string | undefined =>
  MIGRATION_FILE.exec(fileName)?.groups?.['number'];

/**
 * Reads every migration in a folder, in order. Every file there must be named as a migration, four
 * digits and words joined by underscores, such as `0001_policy_store.sql`, and no two may share a
 * number, so a misnamed file is refused rather than silently left out.
 *
 * @param folder the folder: {@link MIGRATIONS_FOLDER} by default.
 * @throws naming the file, when one is not named as a migration or shares another's number.
 */
export const readMigrations = async (
  folder: URL = MIGRATIONS_FOLDER,
): Promise<readonly Migration[]> => {
  const fileNames = (await readdir(folder)).toSorted();
  const misnamed = fileNames.find(
    (fileName) => numberOf(fileName) === undefined,
  );
  if (misnamed !== undefined) {
    throw new Error(
      `the migrations folder holds ${misnamed}, which is not named as a migration: four digits, then lower-case words joined by underscores, then .sql`,
    );
  }
  const numbers = fileNames.map(numberOf);
  const repeated = fileNames.find(
    (fileName, index) => numbers.indexOf(numberOf(fileName)) !== index,
  );
  if (repeated !== undefined) {
    throw new Error(
      `the migrations folder holds ${repeated}, whose number another migration already has`,
    );
  }
  return Promise.all(
    fileNames.map((fileName) => readMigration(folder, fileName)),
  );
};
