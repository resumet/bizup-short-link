// 새 비밀번호 설정 (재설정 메일 링크로 로그인한 세션)
import { getDb } from '@/lib/db/postgres';
import { loadUrlPolicy } from '@/lib/services/settings';
import { memberForUser } from '@/lib/services/employees';
import { createSupabaseServer } from '@/lib/auth/supabase';
import { sameOrigin } from '@/lib/auth/redirect';
import { passwordErrorCode, passwordProblem, seeOther, supabaseConfigured } from '@/lib/auth/form-route';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return new Response('Forbidden', { status: 403 });
  if (!supabaseConfigured()) return seeOther(req, '/login?error=unavailable');
  const form = await req.formData();
  const password = String(form.get('password') ?? '');
  const problem = passwordProblem(password, String(form.get('password_confirm') ?? ''));
  if (problem) return seeOther(req, `/account/password?error=${problem}`);

  const supabase = await createSupabaseServer();
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) return seeOther(req, '/login?error=session');
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return seeOther(req, `/account/password?error=${passwordErrorCode(error)}`);

  const db = getDb();
  const member = await memberForUser(db, (await loadUrlPolicy(db)).workspaceId, u.user.id);
  if (member && (member.status === 'invited' || member.status === 'onboarding')) return seeOther(req, '/account/setup');
  return seeOther(req, '/links?notice=password_changed');
}
