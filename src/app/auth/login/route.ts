// 직원 로그인 (BFF): 서버가 Supabase 세션을 발급해 HttpOnly 쿠키로 저장한다 (§3.1)
import { getDb } from '@/lib/db/postgres';
import { loadUrlPolicy } from '@/lib/services/settings';
import { memberForUser } from '@/lib/services/employees';
import { createSupabaseServer } from '@/lib/auth/supabase';
import { safeNext, sameOrigin } from '@/lib/auth/redirect';
import { seeOther, supabaseConfigured, withQuery } from '@/lib/auth/form-route';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return new Response('Forbidden', { status: 403 });
  const form = await req.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const password = String(form.get('password') ?? '');
  const next = safeNext(form.get('next'));
  const back = (error: string) => seeOther(req, withQuery('/login', { error, next: next === '/links' ? undefined : next }));

  if (!supabaseConfigured()) return back('unavailable');
  if (!email || !password) return back('invalid');

  const supabase = await createSupabaseServer();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    const status = (error as { status?: number } | null)?.status;
    return back(status !== undefined && status >= 500 ? 'unavailable' : 'invalid');
  }

  // Auth 로그인 성공만으로 접근을 허용하지 않는다: 회사 멤버십 확인 (§3.1)
  const db = getDb();
  const policy = await loadUrlPolicy(db);
  const member = await memberForUser(db, policy.workspaceId, data.user.id);
  if (!member || member.status === 'suspended') {
    await supabase.auth.signOut({ scope: 'local' });
    return back(member ? 'suspended' : 'not_member');
  }
  if (member.status !== 'active') return seeOther(req, '/account/setup');
  return seeOther(req, next);
}
