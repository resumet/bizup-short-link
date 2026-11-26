import { getDb } from '@/lib/db/postgres';
import { staffForPage } from '@/lib/auth/page-staff';
import { AccessDenied, TopBar } from '@/components/TopBar';
import { TrackingLinkForm } from '@/components/TrackingLinkForm';

export const dynamic = 'force-dynamic';

export default async function TrackingLinkPage() {
  const auth = await staffForPage('/links/tracking');
  if (!auth.ok) return <AccessDenied message={auth.message} />;
  const me = auth.principal;
  if (me.role === 'viewer') return <AccessDenied message="조회자는 짧은 주소를 만들 수 없습니다." />;
  const courses = await getDb().query<{ id: string; name: string; instructor_name: string | null }>(
    `select id, name, instructor_name from bzup.courses where workspace_id = $1 and status = 'active' order by name, created_at`,
    [me.workspaceId],
  );
  return (
    <div className="page">
      <TopBar me={me} active="tracking" />
      <main className="content">
        <h1>트래킹 링크 만들기</h1>
        <p className="muted">
          강의를 고르고 추천코드·진행매체·URL 이 적힌 엑셀(.xlsx)을 올리면, 행마다 <b>강의명_추천코드_진행매체</b> 이름으로 짧은 주소를 만듭니다.
          같은 강의에 이미 있는 URL 은 건너뛰고 새 URL 만 만듭니다. 올린 엑셀 파일은 저장하지 않습니다.
        </p>
        <TrackingLinkForm courses={courses} isOwner={me.role === 'owner'} />
      </main>
    </div>
  );
}
