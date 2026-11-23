import { getDb } from '@/lib/db/postgres';
import { isDevAuthEnabled } from '@/lib/auth/dev-auth';
import { safeNext } from '@/lib/auth/redirect';
import { loadUrlPolicy } from '@/lib/services/settings';
import { DevLoginForm } from '@/components/DevLoginForm';

export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const dev = isDevAuthEnabled();

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
        {sp.error === 'invalid' && <p className="error" role="alert">이메일 또는 비밀번호를 확인해 주세요.</p>}
        {dev ? (
          <>
            <p><span className="badge-dev">로컬 개발 로그인 · 운영에서는 Supabase 로그인</span></p>
            <DevLoginForm next={next} accounts={devAccounts} />
          </>
        ) : (
          <p className="warn">Supabase 로그인 화면은 아직 연결되지 않았습니다. 관리자에게 문의해 주세요.</p>
        )}
      </div>
    </main>
  );
}
