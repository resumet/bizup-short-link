import Link from 'next/link';
import { getDb } from '@/lib/db/postgres';
import { staffForPage } from '@/lib/auth/page-staff';
import { listLinks } from '@/lib/services/link-query';
import { AppError } from '@/lib/errors';
import { AccessDenied, TopBar } from '@/components/TopBar';
import { LinksTable } from '@/components/LinksTable';

export const dynamic = 'force-dynamic';

const PASS = ['q', 'status', 'source', 'creation_mode', 'generation_batch_id', 'created_from', 'created_to'] as const;

export default async function LinksPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const auth = await staffForPage('/links');
  if (!auth.ok) return <AccessDenied message={auth.message} />;
  const me = auth.principal;
  const sp = await searchParams;
  const db = getDb();

  const filters: Record<string, string> = {};
  for (const k of PASS) if (sp[k]) filters[k] = sp[k]!;
  if (sp.course === 'unassigned') filters.course_unassigned = 'true';
  else if (sp.course) filters.course_id = sp.course;

  const courses = await db.query<{ id: string; name: string; status: 'active' | 'closed'; instructor_name: string | null }>(
    `select id, name, status, instructor_name from bzup.courses where workspace_id = $1
      order by case status when 'active' then 0 else 1 end, name`,
    [me.workspaceId],
  );

  let result: Awaited<ReturnType<typeof listLinks>> | null = null;
  let error: string | null = null;
  try {
    result = await listLinks(db, me, { ...filters, ...(sp.cursor ? { cursor: sp.cursor } : {}) });
  } catch (e) {
    if (e instanceof AppError) error = e.message;
    else throw e;
  }

  const pageQuery = { ...(sp.course ? { course: sp.course } : {}), ...Object.fromEntries(PASS.filter((k) => sp[k]).map((k) => [k, sp[k]!])) };
  const canWrite = me.role !== 'viewer';

  return (
    <div className="page">
      <TopBar me={me} active="links" />
      <main className="content">
        {sp.notice === 'deleted' && <p className="ok" role="status">링크를 삭제했습니다. 해당 짧은 주소는 더 이상 작동하지 않습니다.</p>}
        {sp.notice === 'welcome' && <p className="ok" role="status">가입이 완료되었습니다. BZUP Link 에 오신 것을 환영합니다.</p>}
        {sp.notice === 'password_changed' && <p className="ok" role="status">비밀번호를 변경했습니다.</p>}
        <div className="title-row">
          <h1>링크 목록</h1>
          <div className="actions">
            {canWrite && <Link className="button" href="/links/new">짧은 주소 만들기</Link>}
            <button className="button secondary" type="button" disabled title="다음 단계에서 제공됩니다">Excel 다운로드</button>
          </div>
        </div>

        <form className="filters" method="get">
          <input name="q" placeholder="명칭·주소·코드 검색" defaultValue={sp.q ?? ''} maxLength={200} />
          <select name="course" defaultValue={sp.course ?? ''}>
            <option value="">전체 강의</option>
            <option value="unassigned">미분류</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.status === 'closed' ? ' (종료)' : ''}</option>
            ))}
          </select>
          <select name="status" defaultValue={sp.status ?? ''}>
            <option value="">전체 상태</option>
            <option value="active">활성</option>
            <option value="inactive">비활성</option>
          </select>
          <select name="source" defaultValue={sp.source ?? ''}>
            <option value="">전체 경로</option>
            <option value="web">웹</option>
            <option value="api">API</option>
          </select>
          <select name="creation_mode" defaultValue={sp.creation_mode ?? ''}>
            <option value="">전체 방식</option>
            <option value="single">단건</option>
            <option value="tracking">트래킹</option>
          </select>
          {sp.generation_batch_id && <input type="hidden" name="generation_batch_id" value={sp.generation_batch_id} />}
          <button className="button" type="submit">검색</button>
          {Object.keys(pageQuery).length > 0 && <Link href="/links" className="button small secondary">초기화</Link>}
        </form>
        {sp.generation_batch_id && (
          <div className="chip-note">자동생성 실행 결과만 보고 있습니다 <Link href="/links">전체 보기</Link></div>
        )}

        {error && <p className="error">{error}</p>}
        {result && result.data.length === 0 && (
          <div className="card empty">
            <p>조건에 맞는 링크가 없습니다.</p>
            {canWrite && Object.keys(pageQuery).length === 0 && <Link className="button" href="/links/new">첫 짧은 주소 만들기</Link>}
          </div>
        )}
        {result && result.data.length > 0 && (
          <LinksTable links={result.data} canWrite={canWrite} />
        )}
        {result?.pagination.has_more && (
          <div className="actions" style={{ justifyContent: 'center', marginTop: '1.25rem' }}>
            <Link className="button secondary" href={`/links?${new URLSearchParams({ ...pageQuery, cursor: result.pagination.next_cursor! })}`}>다음 페이지</Link>
          </div>
        )}
      </main>
    </div>
  );
}
