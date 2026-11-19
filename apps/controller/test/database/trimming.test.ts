import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import pg from 'pg';

import {
  DATABASE_ROLES,
  TEMPLATE_RETENTION_FLOOR_SECONDS,
  USHER_SCHEMA,
} from '../../test-support/database.js';
import {
  INSUFFICIENT_PRIVILEGE,
  noticeStreamRows,
  openDatabase,
  openSeededDatabase,
  selectRows,
  writeOutcome,
} from '../../test-support/fixtures/database.js';
import {
  BOUNDED_TRIM_REFUSAL,
  inTurn,
  LOWEST_POSITION,
  noticesAfter,
  POLICY_FUNCTIONS,
  POLICY_TABLES,
  qualified,
  trimNoticesBounded,
} from '../../test-support/policy.js';
import { inTransactionAs } from '../../test-support/policy.js';

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

  test("runs each trimming, unbounded and bounded, with its owner's rights, a fixed search path, and only for the controller's role", async (context) => {
    const { owner } = await openSeededDatabase(context);

    const definitions = await selectRows<{
      arguments: string;
      definer: boolean;
      executors: string[];
      owner: string;
      publicExecutes: boolean;
      settings: string[] | null;
    }>(
      owner,
      `SELECT pg_get_function_identity_arguments(function_.oid) AS arguments, function_.prosecdef AS definer,
              pg_get_userbyid(function_.proowner) AS owner, function_.proconfig AS settings,
              has_function_privilege('public', function_.oid, 'EXECUTE') AS "publicExecutes",
              ARRAY(
                SELECT DISTINCT CASE privilege.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(privilege.grantee)::text END
                  FROM aclexplode(function_.proacl) privilege
                 WHERE privilege.privilege_type = 'EXECUTE'
                 ORDER BY 1
              ) AS executors
         FROM pg_proc function_ JOIN pg_namespace namespace ON namespace.oid = function_.pronamespace
        WHERE namespace.nspname = $1 AND function_.proname = $2
        ORDER BY 1`,
      [USHER_SCHEMA, POLICY_FUNCTIONS.trimNotices],
    );

    const searchPathOf = (settings: string[] | null): readonly string[] =>
      (settings ?? [])
        .filter((setting) => setting.startsWith(SEARCH_PATH))
        .flatMap((setting) => setting.slice(SEARCH_PATH.length).split(','))
        .map((schema) => schema.trim().replace(/^"(.*)"$/u, '$1'));

    assert.deepEqual(
      definitions.map((definition) => definition.arguments),
      ['', 'max_rows integer'],
    );
    definitions.forEach((definition) => {
      const searchPath = searchPathOf(definition.settings);
      assert.deepEqual(
        {
          definer: definition.definer,
          endsWithTemporarySchema: searchPath.at(-1) === 'pg_temp',
          executors: [...definition.executors].sort(),
          holdsOnlyTrustedSchemas: searchPath.every((schema) =>
            TRUSTED_SCHEMAS.has(schema),
          ),
          namesUsherSchema: searchPath.includes(USHER_SCHEMA),
          owner: definition.owner,
          publicExecutes: definition.publicExecutes,
        },
        {
          definer: true,
          endsWithTemporarySchema: true,
          executors: [DATABASE_ROLES.runtime, DATABASE_ROLES.migration].sort(),
          holdsOnlyTrustedSchemas: true,
          namesUsherSchema: true,
          owner: DATABASE_ROLES.migration,
          publicExecutes: false,
        },
        definition.arguments,
      );
    });
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
	test('trims by a floor lowered in the settings from the change that lowers it, with no restart', async (context) => {
		const database = await openDatabase(context);
		const owner = await database.connect('migration');
		await clearStream(owner);
		const controller = await database.connect('runtime');
		const notice = await insertAged(owner, 'baseline', 200);
		assert.deepEqual(await positionsHeld(owner), [notice]);

		await inTransactionAs(controller, { type: 'system' }, async () => {
			await controller.query("UPDATE usher.settings SET value = '30' WHERE name = 'tokenLifetimeSeconds'");
			await controller.query("UPDATE usher.settings SET value = '0' WHERE name = 'retentionGraceSeconds'");
			await controller.query("UPDATE usher.settings SET value = '0' WHERE name = 'retentionMarginSeconds'");
		});
		await trim(controller);

		assert.deepEqual(await positionsHeld(owner), []);
	});
});

// Ages past the floor of a database opened by default, and well within it.
const AGED_SECONDS = 2 * TEMPLATE_RETENTION_FLOOR_SECONDS;
const YOUNG_SECONDS = 10;

const insertAgedNotices = (
  client: pg.ClientBase,
  count: number,
): Promise<readonly bigint[]> =>
  inTurn(
    Array.from({ length: count }, () => 'baseline'),
    (kind) => insertAged(client, kind, AGED_SECONDS),
  );

