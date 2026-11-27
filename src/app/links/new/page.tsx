import { getDb } from '@/lib/db/postgres';
import { staffForPage } from '@/lib/auth/page-staff';
import { AccessDenied, TopBar } from '@/components/TopBar';
import { NewLinkForm } from '@/components/NewLinkForm';

export const dynamic = 'force-dynamic';

export default async function NewLinkPage() {
  const auth = await staffForPage('/links/new');
  if (!auth.ok) return <AccessDenied message={auth.message} />;
  const me = auth.principal;
  if (me.role === 'viewer') return <AccessDenied message="조회자는 짧은 주소를 만들 수 없습니다." />;
  const courses = await getDb().query<{ id: string; name: string; instructor_name: string | null }>(
    `select id, name, instructor_name from bzup.courses where workspace_id = $1 and status = 'active' order by name, created_at`,
    [me.workspaceId],
  );
  const types = await getDb().query<{ key: string; label: string; slots: { key: string; label: string }[] | null }>(
    `select key, label, slots from bzup.short_link_types where active order by (slots is null), label`,
  );
  return (
    <div className="page">
      <TopBar me={me} active="new" />
      <main className="content narrow-content">
        <h1>일반 링크 만들기</h1>
        <NewLinkForm courses={courses} types={types} isOwner={me.role === 'owner'} />
      </main>
    </div>
  );
}
