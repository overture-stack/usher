import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import pg from 'pg';

import { DATABASE_ROLES, USHER_SCHEMA } from '../../test-support/database.js';
import {
  INSUFFICIENT_PRIVILEGE,
  noticeStreamRows,
  openDatabase,
  openSeededDatabase,
  selectRows,
  writeOutcome,
} from '../../test-support/fixtures/database.js';
import {
  inTurn,
  LOWEST_POSITION,
  noticesAfter,
  POLICY_FUNCTIONS,
  POLICY_TABLES,
  qualified,
} from '../../test-support/policy.js';

const { noticeRetention, noticeStream, notices } = POLICY_TABLES;

const TRIM = `${pg.escapeIdentifier(USHER_SCHEMA)}.${pg.escapeIdentifier(POLICY_FUNCTIONS.trimNotices)}()`;

const SEARCH_PATH = 'search_path=';

// The schemas a definer function may search: its own and the catalogue, with the temporary schema,
// which any session can write to, searched last (R3's pin).
const TRUSTED_SCHEMAS: ReadonlySet<string> = new Set([
  'pg_catalog',
  'pg_temp',
  USHER_SCHEMA,
]);

const insertAged = async (
  client: pg.ClientBase,
  kind: string,
  ageSeconds: number,
): Promise<bigint> => {
  const [row] = await selectRows<{ position: string }>(
    client,
    `INSERT INTO ${qualified(notices)} (${notices.columns.createdAt}, ${notices.columns.kind}) VALUES (now() - make_interval(secs => $1), $2) RETURNING ${notices.columns.position}::text AS position`,
    [ageSeconds, kind],
  );
  return BigInt(row?.position ?? '0');
};

const trim = async (client: pg.ClientBase): Promise<bigint> => {
  const [row] = await selectRows<{ trimmedThrough: string }>(
    client,
    `SELECT ${TRIM}::text AS "trimmedThrough"`,
  );
  return BigInt(row?.trimmedThrough ?? '0');
};

const watermark = async (client: pg.ClientBase): Promise<bigint | undefined> =>
  (await noticeStreamRows(client))[0]?.trimmedThrough;

const positionsHeld = async (
  client: pg.ClientBase,
): Promise<readonly bigint[]> =>
  (await noticesAfter(client, LOWEST_POSITION)).map(({ position }) => position);

// Whatever the migrations wrote to the stream is cleared first, so no notice younger than the
// floor sits below an aged one: where a watermark falls behind such a notice is not decided.
const clearStream = async (client: pg.ClientBase): Promise<void> => {
  await client.query(`DELETE FROM ${qualified(notices)}`);
};

