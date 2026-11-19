import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { substituteNames } from './substituteNames.js';

suite("naming a migration's schema and runtime role", () => {
  test('puts each name, quoted as an identifier, wherever its placeholder stands', () => {
    const sql =
      'GRANT USAGE ON SCHEMA :"schema" TO :"runtime_role";\nGRANT SELECT ON users TO :"runtime_role";';

    assert.equal(
      substituteNames(sql, {
        runtimeRole: 'usher_controller',
        schema: 'usher',
      }),
      'GRANT USAGE ON SCHEMA "usher" TO "usher_controller";\nGRANT SELECT ON users TO "usher_controller";',
    );
  });

  test('keeps a name holding quotes, a semicolon or a replacement pattern one identifier', () => {
    const sql = 'GRANT USAGE ON SCHEMA :"schema" TO :"runtime_role";';

    assert.equal(
      substituteNames(sql, {
        runtimeRole: 'role"; DROP SCHEMA usher; --',
        schema: "Usher's $& $1 $$",
      }),
      'GRANT USAGE ON SCHEMA "Usher\'s $& $1 $$" TO "role""; DROP SCHEMA usher; --";',
    );
  });

  test('leaves statements naming neither placeholder as they are', () => {
    const sql = "SELECT ':schema', :'schema', \"schema\";";

    assert.equal(
      substituteNames(sql, { runtimeRole: 'runtime', schema: 'usher' }),
      sql,
    );
  });
});
