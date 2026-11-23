// 분산 호출 제한: PostgreSQL 공유 원자적 카운터, 고정 1분 윈도우 (PRD §17.2)
// 고정 윈도우 경계에서 최대 2배 연속 호출이 가능하다는 한계가 있다.
import { AppError } from '@/lib/errors';
import type { Db } from '@/lib/db/types';
import type { Principal } from '@/lib/auth/principal';

export interface Bucket {
  key: string;
  limit: number;
  amount?: number;
}

export async function consume(db: Db, buckets: Bucket[]): Promise<void> {
  if (buckets.length === 0) return;
  const over = await db.tx(async (q) => {
    let exceeded: { retryAfter: number } | null = null;
    for (const b of buckets) {
      const rows = await q.query<{ count: number; retry_after: number }>(
        `insert into bzup.rate_windows (bucket, window_start, count)
         values ($1, date_trunc('minute', clock_timestamp()), $2)
         on conflict (bucket, window_start) do update set count = bzup.rate_windows.count + excluded.count
         returning count,
           greatest(1, ceil(extract(epoch from (window_start + interval '1 minute' - clock_timestamp()))))::int as retry_after`,
        [b.key, b.amount ?? 1],
      );
      if (Number(rows[0].count) > b.limit) exceeded = { retryAfter: Number(rows[0].retry_after) };
    }
    return exceeded;
  });
  if (over) {
    throw new AppError('RATE_LIMITED', undefined, { headers: { 'Retry-After': String(over.retryAfter) } });
  }
}

function subject(p: Principal): string {
  return p.kind === 'user' ? `user:${p.userId}` : `client:${p.apiClientId}`;
}

export const limits = {
  write: (p: Principal): Bucket[] => [
    { key: `write:${subject(p)}`, limit: 60 },
    { key: `write:ws:${p.workspaceId}`, limit: 300 },
  ],
  newLinks: (p: Principal, n: number): Bucket[] => [
    { key: `links:${subject(p)}`, limit: 300, amount: n },
    { key: `links:ws:${p.workspaceId}`, limit: 1000, amount: n },
  ],
  preflight: (p: Principal): Bucket[] => [{ key: `preflight:${subject(p)}`, limit: 30 }],
  apiRead: (p: Principal): Bucket[] => (p.kind === 'api_client' ? [{ key: `read:${subject(p)}`, limit: 300 }] : []),
  export: (p: Principal): Bucket[] => [
    { key: `export:${subject(p)}`, limit: 3 },
    { key: `export:ws:${p.workspaceId}`, limit: 10 },
  ],
};
