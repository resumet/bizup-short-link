// 최고관리자 관리 쓰기 공통 처리 (PRD §16.2, §13.12)
// 멱등성 키 처리 권한 → 회사 쓰기 잠금 → 현재 owner 재확인 → 업무 변경 + 감사 기록 → 성공 응답 저장
import { hashRequest } from '@/lib/crypto';
import type { Db, Queryable } from '@/lib/db/types';
import { lockRequestScope, lockWorkspace } from '@/lib/db/locks';
import { AppError } from '@/lib/errors';
import { recheckPrincipal, type UserPrincipal } from '@/lib/auth/principal';
import { findSuccess, idemContext, idemScope, saveSuccess, type StoredResponse } from './idempotency';
import { consume, limits } from './ratelimit';

export interface AdminWriteOptions {
  method: string;
  route: string;
  idempotencyKey: string;
  /** 요청 해시에 포함할 값 (본문, If-Match 등) */
  hashInput: unknown;
  resultObjectType: string;
}

export async function runAdminWrite(
  db: Db,
  principal: UserPrincipal,
  opts: AdminWriteOptions,
  fn: (q: Queryable, owner: UserPrincipal) => Promise<StoredResponse & { objectId?: string | null }>,
): Promise<StoredResponse & { replayed: boolean }> {
  const idem = idemContext(principal, opts.method, opts.route, opts.idempotencyKey, hashRequest(opts.hashInput));
  const ensureOwner = async (q: Queryable) => {
    const p = await recheckPrincipal(q, principal);
    if (p.role !== 'owner') throw new AppError('INSUFFICIENT_PERMISSION');
    return p;
  };
  // 재생도 현재 owner 확인 후 수행한다
  await ensureOwner(db);
  const quick = await findSuccess(db, idem);
  if (quick) return { ...quick, replayed: true };
  await consume(db, limits.write(principal));

  return db.tx(async (q) => {
    await lockRequestScope(q, idemScope(idem));
    const replay = await findSuccess(q, idem);
    if (replay) {
      await ensureOwner(q);
      return { ...replay, replayed: true };
    }
    await lockWorkspace(q, principal.workspaceId);
    const owner = await ensureOwner(q);
    const { objectId, ...resp } = await fn(q, owner);
    await saveSuccess(q, idem, resp, { resultObjectType: opts.resultObjectType, resultObjectId: objectId ?? null });
    return { ...resp, replayed: false };
  });
}

export async function audit(
  q: Queryable,
  p: UserPrincipal,
  e: { objectType: string; objectId: string | null; action: string; before?: unknown; after?: unknown; reason?: string | null; requestId?: string },
): Promise<void> {
  await q.query(
    `insert into bzup.admin_audit_events
       (workspace_id, actor_type, actor_user_id, object_type, object_id, action, before_data, after_data, reason, request_id)
     values ($1,'user',$2,$3,$4,$5,$6::text::jsonb,$7::text::jsonb,$8,$9)`,
    [p.workspaceId, p.userId, e.objectType, e.objectId, e.action,
      e.before === undefined ? null : JSON.stringify(e.before), e.after === undefined ? null : JSON.stringify(e.after),
      e.reason ?? null, e.requestId ?? null],
  );
}
