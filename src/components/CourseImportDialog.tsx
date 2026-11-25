'use client';
// 외부 강의 정보(bizup-dashboard) 가져오기 팝업
// - 외부 API 는 브라우저 Origin(https://bizup.im)으로 호출을 허용하므로 브라우저에서 직접 호출한다.
// - 외부 강의 UUID 를 그대로 강의 id 로 저장 → 이미 추가된 UUID 는 선택할 수 없고 서버에서도 건너뛴다.
import { useEffect, useMemo, useState } from 'react';
import { apiFetch, ApiError, formatKst, newIdempotencyKey } from '@/lib/client/api';

const COURSES_API = 'https://bizup-dashboard.vercel.app/api/public/courses';

interface ExternalCourse {
  id: string;
  name: string;
  instructorName: string | null;
  cohort: string | number | null;
  webinarDate: string | null;
}

export function CourseImportButton({ existingIds, onAdded }: { existingIds: string[]; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="button secondary" onClick={() => setOpen(true)}>강의정보 가져오기</button>
      {open && <CourseImportDialog existingIds={existingIds} onAdded={onAdded} onClose={() => setOpen(false)} />}
    </>
  );
}

function CourseImportDialog({ existingIds, onAdded, onClose }: { existingIds: string[]; onAdded: () => void; onClose: () => void }) {
  const [courses, setCourses] = useState<ExternalCourse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null);

  const existing = useMemo(
    () => new Set([...existingIds, ...added].map((id) => id.toLowerCase())),
    [existingIds, added],
  );
  const isAdded = (c: ExternalCourse) => existing.has(c.id.toLowerCase());

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(COURSES_API, { method: 'GET', credentials: 'omit', cache: 'no-store' });
      if (res.status === 403) {
        setError('강의 정보는 https://bizup.im 에서만 가져올 수 있습니다. (로컬 개발 환경에서는 조회가 거절됩니다)');
        return;
      }
      if (!res.ok) {
        setError(`강의 정보를 가져오지 못했습니다. (응답 ${res.status})`);
        return;
      }
      const body = (await res.json()) as { courses?: ExternalCourse[] };
      setCourses(Array.isArray(body.courses) ? body.courses : []);
    } catch {
      setError('강의 정보 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const selectable = (courses ?? []).filter((c) => !isAdded(c));
  const allSelected = selectable.length > 0 && selectable.every((c) => selected.has(c.id));

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  }

  async function addSelected() {
    const picks = (courses ?? []).filter((c) => selected.has(c.id) && !isAdded(c));
    if (!picks.length) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await apiFetch<{ data: { added: string[]; skipped: string[] } }>('/internal/admin/courses/import', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: {
          courses: picks.map((c) => ({
            id: c.id,
            name: c.name,
            instructor_name: c.instructorName ?? null,
            cohort: c.cohort === null || c.cohort === undefined || c.cohort === '' ? null : String(c.cohort),
            webinar_at: c.webinarDate ?? null,
          })),
        },
      });
      const { added: a, skipped } = r.body.data;
      setAdded(new Set([...added, ...a, ...skipped]));
      setSelected(new Set());
      setMsg(skipped.length
        ? { kind: 'warn', text: `${a.length}개 강의를 추가했습니다. ${skipped.length}개는 이미 추가된 강의라 건너뛰었습니다.` }
        : { kind: 'ok', text: `${a.length}개 강의를 추가했습니다.` });
      onAdded();
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof ApiError ? e.message : '강의를 추가하지 못했습니다.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="course-import-title">
      <div className="modal wide">
        <h2 id="course-import-title">강의정보 가져오기</h2>
        <p>추가할 강의를 선택해 주세요. 이미 추가된 강의(같은 UUID)는 다시 추가되지 않습니다.</p>
        {loading && <p className="muted"><span className="spinner" aria-hidden="true" />불러오는 중…</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {msg && <p className={msg.kind} role="status">{msg.text}</p>}
        {courses && (
          courses.length === 0 ? <p className="muted">가져올 강의가 없습니다.</p> : (
            <div className="modal-scroll">
              <table className="table small">
                <thead>
                  <tr>
                    <th style={{ width: '2.5rem' }}>
                      <input
                        type="checkbox"
                        aria-label="추가 가능한 강의 모두 선택"
                        checked={allSelected}
                        disabled={busy || selectable.length === 0}
                        onChange={() => setSelected(allSelected ? new Set() : new Set(selectable.map((c) => c.id)))}
                      />
                    </th>
                    <th>UUID</th><th>강의명</th><th>강사명</th><th>기수</th><th>웨비나 일정</th><th>상태</th>
                  </tr>
                </thead>
                <tbody>
                  {courses.map((c) => {
                    const done = isAdded(c);
                    return (
                      <tr key={c.id} className={done ? 'dim' : undefined} onClick={() => !done && !busy && toggle(c.id)} style={{ cursor: done ? 'default' : 'pointer' }}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`${c.name} 선택`}
                            checked={done || selected.has(c.id)}
                            disabled={done || busy}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => toggle(c.id)}
                          />
                        </td>
                        <td className="mono small" title={c.id}>{c.id}</td>
                        <td className="col-name">{c.name}</td>
                        <td>{c.instructorName}</td>
                        <td className="num">{c.cohort !== null && c.cohort !== '' ? `${c.cohort}기` : ''}</td>
                        <td className="nowrap num">{c.webinarDate ? formatKst(c.webinarDate) : ''}</td>
                        <td>{done ? <span className="pill on">추가됨</span> : <span className="pill off plain">미추가</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        )}
        <div className="modal-actions">
          {courses && (
            <span className="muted" style={{ marginRight: 'auto', alignSelf: 'center' }}>
              전체 {courses.length}개 · 추가 가능 {selectable.length}개 · 선택 {selected.size}개
            </span>
          )}
          <button className="button secondary" type="button" disabled={loading || busy} onClick={() => void load()}>새로고침</button>
          <button className="button secondary" type="button" disabled={busy} onClick={onClose}>닫기</button>
          <button className="button" type="button" disabled={busy || selected.size === 0} onClick={() => void addSelected()}>
            {busy && <span className="spinner" aria-hidden="true" />}선택한 강의 추가{selected.size ? ` (${selected.size})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
