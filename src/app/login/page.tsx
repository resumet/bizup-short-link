import Link from 'next/link';
import { getDb } from '@/lib/db/postgres';
import { isDevAuthEnabled } from '@/lib/auth/dev-auth';
import { safeNext } from '@/lib/auth/redirect';
import { AUTH_ERROR_TEXT } from '@/lib/auth/form-route';
import { loadUrlPolicy } from '@/lib/services/settings';
import { DevLoginForm } from '@/components/DevLoginForm';
import { SubmitButton } from '@/components/SubmitButton';

export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const dev = isDevAuthEnabled();
  const error = sp.error ? AUTH_ERROR_TEXT[sp.error] ?? AUTH_ERROR_TEXT.failed : null;

  let devAccounts: { email: string; display_name: string; role: string; status: string }[] = [];
  if (dev) {
    const db = getDb();
    const policy = await loadUrlPolicy(db);
    devAccounts = await db.query(
      `select email, display_name, role, status from bzup.workspace_members where workspace_id = $1
        order by case role when 'owner' then 0 when 'editor' then 1 else 2 end, status, email`,
      [policy.workspaceId],
    );
  }

  return (
    <main className="center">
      <div className="card narrow login-card">
        <h1>BZUP Link</h1>
        <p className="muted" style={{ margin: '0 0 1.25rem' }}>직원 계정으로 로그인해 주세요.</p>
        {error && <p className="error" role="alert">{error}</p>}
        {dev ? (
          <>
            <p><span className="badge-dev">로컬 개발 로그인 · 운영에서는 Supabase 로그인</span></p>
            <DevLoginForm next={next} accounts={devAccounts} />
          </>
        ) : (
          <>
            <form method="post" action="/auth/login" className="form">
              <input type="hidden" name="next" value={next} />
              <label>
                이메일
                <input name="email" type="email" required autoComplete="username" autoFocus />
              </label>
              <label>
                비밀번호
                <input name="password" type="password" required autoComplete="current-password" />
              </label>
              <SubmitButton>로그인</SubmitButton>
            </form>
            <p className="muted small" style={{ marginTop: '1rem' }}>
              <Link href="/login/forgot">비밀번호를 잊으셨나요?</Link>
              <br />
              계정이 없으면 최고관리자에게 초대를 요청해 주세요.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
