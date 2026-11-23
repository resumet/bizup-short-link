import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// BFF: 브라우저에는 Supabase 클라이언트를 만들지 않는다. 세션 쿠키는 서버가 발급·갱신하며
// 현재 호스트 한정(Domain 미지정), Secure·HttpOnly·SameSite=Lax (§3.1, §18.3).

export const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
};

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured`);
  return v;
}

/** 요청별 인증 클라이언트. 요청 간 공유하지 않는다. */
export async function createSupabaseServer(): Promise<SupabaseClient> {
  const store = await cookies();
  return createServerClient(env('SUPABASE_URL'), env('SUPABASE_PUBLISHABLE_KEY'), {
    cookieOptions: AUTH_COOKIE_OPTIONS,
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const c of list) store.set(c.name, c.value, { ...c.options, ...AUTH_COOKIE_OPTIONS });
        } catch {
          // Server Component 렌더링 중에는 쿠키를 쓸 수 없다. 미들웨어가 갱신을 담당한다.
        }
      },
    },
  });
}

/** 서버 전용 Auth Admin 클라이언트. 고권한 비밀키는 브라우저로 전달하지 않는다 (§3.7). */
export function createSupabaseAdmin(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SECRET_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
