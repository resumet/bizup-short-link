'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiError, formatKst, newIdempotencyKey } from '@/lib/client/api';
import { StatusPillClient } from './StatusPillClient';
import { CourseImportButton } from './CourseImportDialog';

interface Course {
  id: string; name: string; instructor_name: string | null; cohort: string | null; webinar_at: string | null;
  source: 'manual' | 'dashboard'; status: 'active' | 'closed';
  version: number; created_at: string; updated_at: string; link_count: number;
}

const etagOf = (c: Course) => `"course-${c.id}-v${c.version}"`;

/** ISO → datetime-local 입력값(한국 시간) */
function toKstInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 16);
}
/** datetime-local 입력값(한국 시간) → ISO */
function fromKstInput(v: string): string | null {
  return v ? new Date(`${v}:00+09:00`).toISOString() : null;
}

const EMPTY = { name: '', instructor_name: '', cohort: '', webinar_at: '' };

export function CoursesAdmin({ courses }: { courses: Course[] }) {
  const router = useRouter();
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null);

  async function call(fn: () => Promise<{ body: unknown }>, okText: string) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      const warnings = (r.body as { warnings?: string[] }).warnings ?? [];
      setMsg(warnings.length ? { kind: 'warn', text: `${okText} ${warnings.join(' ')}` } : { kind: 'ok', text: okText });
      router.refresh();
      return true;
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof ApiError ? e.message : '처리하지 못했습니다.' });
      if (e instanceof ApiError && e.code === 'PRECONDITION_FAILED') router.refresh();
      return false;
    } finally {
      setBusy(false);
    }
  }

  const bodyOf = (v: typeof EMPTY) => ({
    name: v.name, instructor_name: v.instructor_name || null, cohort: v.cohort || null, webinar_at: fromKstInput(v.webinar_at),
  });

  const create = () => call(
    () => apiFetch('/internal/admin/courses', { method: 'POST', idempotencyKey: newIdempotencyKey(), body: bodyOf(form) }),
    '강의를 등록했습니다.',
  ).then((ok) => ok && setForm(EMPTY));

  const patch = (c: Course, body: Record<string, unknown>, okText: string) => call(
    () => apiFetch(`/internal/admin/courses/${c.id}`, { method: 'PATCH', idempotencyKey: newIdempotencyKey(), ifMatch: etagOf(c), body }),
    okText,
  );

  return (
    <>
      <form className="card form inline-form" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>강의 등록</h2>
          <CourseImportButton existingIds={courses.map((c) => c.id)} onAdded={() => router.refresh()} />
        </div>
        <div className="row">
          <label className="grow">강의명 <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} required /></label>
          <label>강사명 <input value={form.instructor_name} onChange={(e) => setForm({ ...form, instructor_name: e.target.value })} maxLength={80} /></label>
          <label>기수 <input value={form.cohort} onChange={(e) => setForm({ ...form, cohort: e.target.value })} maxLength={40} style={{ width: '5rem' }} /></label>
          <label>웨비나 일정 <input type="datetime-local" value={form.webinar_at} onChange={(e) => setForm({ ...form, webinar_at: e.target.value })} /></label>
          <button className="button" type="submit" disabled={busy || !form.name.trim()}>{busy && <span className="spinner" aria-hidden="true" />}등록</button>
        </div>
      </form>
      {msg && <p className={msg.kind}>{msg.text}</p>}

      <div className="table-wrap">
      <table className="table">
        <thead><tr><th>UUID</th><th>강의명</th><th>강사명</th><th>기수</th><th>웨비나 일정</th><th>상태</th><th>링크 수</th><th>관리</th></tr></thead>
        <tbody>
          {courses.map((c) => editing === c.id ? (
            <tr key={c.id}>
              <td className="mono small" title={c.id}>{c.id.slice(0, 8)}…</td>
              <td><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={120} /></td>
              <td><input value={draft.instructor_name} onChange={(e) => setDraft({ ...draft, instructor_name: e.target.value })} maxLength={80} /></td>
              <td><input value={draft.cohort} onChange={(e) => setDraft({ ...draft, cohort: e.target.value })} maxLength={40} style={{ width: '4.5rem' }} /></td>
              <td><input type="datetime-local" value={draft.webinar_at} onChange={(e) => setDraft({ ...draft, webinar_at: e.target.value })} /></td>
              <td colSpan={2} />
              <td className="nowrap">
                <button className="button small" type="button" disabled={busy} onClick={async () => {
                  if (await patch(c, bodyOf(draft), '저장했습니다.')) setEditing(null);
                }}>저장</button>{' '}
                <button className="button small secondary" type="button" onClick={() => setEditing(null)}>취소</button>
              </td>
            </tr>
          ) : (
            <tr key={c.id} className={c.status === 'closed' ? 'dim' : undefined}>
              <td className="mono small" title={c.id}>
                {c.id.slice(0, 8)}…
                {c.source === 'dashboard' && <span className="sub">가져온 강의</span>}
              </td>
              <td className="col-name">{c.name}</td>
              <td>{c.instructor_name}</td>
              <td className="num">{c.cohort ? `${c.cohort}기` : ''}</td>
              <td className="nowrap num">{formatKst(c.webinar_at)}</td>
              <td>{c.status === 'active' ? <span className="pill on">진행중</span> : <StatusPillClient status="closed" />}</td>
              <td className="num">{c.link_count}</td>
              <td className="nowrap">
                <button className="button small secondary" type="button" disabled={busy} onClick={() => {
                  setEditing(c.id);
                  setDraft({ name: c.name, instructor_name: c.instructor_name ?? '', cohort: c.cohort ?? '', webinar_at: toKstInput(c.webinar_at) });
                }}>수정</button>{' '}
                {c.status === 'active'
                  ? <button className="button small secondary" type="button" disabled={busy} onClick={() => void patch(c, { status: 'closed' }, '강의를 종료했습니다. 기존 링크는 그대로 동작합니다.')}>종료</button>
                  : <button className="button small secondary" type="button" disabled={busy} onClick={() => void patch(c, { status: 'active' }, '강의를 재개했습니다.')}>재개</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </>
  );
}
