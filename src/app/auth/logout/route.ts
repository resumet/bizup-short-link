// 현재 호스트의 세션 종료 (§20.6)
import { DEV_SESSION_COOKIE } from '@/lib/auth/dev-auth';
import { sameOrigin } from '@/lib/auth/redirect';
import { createSupabaseServer } from '@/lib/auth/supabase';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return new Response('Forbidden', { status: 403 });
  if (process.env.SUPABASE_URL) {
    try {
      const supabase = await createSupabaseServer();
      await supabase.auth.signOut({ scope: 'local' });
    } catch {
      // 세션이 없어도 로그아웃은 완료로 처리
    }
  }
  const headers = new Headers({ Location: '/login', 'Cache-Control': 'private, no-store' });
  headers.append('Set-Cookie', `${DEV_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return new Response(null, { status: 303, headers });
}
