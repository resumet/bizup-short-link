import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db/postgres';
import { staffForPage } from '@/lib/auth/page-staff';
import { listLinks } from '@/lib/services/link-query';
import { formatKst } from '@/lib/time';
import { UUID_RE } from '@/lib/validation';
import { AccessDenied, TopBar } from '@/components/TopBar';
import { LinksTable } from '@/components/LinksTable';

export const dynamic = 'force-dynamic';

/** 강의별 링크 목록: 강의 관리에서 강의명을 누르면 오는 화면 */
export default async function CourseLinksPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const auth = await staffForPage(`/admin/courses/${id}`);
  if (!auth.ok) return <AccessDenied message={auth.message} />;
  const me = auth.principal;
  if (me.role !== 'owner') return <AccessDenied message="최고관리자만 강의를 관리할 수 있습니다." />;
  if (!UUID_RE.test(id)) notFound();
  const sp = await searchParams;
  const db = getDb();

  const [course] = await db.query<{
    id: string; name: string; instructor_name: string | null; cohort: string | null; webinar_at: Date | null; status: 'active' | 'closed';
  }>(
    `select id, name, instructor_name, cohort, webinar_at, status from bzup.courses where workspace_id = $1 and id = $2`,
    [me.workspaceId, id.toLowerCase()],
  );
  if (!course) notFound();

  const counts = await db.query<{ kind: string; n: number }>(
    `select case when l.type_key is not null then coalesce(t.label, l.type_key)
                 when l.creation_mode = 'tracking' then '트래킹'
                 when l.creation_mode = 'batch' then '자동생성'
                 else '일반' end as kind, count(*)::int as n
       from bzup.links l
       left join bzup.short_link_types t on t.key = l.type_key
      where l.workspace_id = $1 and l.course_id = $2 and l.deleted_at is null
      group by 1 order by 2 desc, 1`,
    [me.workspaceId, course.id],
  );
  const total = counts.reduce((s, c) => s + c.n, 0);

  const result = await listLinks(db, me, { course_id: course.id, ...(sp.cursor ? { cursor: sp.cursor } : {}) });

  return (
    <div className="page">
      <TopBar me={me} active="courses" />
      <main className="content">
        <p className="muted small"><Link href="/admin/courses">← 강의 관리</Link></p>
        <div className="title-row">
          <h1>{course.name}</h1>
          <div className="actions">
            <Link className="button secondary" href={`/links?${new URLSearchParams({ course: course.id })}`}>링크 목록에서 검색·필터</Link>
          </div>
        </div>
        <p className="muted">
          {[course.instructor_name, course.cohort ? `${course.cohort}기` : null, course.webinar_at ? `웨비나 ${formatKst(course.webinar_at)}` : null]
            .filter(Boolean).join(' · ')}
          {' '}{course.status === 'active' ? <span className="pill on">진행중</span> : <span className="pill closed">종료</span>}
        </p>
        <p>
          링크 <b>{total}</b>개
          {counts.length > 0 && <span className="muted"> ({counts.map((c) => `${c.kind} ${c.n}`).join(' · ')})</span>}
        </p>

        {result.data.length === 0 ? (
          <div className="card empty"><p>이 강의에 연결된 링크가 없습니다.</p></div>
        ) : (
          <LinksTable links={result.data} showCourse={false} />
        )}
        {result.pagination.has_more && (
          <div className="actions" style={{ justifyContent: 'center', marginTop: '1.25rem' }}>
            <Link className="button secondary" href={`/admin/courses/${course.id}?${new URLSearchParams({ cursor: result.pagination.next_cursor! })}`}>다음 페이지</Link>
          </div>
        )}
      </main>
    </div>
  );
}
