// transaction-level advisory lock (PRD §16.2)
// 잠금 순서: 멱등성 키 처리 권한 → 코드 예약(생성만) → 회사 쓰기 잠금 → 업무 행 잠금
import { AppError } from '@/lib/errors';
import type { Queryable } from './types';

const LOCK_SPACE_WORKSPACE = 1;
const LOCK_SPACE_REQUEST = 2;

/** 회사 단위 쓰기 직렬화 잠금 */
export async function lockWorkspace(q: Queryable, workspaceId: string): Promise<void> {
  await q.query(`select pg_advisory_xact_lock($1::int, hashtext($2))`, [LOCK_SPACE_WORKSPACE, workspaceId]);
}

/**
 * 멱등성 요청 범위의 처리 권한. 최대 2초 대기 후 IDEMPOTENCY_IN_PROGRESS (§16.5).
 */
export async function lockRequestScope(q: Queryable, scope: string, waitMs = 2000): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const r = await q.query<{ ok: boolean }>(
      `select pg_try_advisory_xact_lock($1::int, hashtext($2)) as ok`,
      [LOCK_SPACE_REQUEST, scope],
    );
    if (r[0]?.ok) return;
    if (Date.now() >= deadline) {
      throw new AppError('IDEMPOTENCY_IN_PROGRESS', undefined, { headers: { 'Retry-After': '1' } });
    }
    await new Promise((res) => setTimeout(res, 100));
  }
}
