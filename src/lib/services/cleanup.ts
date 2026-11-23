// 만료 기록 정리. 짧은 배치를 반복해 긴 잠금을 피하고, 시간 예산 안에서 끝낸다.
// 정리 대상은 효력과 무관한 보관 기록이다: 만료 판정은 항상 조회 시점의 시각으로 하므로
// 정리가 늦어도 만료된 재시도 기록·토큰이 다시 유효해지지 않는다.
import type { Db } from '@/lib/db/types';

export interface CleanupResult {
  idempotency_deleted: number;
  reviews_deleted: number;
  rate_windows_deleted: number;
  rounds: number;
  finished: boolean;
}

export async function cleanupExpired(db: Db, opts: { batch?: number; timeBudgetMs?: number } = {}): Promise<CleanupResult> {
  const batch = opts.batch ?? 5000;
  const deadline = Date.now() + (opts.timeBudgetMs ?? 20_000);
  const total: CleanupResult = { idempotency_deleted: 0, reviews_deleted: 0, rate_windows_deleted: 0, rounds: 0, finished: false };
  for (;;) {
    const [r] = await db.query<{ idempotency_deleted: number; reviews_deleted: number; rate_windows_deleted: number }>(
      `select * from bzup.cleanup_expired($1)`,
      [batch],
    );
    total.rounds += 1;
    total.idempotency_deleted += Number(r.idempotency_deleted);
    total.reviews_deleted += Number(r.reviews_deleted);
    total.rate_windows_deleted += Number(r.rate_windows_deleted);
    const more = Number(r.idempotency_deleted) === batch || Number(r.reviews_deleted) === batch || Number(r.rate_windows_deleted) === batch;
    if (!more) {
      total.finished = true;
      return total;
    }
    if (Date.now() >= deadline) return total;
  }
}
