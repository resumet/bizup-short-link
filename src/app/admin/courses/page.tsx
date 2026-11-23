import { getDb } from '@/lib/db/postgres';
import { staffForPage } from '@/lib/auth/page-staff';
import { listCoursesForAdmin } from '@/lib/services/courses';
import { AccessDenied, TopBar } from '@/components/TopBar';
import { CoursesAdmin } from '@/components/CoursesAdmin';

export const dynamic = 'force-dynamic';

export default async function CoursesPage() {
  const auth = await staffForPage('/admin/courses');
  if (!auth.ok) return <AccessDenied message={auth.message} />;
  const me = auth.principal;
  if (me.role !== 'owner') return <AccessDenied message="최고관리자만 강의를 관리할 수 있습니다." />;
  const courses = await listCoursesForAdmin(getDb(), me.workspaceId);
  return (
    <div className="page">
      <TopBar me={me} active="courses" />
      <main className="content">
        <h1>강의 관리</h1>
        <p className="muted">진행중 강의만 새 링크에 선택할 수 있습니다. 강의를 종료해도 기존 링크는 그대로 동작하며 목록 필터에서 찾을 수 있습니다.</p>
        <CoursesAdmin courses={courses as Parameters<typeof CoursesAdmin>[0]['courses']} />
      </main>
    </div>
  );
}
