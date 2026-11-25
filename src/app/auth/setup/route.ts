// 초대받은 직원의 초기 설정: 비밀번호 설정 + 표시명 확인 → 멤버십 활성화 (§3.5-5, 6)
import { getDb } from '@/lib/db/postgres';
import { AppError } from '@/lib/errors';
import { loadUrlPolicy } from '@/lib/services/settings';
import { completeOnboarding, memberForUser } from '@/lib/services/employees';
import { createSupabaseServer } from '@/lib/auth/supabase';
import { sameOrigin } from '@/lib/auth/redirect';
import { passwordErrorCode, passwordProblem, seeOther, supabaseConfigured } from '@/lib/auth/form-route';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return new Response('Forbidden', { status: 403 });
  if (!supabaseConfigured()) return seeOther(req, '/login?error=unavailable');
  const form = await req.formData();
  const displayName = String(form.get('display_name') ?? '').trim();
  const password = String(form.get('password') ?? '');

  const supabase = await createSupabaseServer();
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) return seeOther(req, '/login?error=session');

  const db = getDb();
  const policy = await loadUrlPolicy(db);
  const member = await memberForUser(db, policy.workspaceId, u.user.id);
  if (!member) return seeOther(req, '/login?error=not_member');
  if (member.status === 'suspended') return seeOther(req, '/login?error=suspended');
  if (member.status === 'active') return seeOther(req, '/links');

  if (!displayName || [...displayName].length > 80) return seeOther(req, '/account/setup?error=name');
  // 메일 초대로 새로 만든 계정은 비밀번호가 없으므로 필수, 기존 계정은 선택
  if (member.status === 'invited' || password) {
    const problem = passwordProblem(password, String(form.get('password_confirm') ?? ''));
    if (problem) return seeOther(req, `/account/setup?error=${problem}`);
    const { error } = await supabase.auth.updateUser({ password });
    if (error && (error as { code?: string }).code !== 'same_password') {
      return seeOther(req, `/account/setup?error=${passwordErrorCode(error)}`);
    }
  }

  try {
    await completeOnboarding(db, policy.workspaceId, u.user.id, displayName);
  } catch (e) {
    if (e instanceof AppError && e.code === 'ACCESS_SUSPENDED') return seeOther(req, '/login?error=suspended');
    if (e instanceof AppError && e.code === 'VALIDATION_ERROR') return seeOther(req, '/account/setup?error=name');
    throw e;
  }
  return seeOther(req, '/links?notice=welcome');
}
