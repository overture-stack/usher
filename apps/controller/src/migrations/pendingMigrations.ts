import { ControllerError } from '../controllerError.js';
import { MIGRATIONS_REFUSE_TO_RUN } from './migrationRefusal.js';
import type { AppliedMigration, Migration } from './types.js';

const describedRefusal = (rule: string): ControllerError =>
  new ControllerError(`${MIGRATIONS_REFUSE_TO_RUN}: ${rule}`);

// The record must be this release's migrations from the first, in order, each unchanged: anything
// else means a migration was edited, removed or slipped in below one already applied, and applying
// the rest on top of that history could leave a schema no release describes. A refusal names only
// this release's own migrations, never a name the record holds.
const refusalOfRecord = (
  known: readonly Migration[],
  applied: readonly AppliedMigration[],
): ControllerError | undefined => {
  const departure = applied.findIndex(
    ({ checksum, name }, index) =>
      known[index]?.name !== name || known[index]?.checksum !== checksum,
  );
  const record = applied[departure];
  if (record === undefined) {
    return undefined;
  }
  const held = known.find(({ name }) => name === record.name);
  const missing = known[departure];
  if (held === undefined || missing === undefined) {
    return describedRefusal(
      'the database records a migration as applied that this release does not hold',
    );
  }
  if (held.checksum !== record.checksum) {
    return describedRefusal(
      `${held.name} has changed since it was applied; a correction is a new migration`,
    );
  }
  return describedRefusal(
    `${missing.name} comes before ${held.name}, which is applied, and is not applied itself`,
  );
};

/**
 * The migrations a run applies, in order: those of `known` after the last one `applied` records,
 * through `target` when one is named. A target already applied gives none, since migrations only
 * move forward.
 *
 * @param known this release's migrations, in order.
 * @param applied the migrations the database records as applied, in order.
 * @param target the last migration to apply, by name; every one when absent.
 * @throws naming the rule broken, when the target names no migration of this release, or when the
 *   record departs from `known`: a migration it holds is absent or changed, or one is missing below
 *   it.
 */
export const pendingMigrations = (
  known: readonly Migration[],
  applied: readonly AppliedMigration[],
  target?: string,
): readonly Migration[] => {
  const through =
    target === undefined
      ? known.length - 1
      : known.findIndex(({ name }) => name === target);
  const refusal =
    through < 0 && target !== undefined
      ? describedRefusal('target names no migration of this release')
      : refusalOfRecord(known, applied);
  if (refusal === undefined) {
    return known.slice(applied.length, through + 1);
  }
  throw refusal;
};
