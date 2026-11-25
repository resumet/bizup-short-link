import Link from 'next/link';
import { AUTH_ERROR_TEXT } from '@/lib/auth/form-route';
import { SubmitButton } from '@/components/SubmitButton';

export const dynamic = 'force-dynamic';

export default async function ForgotPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const error = sp.error === 'rate'
    ? '요청이 많습니다. 잠시 후 다시 시도해 주세요.'
    : sp.error ? AUTH_ERROR_TEXT[sp.error] ?? AUTH_ERROR_TEXT.failed : null;
  return (
    <main className="center">
      <div className="card narrow login-card">
        <h1>비밀번호 재설정</h1>
        {sp.sent ? (
          <p className="ok" role="status">
            입력한 이메일이 등록된 계정이면 재설정 메일이 발송됩니다. 메일의 링크를 눌러 새 비밀번호를 설정해 주세요.
          </p>
        ) : (
          <>
            <p className="muted" style={{ margin: '0 0 1.25rem' }}>로그인 이메일을 입력하면 재설정 링크를 보내 드립니다.</p>
            {error && <p className="error" role="alert">{error}</p>}
            <form method="post" action="/auth/forgot" className="form">
              <label>
                이메일
                <input name="email" type="email" required autoComplete="username" autoFocus />
              </label>
              <SubmitButton>재설정 메일 받기</SubmitButton>
            </form>
          </>
        )}
        <p className="muted small" style={{ marginTop: '1rem' }}><Link href="/login">로그인으로 돌아가기</Link></p>
      </div>
    </main>
  );
}
