// 비밀번호 재설정 메일 요청. 계정 존재 여부를 노출하지 않도록 결과와 관계없이 같은 안내를 보여준다.
import { getDb } from '@/lib/db/postgres';
import { loadUrlPolicy, originFor } from '@/lib/services/settings';
import { createSupabaseServer } from '@/lib/auth/supabase';
import { sameOrigin } from '@/lib/auth/redirect';
import { seeOther, supabaseConfigured } from '@/lib/auth/form-route';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return new Response('Forbidden', { status: 403 });
  if (!supabaseConfigured()) return seeOther(req, '/login/forgot?error=unavailable');
  const form = await req.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  if (email) {
    const policy = await loadUrlPolicy(getDb());
    const supabase = await createSupabaseServer();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${originFor(policy.primaryHost)}/auth/confirm?next=/account/password`,
    });
    if (error && (error as { status?: number }).status === 429) return seeOther(req, '/login/forgot?error=rate');
  }
  return seeOther(req, '/login/forgot?sent=1');
}
