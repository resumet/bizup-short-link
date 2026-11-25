import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createSupabaseServer } from '@/lib/auth/supabase';
import { AUTH_ERROR_TEXT, MIN_PASSWORD, supabaseConfigured } from '@/lib/auth/form-route';
import { SubmitButton } from '@/components/SubmitButton';

export const dynamic = 'force-dynamic';

// 새 비밀번호 설정 (재설정 메일 링크 또는 로그인 상태에서 변경)
export default async function PasswordPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  if (!supabaseConfigured()) redirect('/login');
  const supabase = await createSupabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect('/login?error=session');
  const error = sp.error ? AUTH_ERROR_TEXT[sp.error] ?? AUTH_ERROR_TEXT.failed : null;
  return (
    <main className="center">
      <div className="card narrow login-card">
        <h1>새 비밀번호 설정</h1>
        <p className="muted" style={{ margin: '0 0 1.25rem' }}>{data.user.email}</p>
        {error && <p className="error" role="alert">{error}</p>}
        <form method="post" action="/auth/password" className="form">
          <input type="email" value={data.user.email ?? ''} readOnly autoComplete="username" hidden />
          <label>
            새 비밀번호
            <input name="password" type="password" required minLength={MIN_PASSWORD} maxLength={72} autoComplete="new-password" autoFocus />
          </label>
          <label>
            비밀번호 확인
            <input name="password_confirm" type="password" required minLength={MIN_PASSWORD} maxLength={72} autoComplete="new-password" />
          </label>
          <SubmitButton>비밀번호 저장</SubmitButton>
        </form>
        <p className="muted small" style={{ marginTop: '1rem' }}><Link href="/links">링크 목록으로</Link></p>
      </div>
    </main>
  );
}
