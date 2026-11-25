import { redirect } from 'next/navigation';
import { getDb } from '@/lib/db/postgres';
import { loadUrlPolicy } from '@/lib/services/settings';
import { memberForUser } from '@/lib/services/employees';
import { createSupabaseServer } from '@/lib/auth/supabase';
import { AUTH_ERROR_TEXT, MIN_PASSWORD, supabaseConfigured } from '@/lib/auth/form-route';
import { AccessDenied } from '@/components/TopBar';
import { SubmitButton } from '@/components/SubmitButton';

export const dynamic = 'force-dynamic';

// 초대 수락 후 초기 설정 (§3.5)
export default async function SetupPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  if (!supabaseConfigured()) redirect('/login');
  const supabase = await createSupabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect('/login?error=session');

  const db = getDb();
  const policy = await loadUrlPolicy(db);
  const member = await memberForUser(db, policy.workspaceId, data.user.id);
  if (!member) return <AccessDenied message="이 서비스의 직원으로 등록되지 않은 계정입니다. 최고관리자에게 초대를 요청해 주세요." />;
  if (member.status === 'suspended') return <AccessDenied message="접근이 중지된 계정입니다." />;
  if (member.status === 'active') redirect('/links');

  const needPassword = member.status === 'invited';
  const error = sp.error ? AUTH_ERROR_TEXT[sp.error] ?? AUTH_ERROR_TEXT.failed : null;
  return (
    <main className="center">
      <div className="card narrow login-card">
        <h1>BZUP Link 시작하기</h1>
        <p className="muted" style={{ margin: '0 0 1.25rem' }}>
          {needPassword ? '이름을 확인하고 로그인에 사용할 비밀번호를 설정해 주세요.' : '이름을 확인하면 가입이 완료됩니다. 비밀번호는 기존 계정 그대로 사용할 수 있습니다.'}
        </p>
        {error && <p className="error" role="alert">{error}</p>}
        <form method="post" action="/auth/setup" className="form">
          <label>
            이메일
            <input type="email" value={data.user.email ?? member.email} readOnly autoComplete="username" />
          </label>
          <label>
            이름
            <input name="display_name" defaultValue={member.display_name} required maxLength={80} />
          </label>
          <label>
            {needPassword ? '비밀번호' : '새 비밀번호 (선택)'}
            <input name="password" type="password" required={needPassword} minLength={MIN_PASSWORD} maxLength={72} autoComplete="new-password" />
          </label>
          <label>
            비밀번호 확인
            <input name="password_confirm" type="password" required={needPassword} minLength={MIN_PASSWORD} maxLength={72} autoComplete="new-password" />
          </label>
          <SubmitButton>가입 완료</SubmitButton>
        </form>
      </div>
    </main>
  );
}
