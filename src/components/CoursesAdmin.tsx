'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiError, formatKst, newIdempotencyKey } from '@/lib/client/api';
import { StatusPillClient } from './StatusPillClient';

interface Course {
  id: string; name: string; instructor_name: string | null; memo: string | null; status: 'active' | 'closed';
  version: number; created_at: string; updated_at: string; link_count: number;
}

const etagOf = (c: Course) => `"course-${c.id}-v${c.version}"`;

export function CoursesAdmin({ courses }: { courses: Course[] }) {
  const router = useRouter();
  const [form, setForm] = useState({ name: '', instructor_name: '', memo: '' });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', instructor_name: '', memo: '' });
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

  const create = () => call(
    () => apiFetch('/internal/admin/courses', {
      method: 'POST', idempotencyKey: newIdempotencyKey(),
      body: { name: form.name, instructor_name: form.instructor_name || null, memo: form.memo || null },
    }),
    '강의를 등록했습니다.',
  ).then((ok) => ok && setForm({ name: '', instructor_name: '', memo: '' }));

  const patch = (c: Course, body: Record<string, unknown>, okText: string) => call(
    () => apiFetch(`/internal/admin/courses/${c.id}`, { method: 'PATCH', idempotencyKey: newIdempotencyKey(), ifMatch: etagOf(c), body }),
    okText,
  );

  const nameCount = new Map<string, number>();
  courses.forEach((c) => nameCount.set(c.name, (nameCount.get(c.name) ?? 0) + 1));

  return (
    <>
      <form className="card form inline-form" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <h2>강의 등록</h2>
        <div className="row">
          <label>강의명 <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} required /></label>
          <label>강사명 <input value={form.instructor_name} onChange={(e) => setForm({ ...form, instructor_name: e.target.value })} maxLength={80} /></label>
          <label className="grow">메모 <input value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} maxLength={500} /></label>
          <button className="button" type="submit" disabled={busy || !form.name.trim()}>{busy && <span className="spinner" aria-hidden="true" />}등록</button>
        </div>
      </form>
      {msg && <p className={msg.kind}>{msg.text}</p>}

      <div className="table-wrap">
      <table className="table">
        <thead><tr><th>강의명</th><th>강사명</th><th>메모</th><th>상태</th><th>링크 수</th><th>등록일</th><th>관리</th></tr></thead>
        <tbody>
          {courses.map((c) => editing === c.id ? (
            <tr key={c.id}>
              <td><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={120} /></td>
              <td><input value={draft.instructor_name} onChange={(e) => setDraft({ ...draft, instructor_name: e.target.value })} maxLength={80} /></td>
              <td><input value={draft.memo} onChange={(e) => setDraft({ ...draft, memo: e.target.value })} maxLength={500} /></td>
              <td colSpan={3} />
              <td className="nowrap">
                <button className="button small" type="button" disabled={busy} onClick={async () => {
                  if (await patch(c, { name: draft.name, instructor_name: draft.instructor_name || null, memo: draft.memo || null }, '저장했습니다.')) setEditing(null);
                }}>저장</button>{' '}
                <button className="button small secondary" type="button" onClick={() => setEditing(null)}>취소</button>
              </td>
            </tr>
          ) : (
            <tr key={c.id} className={c.status === 'closed' ? 'dim' : undefined}>
              <td>{c.name}{(nameCount.get(c.name) ?? 0) > 1 && <span className="sub warn">같은 이름의 강의가 있습니다</span>}</td>
              <td>{c.instructor_name}</td>
              <td className="ellipsis" title={c.memo ?? ''}>{c.memo}</td>
              <td>{c.status === 'active' ? <span className="pill on">진행중</span> : <StatusPillClient status="closed" />}</td>
              <td className="num">{c.link_count}</td>
              <td className="nowrap num">{formatKst(c.created_at)}</td>
              <td className="nowrap">
                <button className="button small secondary" type="button" disabled={busy} onClick={() => {
                  setEditing(c.id);
                  setDraft({ name: c.name, instructor_name: c.instructor_name ?? '', memo: c.memo ?? '' });
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