suite('trimming the notice stream', () => {
  test('trims notices only through the watermark its retention floor gives, in one transaction', async (context) => {
    const database = await openDatabase(context, {
      retentionFloorSeconds: 120,
    });
    const owner = await database.connect('migration');
    await clearStream(owner);
    const controller = await database.connect('runtime');
    const observer = await database.connect('migration');
    const aged = await inTurn(['baseline', 'global', 'baseline'], (kind) =>
      insertAged(owner, kind, 200),
    );
    const recent = await inTurn(['global', 'baseline'], (kind) =>
      insertAged(owner, kind, 30),
    );
    const heldBefore = await positionsHeld(observer);
    const watermarkBefore = await watermark(observer);

    await controller.query('BEGIN');
    const returned = await trim(controller);
    const heldWhileOpen = await positionsHeld(observer);
    const watermarkWhileOpen = await watermark(observer);
    await controller.query('COMMIT');

    const lastAged = aged.at(-1);
    assert.equal(returned, lastAged);
    assert.deepEqual(heldWhileOpen, heldBefore);
    assert.equal(watermarkWhileOpen, watermarkBefore);
    assert.equal(await watermark(observer), lastAged);
    assert.deepEqual(await positionsHeld(observer), recent);
  });

  test('never lowers the trim watermark', async (context) => {
    const database = await openDatabase(context);
    const owner = await database.connect('migration');
    await clearStream(owner);
    const controller = await database.connect('runtime');
    const aged = await inTurn(['baseline', 'global'], (kind) =>
      insertAged(owner, kind, 900),
    );

    const first = await trim(controller);
    const second = await trim(controller);
    const laterAged = await insertAged(owner, 'baseline', 900);
    const third = await trim(controller);
    await insertAged(owner, 'global', 10);
    const fourth = await trim(controller);

    assert.deepEqual(
      [first, second, third, fourth],
      [aged.at(-1), aged.at(-1), laterAged, laterAged],
    );
    assert.equal(await watermark(owner), laterAged);
  });

  test("runs the trimming with its owner's rights, a fixed search path, and only for the controller's role", async (context) => {
    const { owner } = await openSeededDatabase(context);

    const [definition] = await selectRows<{
      definer: boolean;
      owner: string;
      publicExecutes: boolean;
      settings: string[] | null;
    }>(
      owner,
      `SELECT function_.prosecdef AS definer, pg_get_userbyid(function_.proowner) AS owner, function_.proconfig AS settings,
              has_function_privilege('public', function_.oid, 'EXECUTE') AS "publicExecutes"
         FROM pg_proc function_ JOIN pg_namespace namespace ON namespace.oid = function_.pronamespace
        WHERE namespace.nspname = $1 AND function_.proname = $2`,
      [USHER_SCHEMA, POLICY_FUNCTIONS.trimNotices],
    );
    const executors = await selectRows<{ grantee: string }>(
      owner,
      `SELECT DISTINCT CASE privilege.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(privilege.grantee) END AS grantee
         FROM pg_proc function_
         JOIN pg_namespace namespace ON namespace.oid = function_.pronamespace
         CROSS JOIN LATERAL aclexplode(function_.proacl) privilege
        WHERE namespace.nspname = $1 AND function_.proname = $2 AND privilege.privilege_type = 'EXECUTE'`,
      [USHER_SCHEMA, POLICY_FUNCTIONS.trimNotices],
    );

    const searchPath = (definition?.settings ?? [])
      .filter((setting) => setting.startsWith(SEARCH_PATH))
      .flatMap((setting) => setting.slice(SEARCH_PATH.length).split(','))
      .map((schema) => schema.trim().replace(/^"(.*)"$/u, '$1'));

    assert.equal(definition?.definer, true);
    assert.equal(definition?.owner, DATABASE_ROLES.migration);
    assert.equal(definition?.publicExecutes, false);
    assert.deepEqual(
      {
        endsWithTemporarySchema: searchPath.at(-1) === 'pg_temp',
        holdsOnlyTrustedSchemas: searchPath.every((schema) =>
          TRUSTED_SCHEMAS.has(schema),
        ),
        namesUsherSchema: searchPath.includes(USHER_SCHEMA),
      },
      {
        endsWithTemporarySchema: true,
        holdsOnlyTrustedSchemas: true,
        namesUsherSchema: true,
      },
    );
    assert.deepEqual(
      executors.map(({ grantee }) => grantee).sort(),
      [DATABASE_ROLES.runtime, DATABASE_ROLES.migration].sort(),
    );
  });

  test("keeps the notices, the watermark and the retention floor out of the controller's reach but through the trimming", async (context) => {
    const database = await openDatabase(context);
    const owner = await database.connect('migration');
    const controller = await database.connect('runtime');
    const aged = await insertAged(owner, 'baseline', 900);
    const floorBefore = await selectRows(
      owner,
      `SELECT * FROM ${qualified(noticeRetention)}`,
    );

    const outcomes = await inTurn(
      [
        `DELETE FROM ${qualified(notices)} WHERE ${notices.columns.position} = ${aged.toString()}`,
        `UPDATE ${qualified(noticeStream)} SET ${noticeStream.columns.trimmedThrough} = ${aged.toString()}`,
        `UPDATE ${qualified(noticeRetention)} SET ${noticeRetention.columns.floorSeconds} = 1`,
        `INSERT INTO ${qualified(noticeRetention)} (${noticeRetention.columns.floorSeconds}) VALUES (1)`,
        `DELETE FROM ${qualified(noticeRetention)}`,
      ],
      (text) => writeOutcome(controller.query(text)),
    );
    const floorRead = await writeOutcome(
      controller.query(`SELECT * FROM ${qualified(noticeRetention)}`),
    );

    assert.deepEqual(outcomes, [
      INSUFFICIENT_PRIVILEGE,
      INSUFFICIENT_PRIVILEGE,
      INSUFFICIENT_PRIVILEGE,
      INSUFFICIENT_PRIVILEGE,
      INSUFFICIENT_PRIVILEGE,
    ]);
    assert.equal(floorRead, 'accepted');
    assert.deepEqual(
      await selectRows(owner, `SELECT * FROM ${qualified(noticeRetention)}`),
      floorBefore,
    );
    assert.deepEqual(
      (await noticesAfter(owner, aged - 1n)).map(({ position }) => position),
      [aged],
    );
  });
});
