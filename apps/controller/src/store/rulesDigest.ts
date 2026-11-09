import { createHash } from 'node:crypto';

import pg from 'pg';

import { ENVIRONMENT_VARIABLES } from '../configuration/index.js';
import type { AuditEvent, AuditTransaction } from '../eventLog/index.js';
import type { StartProblem } from '../failures/index.js';
import type { RecordRules, SeededPolicySettings } from './types.js';
import { writeOrRefuse } from './writeOrRefuse.js';

const UNWRITABLE: StartProblem = {
  rule: 'names a database role that may not record the baseline and signed-in rule this start runs under, which the store has not recorded',
  variable: ENVIRONMENT_VARIABLES.databaseUrl,
};

// A rule confers a set, so the order it is written in changes nothing it confers.
const sorted = ({ baseline, signedInRule }: RecordRules): RecordRules => ({
  baseline: baseline.toSorted(),
  signedInRule: signedInRule.toSorted(),
});

/**
 * The digest of the rules conferring record actions on whole classes of principals, the baseline and
 * the signed-in rule: SHA-256, as base64url, over both, each rule's actions sorted.
 *
 * @param rules the baseline and the signed-in rule.
 */
export const rulesDigestOf = (rules: RecordRules): string =>
  createHash('sha256')
    .update(JSON.stringify(sorted(rules)))
    .digest('base64url');

/**
 * The `baseline.change` event recording the rules a start runs under: each rule's actions, sorted, at
 * `info` when the store recorded none before, its first start, and at `warning` when they replace the
 * rules it recorded, since every principal's reach changes with them.
 *
 * @param rules the baseline and the signed-in rule.
 * @param replacesRecorded whether the store held a digest of other rules.
 */
export const baselineChange = (
  rules: RecordRules,
  replacesRecorded: boolean,
): AuditEvent => ({
  data: sorted(rules),
  severity: replacesRecorded ? 'warning' : 'info',
  type: 'baseline.change',
});

/**
 * Records the digest of the rules this start runs under, with its `baseline.change` event, unless the
 * store holds it already: inserted at the store's first start, and afterwards rewritten only when it
 * differs, which also writes one baseline notice through the table's trigger. Run it while holding
 * the lock every start takes, so of starts under the same changed rules one rewrites the digest and
 * records the event, and the others find it recorded and record nothing.
 *
 * @param transaction the start's transaction, its actor declared.
 * @param settings the rules, the schema, and the clock the digest's recording time is read from.
 * @throws {StartRefusal} naming the database URL's variable when the digest must be written and the
 *   database role may not write it.
 */
export const recordRulesDigest = async (
  { connection, record }: AuditTransaction<pg.ClientBase>,
  { baseline, clock, databaseSchema, signedInRule }: SeededPolicySettings,
): Promise<void> => {
  const table = `${pg.escapeIdentifier(databaseSchema)}.rules_digest`;
  const digest = rulesDigestOf({ baseline, signedInRule });
  const { rows } = await connection.query<{ digest: string }>(
    `SELECT digest FROM ${table}`,
  );
  const recorded = rows[0]?.digest;
  if (recorded === digest) {
    return;
  }
  await writeOrRefuse(UNWRITABLE, () =>
    connection.query(
      recorded === undefined
        ? `INSERT INTO ${table} (digest, recorded_at) VALUES ($1, $2)`
        : `UPDATE ${table} SET digest = $1, recorded_at = $2`,
      [digest, new Date(clock.now())],
    ),
  );
  await record(
    baselineChange({ baseline, signedInRule }, recorded !== undefined),
  );
};
