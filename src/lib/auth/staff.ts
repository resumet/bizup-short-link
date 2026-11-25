import 'server-only';
import { cookies } from 'next/headers';
import { AppError } from '@/lib/errors';
import { constantTimeEqual } from '@/lib/crypto';
import type { Db } from '@/lib/db/types';
import { loadUrlPolicy, normalizeRequestHost } from '@/lib/services/settings';
import { createSupabaseServer } from './supabase';
import { evaluateAccess, type MemberState } from './access';
import type { UserPrincipal } from './principal';
import { DEV_SESSION_COOKIE, isDevAuthEnabled, readDevSession } from './dev-auth';

export const CSRF_COOKIE = 'bzup_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export interface AuthUser {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
  last_sign_in_at?: string | null;
  banned_until?: string | null;
}

/** 현재 요청의 인증 사용자. 로컬 개발 로그인이 켜져 있으면 개발 세션을 사용한다. */
export async function currentAuthUser(): Promise<AuthUser> {
  if (isDevAuthEnabled()) {
    const store = await cookies();
    const uid = readDevSession(store.get(DEV_SESSION_COOKIE)?.value);
    if (!uid) throw new AppError('UNAUTHENTICATED');
    // 개발 계정은 이메일 확인 완료로 간주한다. 멤버십 판정은 실제와 동일.
    return { id: uid, email_confirmed_at: new Date(0).toISOString(), banned_until: null };
  }
  if (!process.env.SUPABASE_URL) throw new AppError('UNAUTHENTICATED');
  const supabase = await createSupabaseServer();
  // getUser 는 Auth 서버에 토큰을 검증 요청하므로 삭제·차단을 반영한다.
  const { data, error } = await supabase.auth.getUser();
  if (error) {
    const status = (error as { status?: number }).status;
    if (status === undefined || status >= 500) throw new AppError('SERVICE_UNAVAILABLE', '로그인 가능 여부를 확인할 수 없습니다.');
    throw new AppError('UNAUTHENTICATED');
  }
  if (!data.user) throw new AppError('UNAUTHENTICATED');
  return data.user as AuthUser;
}

/**
 * 직원 세션 인증. Auth 계정 존재만으로 허용하지 않고 회사 멤버십을 함께 확인한다 (§3.1, §3.4).
 * user_metadata 는 권한 근거로 사용하지 않는다.
 */
export async function requireStaff(db: Db, req?: Request): Promise<UserPrincipal> {
  if (req && !['GET', 'HEAD'].includes(req.method)) await assertCsrf(db, req);

  const user = await currentAuthUser();

  const policy = await loadUrlPolicy(db);
  const rows = await db.query<MemberState & { id: string; display_name: string }>(
    `select id, role, status, display_name from bzup.workspace_members where workspace_id = $1 and user_id = $2`,
    [policy.workspaceId, user.id],
  );
  const member = rows[0] ?? null;
  const decision = evaluateAccess(
    {
      id: user.id,
      email: user.email ?? null,
      email_confirmed_at: user.email_confirmed_at ?? null,
      banned_until: (user as { banned_until?: string | null }).banned_until ?? null,
      last_sign_in_at: user.last_sign_in_at ?? null,
    },
    member,
  );
  if (decision.canLogin !== 'yes') {
    if (decision.reason === 'suspended') throw new AppError('ACCESS_SUSPENDED');
    if (decision.reason === 'not_member') throw new AppError('INSUFFICIENT_PERMISSION', '이 서비스의 직원으로 등록되지 않았습니다.');
    throw new AppError('INSUFFICIENT_PERMISSION', '초대를 수락하고 초기 설정을 완료해 주세요.', { details: { reason: decision.reason } });
  }
  return {
    kind: 'user',
    workspaceId: policy.workspaceId,
    userId: user.id,
    memberId: member!.id,
    role: member!.role,
    displayName: member!.display_name,
  };
}

/**
 * 쿠키 기반 변경 요청의 CSRF 방어 (§18.3):
 * Origin 이 요청을 받은 호스트와 같고 등록된 active 호스트여야 하며, 이중 제출 토큰이 일치해야 한다.
 */
export async function assertCsrf(db: Db, req: Request): Promise<void> {
  const host = normalizeRequestHost(req.headers.get('host'));
  const origin = req.headers.get('origin');
  if (!host || !origin) throw new AppError('CSRF_REJECTED');
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    throw new AppError('CSRF_REJECTED');
  }
  if (originHost !== host) throw new AppError('CSRF_REJECTED');
  // 운영: 등록된 active 호스트만. 로컬 개발(DEV_AUTH): 127.0.0.1·다른 포트·내부망 IP 접속도 허용
  // (Origin == Host 와 이중 제출 토큰 검사는 그대로 적용)
  if (!isDevAuthEnabled()) {
    const policy = await loadUrlPolicy(db);
    if (!policy.activeHosts.includes(host)) throw new AppError('CSRF_REJECTED');
  }

  const store = await cookies();
  const cookie = store.get(CSRF_COOKIE)?.value ?? '';
  const header = req.headers.get(CSRF_HEADER) ?? '';
  if (!cookie || !header || !constantTimeEqual(Buffer.from(cookie), Buffer.from(header))) {
    throw new AppError('CSRF_REJECTED');
  }
}
