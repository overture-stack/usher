import pg from 'pg';

import { ControllerError } from '../failures/index.js';
import type {
  NoticePage,
  NoticeReader,
  StoredNotice,
  StreamPlace,
} from '../noticeChannel/index.js';
import type { NoticeStore } from './types.js';

interface HeadRow {
  epoch: string;
  newestCreatedAt: string | null;
  newestPosition: string | null;
  trimmedThrough: string;
}

interface NoticeRow {
  audience: string | null;
  createdAt: string;
  kind: string;
  position: string;
  resource: string | null;
  servedBy: readonly string[] | null;
  subject: string | null;
}

interface PageRow extends HeadRow {
  createdAtPosition: string | null;
  notices: readonly NoticeRow[];
}

/**
 * The stream's one row is missing, so no read can say what history reaches. Its `code` names it on a
 * log line.
 */
export class NoticeStreamMissing extends ControllerError {
  readonly code = 'noticeStreamMissing';
  override readonly name = 'NoticeStreamMissing';
  constructor() {
    super('the notice stream holds no row');
  }
}

// An instant as microseconds since the Unix epoch, exactly: extract gives a numeric, never a float.
const microseconds = (column: string): string =>
  `(extract(epoch FROM ${column}) * 1000000)::bigint::text`;

const placeOfHead = ({
  epoch,
  newestCreatedAt,
  newestPosition,
  trimmedThrough,
}: HeadRow): StreamPlace =>
  newestPosition === null || newestCreatedAt === null
    ? { createdAt: undefined, epoch, position: BigInt(trimmedThrough) }
    : {
        createdAt: BigInt(newestCreatedAt),
        epoch,
        position: BigInt(newestPosition),
      };

const storedNotice = (row: NoticeRow): StoredNotice => {
  const base = {
    createdAt: BigInt(row.createdAt),
    position: BigInt(row.position),
  };
  if (row.kind === 'principal' && row.subject !== null) {
    return { ...base, kind: 'principal', subject: row.subject };
  }
  if (row.kind === 'category' && row.resource !== null) {
    return {
      ...base,
      kind: 'category',
      resource: row.resource,
      servedBy: row.servedBy ?? [],
    };
  }
  if (row.kind === 'servedResources' && row.audience !== null) {
    return { ...base, audience: row.audience, kind: 'servedResources' };
  }
  if (row.kind === 'baseline' || row.kind === 'global') {
    return { ...base, kind: row.kind };
  }
  throw new TypeError('a stored notice is of no kind the stream carries');
};

/**
 * Creates the reader of the notice stream. A page is read after a position, oldest first, in one
 * statement with the stream's epoch, its trim watermark, its head and the notice at the position, so
 * all of them come from one snapshot: notice writes are serialized, so no notice can later commit
 * below a position the snapshot shows committed. Read for an audience, a page holds every principal,
 * baseline and global notice, the servedResources notices naming that audience, and the category
 * notices naming a resource the audience serves as the page is read; each category notice carries the
 * applications serving its resource then. A page holds at most its limit, and says whether more wait.
 *
 * @param store the reader every statement runs through, within the store timeout.
 * @param schema the controller's schema.
 */
export const createNoticeReader = (
  store: NoticeStore,
  schema: string,
): NoticeReader => {
  const table = (name: string): string =>
    `${pg.escapeIdentifier(schema)}.${name}`;

  const newest = `LEFT JOIN LATERAL (
      SELECT newest_notice.position, ${microseconds('newest_notice.created_at')} AS created_at
        FROM ${table('notices')} newest_notice
       ORDER BY newest_notice.position DESC LIMIT 1
    ) newest ON true`;

  const headStatement = `SELECT stream.epoch::text AS epoch, stream.trimmed_through::text AS "trimmedThrough",
         newest.position::text AS "newestPosition", newest.created_at AS "newestCreatedAt"
    FROM ${table('notice_stream')} stream
    ${newest}`;

  // $1 the position read after, $2 how many rows to read, $3 the audience, or null for every one.
  const pageStatement = `WITH page AS (
      SELECT notice.position, notice.kind, notice.idp_subject_id, notice.resource_external_id,
             notice.audience, notice.created_at
        FROM ${table('notices')} notice
       WHERE notice.position > $1::bigint
         AND ($3::uuid IS NULL
           OR notice.kind IN ('baseline', 'global', 'principal')
           OR (notice.kind = 'servedResources' AND notice.audience = $3::uuid)
           OR (notice.kind = 'category' AND EXISTS (
                SELECT 1 FROM ${table('application_resources')} served
                  JOIN ${table('resources')} resource ON resource.id = served.resource_id
                 WHERE served.application_id = $3::uuid
                   AND resource.external_id = notice.resource_external_id)))
       ORDER BY notice.position
       LIMIT $2::int
    ), serving AS (
      SELECT resource.external_id,
             array_agg(served.application_id::text ORDER BY served.application_id) AS audiences
        FROM ${table('resources')} resource
        JOIN ${table('application_resources')} served ON served.resource_id = resource.id
       WHERE resource.external_id IN (SELECT page.resource_external_id FROM page)
       GROUP BY resource.external_id
    )
    SELECT stream.epoch::text AS epoch, stream.trimmed_through::text AS "trimmedThrough",
           newest.position::text AS "newestPosition", newest.created_at AS "newestCreatedAt",
           (SELECT ${microseconds('at_position.created_at')} FROM ${table('notices')} at_position
             WHERE at_position.position = $1::bigint) AS "createdAtPosition",
           coalesce((
             SELECT json_agg(json_build_object(
                      'audience', page.audience::text,
                      'createdAt', ${microseconds('page.created_at')},
                      'kind', page.kind,
                      'position', page.position::text,
                      'resource', page.resource_external_id,
                      'servedBy', serving.audiences,
                      'subject', page.idp_subject_id
                    ) ORDER BY page.position)
               FROM page LEFT JOIN serving ON serving.external_id = page.resource_external_id
           ), '[]'::json) AS notices
      FROM ${table('notice_stream')} stream
      ${newest}`;

  return {
    after: async (position, { audience, limit }) => {
      const [row] = (
        await store.query<PageRow>(pageStatement, [
          position.toString(),
          limit + 1,
          audience ?? null,
        ])
      ).rows;
      if (row === undefined) {
        throw new NoticeStreamMissing();
      }
      const notices = row.notices.map(storedNotice);
      return {
        createdAtPosition:
          row.createdAtPosition === null
            ? undefined
            : BigInt(row.createdAtPosition),
        epoch: row.epoch,
        head: placeOfHead(row),
        more: notices.length > limit,
        notices: notices.slice(0, limit),
        trimmedThrough: BigInt(row.trimmedThrough),
      };
    },

    head: async () => {
      const [row] = (await store.query<HeadRow>(headStatement)).rows;
      if (row === undefined) {
        throw new NoticeStreamMissing();
      }
      return placeOfHead(row);
    },
  };
};
