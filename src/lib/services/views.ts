// 링크 조회수 (일자별 KST + 총계). IP·User-Agent 는 저장하지 않는다.
import { AppError } from '@/lib/errors';
import { requirePermission, type Principal } from '@/lib/auth/principal';
import type { Queryable } from '@/lib/db/types';
import { toIso } from '@/lib/time';

/** 공개 이동 1회 기록 */
export async function recordView(q: Queryable, linkId: string): Promise<void> {
  await q.query(`select bzup.record_link_view($1)`, [linkId]);
}

export interface DailyViews {
  total_views: number;
  last_viewed_at: string | null;
  /** 오래된 날짜 → 최근 날짜, 조회가 없는 날은 0 으로 채움 */
  daily: { date: string; views: number }[];
}

export async function getDailyViews(q: Queryable, p: Principal, linkId: string, days = 30): Promise<DailyViews> {
  requirePermission(p, 'links:read');
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new AppError('VALIDATION_ERROR', 'days는 1~366 사이여야 합니다.');
  const own = await q.query(`select 1 from bzup.links where workspace_id = $1 and id = $2 and deleted_at is null`, [p.workspaceId, linkId]);
  if (!own.length) throw new AppError('NOT_FOUND');
  const rows = await q.query<{ date: string; views: number }>(
    `with today as (select (now() at time zone 'Asia/Seoul')::date as d)
     select to_char(g.d, 'YYYY-MM-DD') as date, coalesce(v.views, 0)::int as views
       from today, generate_series(today.d - ($2::int - 1), today.d, interval '1 day') as g(d)
       left join bzup.link_daily_views v on v.link_id = $1 and v.view_date = g.d::date
      order by g.d`,
    [linkId, days],
  );
  const [t] = await q.query<{ total_views: number; last_viewed_at: Date | null }>(
    `select total_views::int as total_views, last_viewed_at from bzup.link_view_totals where link_id = $1`,
    [linkId],
  );
  return {
    total_views: Number(t?.total_views ?? 0),
    last_viewed_at: toIso(t?.last_viewed_at ?? null),
    daily: rows.map((r) => ({ date: r.date, views: Number(r.views) })),
  };
}
