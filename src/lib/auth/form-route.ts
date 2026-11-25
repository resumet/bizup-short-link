import 'server-only';
// 인증 폼(POST) 공통: 같은 출처 확인, 303 리다이렉트 (경로는 항상 내부 상대 경로)
import { NextResponse } from 'next/server';

export function seeOther(req: Request, path: string): NextResponse {
  const res = NextResponse.redirect(new URL(path, req.url), 303);
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
}

export function withQuery(path: string, q: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `${path}?${s}` : path;
}

export function supabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY);
}

export const MIN_PASSWORD = 8;

/** 비밀번호 확인: 문제 없으면 null, 아니면 오류 코드 */
export function passwordProblem(pw: string, confirm: string): string | null {
  if (pw.length < MIN_PASSWORD) return 'password_short';
  if (pw.length > 72) return 'password_long';
  if (pw !== confirm) return 'password_mismatch';
  return null;
}

export const AUTH_ERROR_TEXT: Record<string, string> = {
  invalid: '이메일 또는 비밀번호를 확인해 주세요.',
  not_member: '이 서비스의 직원으로 등록되지 않은 계정입니다. 최고관리자에게 초대를 요청해 주세요.',
  suspended: '접근이 중지된 계정입니다. 최고관리자에게 문의해 주세요.',
  link: '링크가 만료되었거나 이미 사용되었습니다. 다시 요청해 주세요.',
  unavailable: '로그인 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.',
  session: '로그인이 필요합니다. 다시 로그인해 주세요.',
  password_short: `비밀번호는 ${MIN_PASSWORD}자 이상으로 입력해 주세요.`,
  password_long: '비밀번호는 72자 이하로 입력해 주세요.',
  password_mismatch: '비밀번호 확인이 일치하지 않습니다.',
  password_weak: '비밀번호가 보안 기준에 맞지 않습니다. 더 길거나 복잡한 비밀번호를 사용해 주세요.',
  password_same: '이전과 다른 비밀번호를 입력해 주세요.',
  name: '이름을 1~80자로 입력해 주세요.',
  failed: '처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
};

/** Supabase updateUser 오류 → 화면 오류 코드 */
export function passwordErrorCode(error: unknown): string {
  const code = (error as { code?: string })?.code ?? '';
  if (code === 'weak_password') return 'password_weak';
  if (code === 'same_password') return 'password_same';
  return 'failed';
}
