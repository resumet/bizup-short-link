// 이메일 링크 확인 (초대·비밀번호 재설정) (§3.5)
// Supabase 이메일 템플릿: {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite (재설정은 type=recovery)
//
// GET 은 토큰을 쓰지 않는다. 메일 보안 검사기(Outlook Safe Links, 사내 메일 게이트웨이 등)가 링크를 미리 열면
// 1회용 토큰이 사용돼 직원이 눌렀을 때 '만료된 링크'가 되므로, 확인 화면(/login/confirm)으로 보내고
// 사람이 버튼을 눌러 POST 할 때만 검증한다.
import type { EmailOtpType } from '@supabase/supabase-js';
import { createSupabaseServer } from '@/lib/auth/supabase';
import { safeNext, sameOrigin } from '@/lib/auth/redirect';
import { seeOther, supabaseConfigured, withQuery } from '@/lib/auth/form-route';

export const dynamic = 'force-dynamic';

const OTP_TYPES: EmailOtpType[] = ['invite', 'recovery', 'signup', 'email', 'magiclink', 'email_change'];

function afterVerify(req: Request, type: string | null, next: string | null) {
  if (type === 'recovery') return seeOther(req, '/account/password');
  if (type === 'invite') return seeOther(req, '/account/setup');
  return seeOther(req, safeNext(next));
}

export async function GET(req: Request) {
  if (!supabaseConfigured()) return seeOther(req, '/login?error=unavailable');
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  if (code && !url.searchParams.get('token_hash')) {
    // PKCE 흐름(같은 브라우저에서 요청한 비밀번호 재설정 등): code_verifier 쿠키가 있어야 하므로 검사기가 쓸 수 없다
    const supabase = await createSupabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return seeOther(req, '/login?error=link');
    return afterVerify(req, null, url.searchParams.get('next'));
  }
  // token_hash 링크, 또는 Supabase 기본 템플릿({{ .ConfirmationURL }})이 #access_token 을 붙여 보낸 경우:
  // 확인 화면으로 넘긴다 (# 부분은 리다이렉트 후에도 브라우저가 유지)
  return seeOther(req, withQuery('/login/confirm', {
    token_hash: url.searchParams.get('token_hash') ?? undefined,
    type: url.searchParams.get('type') ?? undefined,
    next: url.searchParams.get('next') ?? undefined,
  }));
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return new Response('Forbidden', { status: 403 });
  if (!supabaseConfigured()) return seeOther(req, '/login?error=unavailable');
  const form = await req.formData();
  const field = (k: string) => {
    const v = form.get(k);
    return typeof v === 'string' && v ? v : null;
  };
  const type = field('type');
  const next = field('next');
  const supabase = await createSupabaseServer();

  const tokenHash = field('token_hash');
  const accessToken = field('access_token');
  const refreshToken = field('refresh_token');
  let ok = false;
  if (tokenHash && type && OTP_TYPES.includes(type as EmailOtpType)) {
    const { error } = await supabase.auth.verifyOtp({ type: type as EmailOtpType, token_hash: tokenHash });
    ok = !error;
  } else if (accessToken && refreshToken) {
    // Supabase 기본 템플릿: Supabase 가 이미 검증하고 # 로 넘긴 세션 토큰
    const { error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    ok = !error;
  }
  if (!ok) return seeOther(req, '/login?error=link');
  return afterVerify(req, type, next);
}
