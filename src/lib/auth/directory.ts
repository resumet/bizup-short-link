import 'server-only';
// Auth 계정 조회·초대 구현 (§3.5, §3.7). 서버에서만 Auth Admin 을 호출한다.
import { randomUUID } from 'node:crypto';
import type { Db } from '@/lib/db/types';
import type { AuthUserState } from './access';
import { isDevAuthEnabled } from './dev-auth';
import { createSupabaseAdmin } from './supabase';
import { InviteDeliveryError, type AuthDirectory } from '@/lib/services/employees';

/** Supabase Auth Admin */
function supabaseDirectory(db: Db): AuthDirectory {
  return {
    async getUsers(ids) {
      const admin = createSupabaseAdmin();
      const out = new Map<string, AuthUserState | null>();
      const results = await Promise.all(ids.map((id) => admin.auth.admin.getUserById(id)));
      for (let i = 0; i < ids.length; i++) {
        const { data, error } = results[i];
        if (error) {
          // 계정 없음(404)만 '없음', 그 외 실패는 추측하지 않는다
          if ((error as { status?: number }).status === 404) { out.set(ids[i], null); continue; }
          return 'error';
        }
        const u = data.user as typeof data.user & { banned_until?: string | null };
        out.set(ids[i], {
          id: u.id,
          email: u.email ?? null,
          email_confirmed_at: u.email_confirmed_at ?? null,
          banned_until: u.banned_until ?? null,
          last_sign_in_at: u.last_sign_in_at ?? null,
        });
      }
      return out;
    },

    async invite(email, redirectTo) {
      const admin = createSupabaseAdmin();
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
      if (!error && data.user) return { userId: data.user.id, existing: false };
      const code = (error as { code?: string } | null)?.code ?? '';
      const status = (error as { status?: number } | null)?.status;
      if (code === 'email_exists' || status === 422) {
        // 이미 있는 Auth 계정: UUID 를 확인해 멤버십만 연결한다. 비밀번호 초기화·재생성으로 해결하지 않는다 (§3.5)
        const rows = await db.query<{ id: string }>(`select id from auth.users where lower(email) = $1 limit 1`, [email]);
        if (rows[0]) return { userId: rows[0].id, existing: true };
      }
      throw new InviteDeliveryError(code || `status_${status ?? 'unknown'}`);
    },
  };
}

/** 로컬 개발: 메일 발송 없이 바로 활성 직원으로 등록 (개발 로그인으로 접속) */
const devDirectory: AuthDirectory = {
  async getUsers(ids) {
    return new Map(ids.map((id) => [id, {
      id, email: null, email_confirmed_at: new Date(0).toISOString(), banned_until: null, last_sign_in_at: null,
    }]));
  },
  async invite() {
    return { userId: randomUUID(), existing: false, autoAccept: true };
  },
};

export function authDirectory(db: Db): AuthDirectory {
  return isDevAuthEnabled() ? devDirectory : supabaseDirectory(db);
}
