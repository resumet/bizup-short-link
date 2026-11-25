import { getDb } from '@/lib/db/postgres';
import { staffForPage } from '@/lib/auth/page-staff';
import { getSystemApiStatus } from '@/lib/services/system-api-key';
import { loadUrlPolicy, originFor } from '@/lib/services/settings';
import { AccessDenied, TopBar } from '@/components/TopBar';
import { ApiKeyAdmin } from '@/components/ApiKeyAdmin';

export const dynamic = 'force-dynamic';

export default async function ApiKeyPage() {
  const auth = await staffForPage('/admin/api-key');
  if (!auth.ok) return <AccessDenied message={auth.message} />;
  const me = auth.principal;
  if (me.role !== 'owner') return <AccessDenied message="최고관리자만 API 키를 관리할 수 있습니다." />;
  const db = getDb();
  const [status, policy] = await Promise.all([getSystemApiStatus(db, me), loadUrlPolicy(db)]);
  return (
    <div className="page">
      <TopBar me={me} active="apikey" />
      <main className="content narrow-content">
        <h1>API 키</h1>
        <ApiKeyAdmin initial={status} origin={originFor(policy.primaryHost)} />
      </main>
    </div>
  );
}
