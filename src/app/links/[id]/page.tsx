import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db/postgres';
import { staffForPage } from '@/lib/auth/page-staff';
import { getLink, getLinkRevisions, serializeLink } from '@/lib/services/links';
import { AppError } from '@/lib/errors';
import { UUID_RE } from '@/lib/validation';
import { formatKst } from '@/lib/time';
import { AccessDenied, StatusPill, TopBar } from '@/components/TopBar';
import { LinkEditor } from '@/components/LinkEditor';
import { LinkDangerZone } from '@/components/LinkDangerZone';
import { CopyButton } from '@/components/CopyButton';
import { ViewsChart } from '@/components/ViewsChart';
import { SlotSwitcher } from '@/components/SlotSwitcher';
import { getDailyViews } from '@/lib/services/views';

export const dynamic = 'force-dynamic';

const FIELD_LABEL: Record<string, string> = {
  name: '명칭', destination_url: '목적지', course_id: '강의', status: '상태', active_slot: '연결 주소', slot_urls: '전환 주소',
};
type Snap = {
  name?: string; destination_url?: string; course_id?: string | null; course_name_snapshot?: string | null; status?: string;
  active_slot_label?: string | null; destination_slots?: { label: string; destination_url: string | null }[];
} | null;

function describe(field: string, s: Snap) {
  if (!s) return '';
  if (field === 'course_id') return s.course_name_snapshot ?? (s.course_id ? s.course_id : '미분류');
  if (field === 'status') return s.status === 'active' ? '활성' : '비활성';
  if (field === 'active_slot') return s.active_slot_label ?? '-';
  if (field === 'slot_urls') return (s.destination_slots ?? []).map((x) => `${x.label}: ${x.destination_url ?? '(비어 있음)'}`).join(' / ');
  return String((s as Record<string, unknown>)[field] ?? '');
}

export default async function LinkDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await staffForPage(`/links/${id}`);
  if (!auth.ok) return <AccessDenied message={auth.message} />;
  const me = auth.principal;
  if (!UUID_RE.test(id)) notFound();
  const db = getDb();
  let loaded;
  try {
    loaded = await getLink(db, me, id);
  } catch (e) {
    if (e instanceof AppError && e.code === 'NOT_FOUND') notFound();
    throw e;
  }
  const link = serializeLink(loaded.link, loaded.policy, loaded.slots);
  const slots = loaded.slots;
  const revisions = await getLinkRevisions(db, me, id);
  const views = await getDailyViews(db, me, id, 30);
  const courses = await db.query<{ id: string; name: string; status: 'active' | 'closed' }>(
    `select id, name, status from bzup.courses where workspace_id = $1 order by name`,
    [me.workspaceId],
  );
  const course = courses.find((c) => c.id === link.course_id);

  return (
    <div className="page">
      <TopBar me={me} />
      <main className="content narrow-content">
        <p style={{ margin: '0 0 0.75rem' }}><Link href="/links">‹ 링크 목록</Link></p>
        <div className="title-row">
          <h1>{link.name}</h1>
          <StatusPill status={link.status} />
        </div>
        <div className="card">
          <div className="hero-url">
            <span className="break">{link.short_url}</span>
            <CopyButton text={link.short_url} />
          </div>
          <dl className="kv">
            <dt>최초 발급 주소</dt><dd>{link.issued_short_url}</dd>
            <dt>고정 코드</dt><dd><code>{link.short_code}</code></dd>
            <dt>강의</dt><dd>{course ? course.name : <span className="muted">미분류</span>} {course?.status === 'closed' && <StatusPill status="closed" />}</dd>
            <dt>현재 목적지</dt>
            <dd className="break">
              {slots && link.active_slot !== null && <span className="pill on plain" style={{ marginRight: '0.5rem' }}>{slots[link.active_slot]?.label}</span>}
              {link.destination_url}
            </dd>
            <dt>최초 목적지</dt><dd className="break muted">{link.initial_destination_url}</dd>
            <dt>생성</dt><dd>{link.created_by.label} · {link.source === 'web' ? '웹' : 'API'} · {link.creation_mode === 'single' ? '단건' : '자동생성'} · {formatKst(link.created_at)}</dd>
            <dt>최종 수정</dt><dd>{link.updated_by.label} · {formatKst(link.updated_at)} · 버전 {link.version}</dd>
            {link.generation_batch_id && (
              <><dt>자동생성 실행</dt><dd><Link href={`/links?generation_batch_id=${link.generation_batch_id}`}>같은 실행의 링크 보기</Link></dd></>
            )}
          </dl>
        </div>

        {slots && (
          <>
            <h2>연결 주소 전환</h2>
            <SlotSwitcher
              key={loaded.etag}
              linkId={link.id}
              etag={loaded.etag}
              slots={slots}
              activeSlot={link.active_slot}
              shortUrl={link.short_url}
              readOnly={me.role === 'viewer'}
            />
          </>
        )}

        <h2>조회수 <span className="muted small">최근 30일</span></h2>
        <ViewsChart views={views} />

        {me.role !== 'viewer' && <LinkEditor key={loaded.etag} link={link} etag={loaded.etag} courses={courses} hasSlots={!!slots} />}

        <h2>변경 이력</h2>
        <div className="table-wrap">
        <table className="table">
          <thead><tr><th>버전</th><th>구분</th><th>변경 내용</th><th>작업자</th><th>사유</th><th>시각</th></tr></thead>
          <tbody>
            {revisions.map((r) => (
              <tr key={r.version}>
                <td>{r.version}</td>
                <td>{r.action === 'created' ? '생성' : r.action === 'deleted' ? '삭제' : '수정'}</td>
                <td>
                  {r.action === 'created'
                    ? `${describe('destination_url', r.after as Snap)} · ${describe('course_id', r.after as Snap)}`
                    : r.changed_fields.map((f) => (
                      <div key={f} className="break">
                        <strong>{FIELD_LABEL[f] ?? f}</strong>: {describe(f, r.before as Snap)} → {describe(f, r.after as Snap)}
                      </div>
                    ))}
                </td>
                <td>{r.actor.label}{r.actor.type === 'api_client' ? ' (API)' : ''}</td>
                <td>{r.reason}</td>
                <td className="nowrap num">{formatKst(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>

        {me.role !== 'viewer' && (
          <LinkDangerZone linkId={link.id} name={link.name} shortUrl={link.short_url} etag={loaded.etag} totalViews={views.total_views} />
        )}
      </main>
    </div>
  );
}
