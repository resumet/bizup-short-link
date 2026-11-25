// 이메일 링크 확인 (초대·비밀번호 재설정): token_hash 를 서버에서 검증해 세션을 만든다 (§3.5)
// Supabase 이메일 템플릿: {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite (재설정은 type=recovery)
import type { EmailOtpType } from '@supabase/supabase-js';
import { createSupabaseServer } from '@/lib/auth/supabase';
import { safeNext } from '@/lib/auth/redirect';
import { seeOther, supabaseConfigured } from '@/lib/auth/form-route';

export const dynamic = 'force-dynamic';

const OTP_TYPES: EmailOtpType[] = ['invite', 'recovery', 'signup', 'email', 'magiclink', 'email_change'];

export async function GET(req: Request) {
  if (!supabaseConfigured()) return seeOther(req, '/login?error=unavailable');
  const url = new URL(req.url);
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type') as EmailOtpType | null;
  const code = url.searchParams.get('code');
  const supabase = await createSupabaseServer();

  let ok = false;
  if (tokenHash && type && OTP_TYPES.includes(type)) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    ok = !error;
  } else if (code) {
    // PKCE 흐름(같은 브라우저에서 요청한 비밀번호 재설정 등)
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    ok = !error;
  }
  if (!ok) return seeOther(req, '/login?error=link');

  if (type === 'recovery') return seeOther(req, '/account/password');
  if (type === 'invite') return seeOther(req, '/account/setup');
  return seeOther(req, safeNext(url.searchParams.get('next')));
}
