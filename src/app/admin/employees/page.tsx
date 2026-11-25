import { staffForPage } from '@/lib/auth/page-staff';
import { AccessDenied, TopBar } from '@/components/TopBar';
import { EmployeesAdmin } from '@/components/EmployeesAdmin';

export const dynamic = 'force-dynamic';

export default async function EmployeesPage() {
  const auth = await staffForPage('/admin/employees');
  if (!auth.ok) return <AccessDenied message={auth.message} />;
  const me = auth.principal;
  if (me.role !== 'owner') return <AccessDenied message="최고관리자만 직원을 관리할 수 있습니다." />;
  return (
    <div className="page">
      <TopBar me={me} active="employees" />
      <main className="content">
        <h1>직원 관리</h1>
        <p className="muted">초대받은 직원은 메일의 링크로 비밀번호를 설정하면 활성 상태가 됩니다. 접근을 중지해도 그 직원이 만든 링크는 그대로 동작합니다.</p>
        <EmployeesAdmin meId={me.memberId} />
      </main>
    </div>
  );
}
