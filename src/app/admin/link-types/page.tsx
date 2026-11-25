import { getDb } from '@/lib/db/postgres';
import { staffForPage } from '@/lib/auth/page-staff';
import { listLinkTypesForAdmin } from '@/lib/services/link-types-admin';
import { AccessDenied, TopBar } from '@/components/TopBar';
import { LinkTypesAdmin } from '@/components/LinkTypesAdmin';

export const dynamic = 'force-dynamic';

export default async function LinkTypesPage() {
  const auth = await staffForPage('/admin/link-types');
  if (!auth.ok) return <AccessDenied message={auth.message} />;
  const me = auth.principal;
  if (me.role !== 'owner') return <AccessDenied message="최고관리자만 유형을 관리할 수 있습니다." />;
  const types = await listLinkTypesForAdmin(getDb());
  return (
    <div className="page">
      <TopBar me={me} active="linktypes" />
      <main className="content narrow-content">
        <h1>유형 관리</h1>
        <p className="muted">짧은 주소 API 의 <code>type_key</code> 목록입니다. 같은 강의에는 유형별로 짧은 주소가 하나만 만들어집니다.</p>
        <LinkTypesAdmin types={types} />
      </main>
    </div>
  );
}