suite(
  'trimming the notice stream a bounded number of notices at a time',
  () => {
    test('deletes at most the notices it is given, the oldest first, raising the watermark to the last it deleted', async (context) => {
      const database = await openDatabase(context);
      const owner = await database.connect('migration');
      await clearStream(owner);
      const controller = await database.connect('runtime');
      const aged = await insertAgedNotices(owner, 5);
      const young = await insertAged(owner, 'global', YOUNG_SECONDS);

      const returned = await trimNoticesBounded(controller, 2);

      assert.equal(returned, aged[1]);
      assert.equal(await watermark(owner), aged[1]);
      assert.deepEqual(await positionsHeld(owner), [...aged.slice(2), young]);
    });

    test('keeps every notice younger than the floor and every notice after the first of them, however large its bound', async (context) => {
      const database = await openDatabase(context);
      const owner = await database.connect('migration');
      await clearStream(owner);
      const controller = await database.connect('runtime');
      const firstAged = await insertAged(owner, 'baseline', AGED_SECONDS);
      const firstYoung = await insertAged(owner, 'global', YOUNG_SECONDS);
      const agedAfterYoung = await insertAged(owner, 'baseline', AGED_SECONDS);
      const lastYoung = await insertAged(owner, 'baseline', 0);

      const returned = await trimNoticesBounded(controller, 1000);

      assert.equal(returned, firstAged);
      assert.deepEqual(await positionsHeld(owner), [
        firstYoung,
        agedAfterYoung,
        lastYoung,
      ]);
    });

    test('never lowers the trim watermark, whichever trim raised it', async (context) => {
      const database = await openDatabase(context);
      const owner = await database.connect('migration');
      await clearStream(owner);
      const controller = await database.connect('runtime');
      const aged = await insertAgedNotices(owner, 3);

      const unbounded = await trim(controller);
      const boundedAfter = await trimNoticesBounded(controller, 1);
      const laterAged = await insertAged(owner, 'global', AGED_SECONDS);
      const boundedLater = await trimNoticesBounded(controller, 1);
      await insertAged(owner, 'baseline', YOUNG_SECONDS);
      const boundedOverYoung = await trimNoticesBounded(controller, 1);

      assert.deepEqual(
        [unbounded, boundedAfter, boundedLater, boundedOverYoung],
        [aged.at(-1), aged.at(-1), laterAged, laterAged],
      );
      assert.equal(await watermark(owner), laterAged);
    });

    test('drains a backlog over repeated calls, each deleting at most its bound', async (context) => {
      const database = await openDatabase(context);
      const owner = await database.connect('migration');
      await clearStream(owner);
      const controller = await database.connect('runtime');
      const aged = await insertAgedNotices(owner, 7);
      const young = await insertAged(owner, 'global', YOUNG_SECONDS);

      const calls = await inTurn([1, 2, 3, 4], async () => {
        const before = (await positionsHeld(owner)).length;
        const returned = await trimNoticesBounded(controller, 3);
        return {
          deleted: before - (await positionsHeld(owner)).length,
          returned,
        };
      });

      assert.deepEqual(calls, [
        { deleted: 3, returned: aged[2] },
        { deleted: 3, returned: aged[5] },
        { deleted: 1, returned: aged[6] },
        { deleted: 0, returned: aged[6] },
      ]);
      assert.deepEqual(await positionsHeld(owner), [young]);
    });

    test('refuses a bound below 1, or none, deleting nothing and leaving the watermark', async (context) => {
      const database = await openDatabase(context);
      const owner = await database.connect('migration');
      await clearStream(owner);
      const controller = await database.connect('runtime');
      const aged = await insertAgedNotices(owner, 2);
      const watermarkBefore = await watermark(owner);

      const refusals = await inTurn([0, -1, null], (maxRows) =>
        writeOutcome(trimNoticesBounded(controller, maxRows)),
      );

      assert.deepEqual(refusals, [
        BOUNDED_TRIM_REFUSAL,
        BOUNDED_TRIM_REFUSAL,
        BOUNDED_TRIM_REFUSAL,
      ]);
      assert.equal(await watermark(owner), watermarkBefore);
      assert.deepEqual(await positionsHeld(owner), aged);
    });

    test("lets the controller's role call it, which still deletes no notice itself", async (context) => {
      const database = await openDatabase(context);
      const owner = await database.connect('migration');
      await clearStream(owner);
      const controller = await database.connect('runtime');
      const [first, second] = await insertAgedNotices(owner, 2);

      const called = await writeOutcome(trimNoticesBounded(controller, 1));
      const deleted = await writeOutcome(
        controller.query(
          `DELETE FROM ${qualified(notices)} WHERE ${notices.columns.position} = ${String(second)}`,
        ),
      );

      assert.equal(called, 'accepted');
      assert.equal(deleted, INSUFFICIENT_PRIVILEGE);
      assert.equal(await watermark(owner), first);
      assert.deepEqual(await positionsHeld(owner), [second]);
    });
  },
);
