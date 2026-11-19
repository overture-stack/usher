import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
  type StatementLimit,
  statementLimitProblems,
} from './statementLimits.js';

const BOUND = 5000;

const limits = (
  statement: Omit<StatementLimit, 'name'>,
  idle: Omit<StatementLimit, 'name'> = statement,
): readonly StatementLimit[] => [
  { name: 'idle_in_transaction_session_timeout', ...idle },
  { name: 'statement_timeout', ...statement },
];

const UNAPPLIED = [
  {
    rule: "names a connection on which the store does not apply the controller's statement limits, as a connection pooler that drops startup parameters does",
    variable: 'USHER_DATABASE_URL',
  },
];

suite("the store's limits on the start's session", () => {
  test('pass when both are the store timeout, compared in milliseconds whatever unit the store reports', () => {
    assert.deepEqual(
      [
        statementLimitProblems(limits({ setting: '5000', unit: 'ms' }), BOUND),
        statementLimitProblems(limits({ setting: '5', unit: 's' }), BOUND),
        statementLimitProblems(limits({ setting: '1', unit: 'min' }), 60_000),
      ],
      [[], [], []],
    );
  });

  test('refuse the start, naming the database URL, when either is not the store timeout, as when a pooler dropped them', () => {
    assert.deepEqual(
      [
        statementLimitProblems(limits({ setting: '0', unit: 'ms' }), BOUND),
        statementLimitProblems(
          limits({ setting: '5000', unit: 'ms' }, { setting: '0', unit: 'ms' }),
          BOUND,
        ),
        statementLimitProblems(
          limits({ setting: '5000', unit: 'ms' }).slice(1),
          BOUND,
        ),
      ],
      [UNAPPLIED, UNAPPLIED, UNAPPLIED],
    );
  });

  test('refuse the start when a limit is reported in a unit the controller cannot read', () => {
    assert.deepEqual(
      statementLimitProblems(limits({ setting: '5000', unit: null }), BOUND),
      UNAPPLIED,
    );
  });
});
