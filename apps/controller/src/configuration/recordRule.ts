import type { RecordAction } from '@overture-stack/usher-types';

import {
  read,
  readList,
  type Reading,
  refused,
  then,
  type Variable,
} from './variableReaders.js';

// Every record action, so the record vocabulary gaining an action fails to compile here.
const RECORD_ACTIONS: Readonly<Record<RecordAction, true>> = {
  count: true,
  create: true,
  delete: true,
  export: true,
  update: true,
  view: true,
};

const VOCABULARY = 'count, view, export, create, update and delete';

// A rule confers on everyone, or on everyone signed in, so it reads records at most.
const READ: ReadonlySet<RecordAction> = new Set(['count', 'export', 'view']);

/** What the baseline and the signed-in rule confer when an instance narrows neither. */
export const DEFAULT_RULE: readonly RecordAction[] = Object.freeze([
  'count',
  'view',
  'export',
]);

const isRecordAction = (entry: string): entry is RecordAction =>
  Object.hasOwn(RECORD_ACTIONS, entry);

const isActionList = (
  entries: readonly string[],
): entries is readonly RecordAction[] => entries.every(isRecordAction);

const readActions = (
  variable: Variable,
  actions: readonly RecordAction[],
): Reading<readonly RecordAction[]> => {
  if (new Set(actions).size === actions.length) {
    return actions.every((action) => READ.has(action))
      ? read(actions)
      : refused(
          variable,
          'confers more than read: a rule holds count, view and export alone',
        );
  }
  return refused(variable, 'names an action twice');
};

/**
 * Reads a rule conferring record actions on a whole class of principals, the baseline or the
 * signed-in rule, as given: a comma-separated list of record actions, each named once, within read
 * (count, view and export), and possibly empty. Unset, it confers count, view and export.
 *
 * @param variable the variable.
 */
export const readRecordRule = (
  variable: Variable,
): Reading<readonly RecordAction[]> =>
  then(readList(variable, DEFAULT_RULE), (entries) =>
    isActionList(entries)
      ? readActions(variable, entries)
      : refused(
          variable,
          `names an action outside the record vocabulary: ${VOCABULARY}`,
        ),
  );
