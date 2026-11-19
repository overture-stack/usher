import type { LineFields } from '../eventLog/index.js';
import { isMigrationName } from './readMigrations.js';
import type {
  AppliedMigration,
  Migration,
  UnknownMigration,
  UnknownMigrationRefusal,
} from './types.js';

/**
 * The line written at error, when the start or readiness refuses a database recording a migration
 * this release does not know, naming each in `migrations` and what refused in `refused`.
 */
export const MIGRATION_UNKNOWN = 'schema.migrationUnknown';

const NOT_IN_MIGRATION_FORM = 'a name not in migration form';

// A recorded name reaches a line or a refusal only in migration form, which holds nothing but
// digits, lower-case letters and underscores.
const writableName = (name: string): string =>
  isMigrationName(name) ? name : NOT_IN_MIGRATION_FORM;

/**
 * The migrations a database records as applied that this release does not know, in the record's
 * order: each whose name is not among this release's migrations, and each whose name is but whose
 * checksum differs from this release's file. A migration of this release missing from the record is
 * neither, so a database behind the release records none. Each is named by its recorded name when
 * that is in migration form, and otherwise by a fixed phrase, and no checksum is given back.
 *
 * @param known this release's migrations.
 * @param recorded the migrations the database records as applied.
 */
export const unknownMigrations = (
  known: readonly Pick<Migration, 'checksum' | 'name'>[],
  recorded: readonly AppliedMigration[],
): readonly UnknownMigration[] => {
  const checksums = new Map(
    known.map(({ checksum, name }) => [name, checksum]),
  );
  return recorded.flatMap(({ checksum, name }) => {
    const held = checksums.get(name);
    return held === checksum
      ? []
      : [{ checksumDiffers: held !== undefined, name: writableName(name) }];
  });
};

/**
 * The fields of the {@link MIGRATION_UNKNOWN} line: `migrations`, each by its `name`, with
 * `checksumDiffers` true where this release holds a migration of that name, and `refused`.
 *
 * @param unknown the migrations the database records that this release does not know.
 * @param refused what refused: the start, or readiness.
 */
export const migrationUnknownFields = (
  unknown: readonly UnknownMigration[],
  refused: UnknownMigrationRefusal,
): LineFields => ({
  migrations: unknown.map(({ checksumDiffers, name }) =>
    checksumDiffers ? { checksumDiffers, name } : { name },
  ),
  refused,
});
