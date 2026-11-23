'use client';
import { useRef, useState } from 'react';
import Link from 'next/link';
import { apiFetch, ApiError, newIdempotencyKey, type RowError } from '@/lib/client/api';
import { DuplicateDialog, type DuplicateReview } from './DuplicateDialog';
import { CopyButton } from './CopyButton';

interface Course { id: string; name: string; instructor_name: string | null }
interface Created {
  id: string; name: string; course_id: string; short_url: string; destination_url: string; issued_short_url: string;
}

export function NewLinkForm({ courses, isOwner }: { courses: Course[]; isOwner: boolean }) {
  const [courseId, setCourseId] = useState(courses.length === 1 ? courses[0].id : '');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [review, setReview] = useState<{ data: DuplicateReview; changed: boolean } | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  // 응답이 불명확할 때 같은 본문은 같은 Idempotency-Key 로 재시도한다 (§8.5)
  const pending = useRef<{ payload: string; key: string } | null>(null);

  if (courses.length === 0) {
    return (
      <div className="card">
        <p>진행중 강의가 없습니다. 최고관리자가 진행중 강의를 등록해야 합니다.</p>
        {isOwner && <Link className="button" href="/admin/courses">강의 등록하기</Link>}
      </div>
    );
  }

  async function submit(extra: Record<string, string> = {}) {
    const body = { course_id: courseId, name, destination_url: url, ...extra };
    const payload = JSON.stringify(body);
    const key = pending.current?.payload === payload ? pending.current.key : newIdempotencyKey();
    pending.current = { payload, key };
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const r = await apiFetch<{ data: Created }>('/internal/links', { method: 'POST', body, idempotencyKey: key });
      pending.current = null;
      setReview(null);
      setCreated(r.body.data);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (e.code !== 'NETWORK_ERROR' && e.code !== 'IDEMPOTENCY_IN_PROGRESS' && e.status < 500) pending.current = null;
      if (e.code === 'DUPLICATE_DESTINATION' || e.code === 'DUPLICATE_REVIEW_CHANGED') {
        setReview({ data: e.details as unknown as DuplicateReview, changed: e.code === 'DUPLICATE_REVIEW_CHANGED' });
      } else {
        setReview(null);
        setError(e.message);
        const fe: Record<string, string> = {};
        (e.rowErrors ?? []).forEach((r: RowError) => { if (r.field) fe[r.field] = r.message; });
        if (e.code === 'INVALID_DESTINATION_URL' || e.code === 'FORBIDDEN_DESTINATION') fe.destination_url = e.message;
        setFieldErrors(fe);
      }
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    const course = courses.find((c) => c.id === created.course_id);
    return (
      <div className="card">
        <p className="ok" role="status">짧은 주소를 만들었습니다</p>
        <div className="hero-url">
          <span className="break">{created.short_url}</span>
          <CopyButton text={created.short_url} />
        </div>
        <dl className="kv">
          <dt>강의</dt><dd>{course?.name}</dd>
          <dt>명칭</dt><dd>{created.name}</dd>
          <dt>현재 목적지</dt><dd className="break">{created.destination_url}</dd>
        </dl>
        <div className="actions" style={{ marginTop: '1.5rem' }}>
          <Link className="button secondary" href={`/links/${created.id}`}>상세 보기</Link>
          <button className="button" type="button" onClick={() => { setCreated(null); setName(''); setUrl(''); }}>새 링크 만들기</button>
        </div>
      </div>
    );
  }

  return (
    <>
      <form
        className="card form"
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        <label>
          강의
          <select value={courseId} onChange={(e) => setCourseId(e.target.value)} required>
            <option value="" disabled>진행중 강의 선택</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.instructor_name ? ` (${c.instructor_name})` : ''}</option>
            ))}
          </select>
        </label>
        <label>
          명칭
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required placeholder="예: 김선아 무료 웨비나 안내" />
          {fieldErrors.name && <span className="error">{fieldErrors.name}</span>}
        </label>
        <label>
          긴 주소
          <input value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://" inputMode="url" />
          {fieldErrors.destination_url && <span className="error">{fieldErrors.destination_url}</span>}
        </label>
        {error && !Object.keys(fieldErrors).length && <p className="error">{error}</p>}
        <div className="actions">
          <button className="button" type="submit" disabled={busy || !courseId}>{busy && <span className="spinner" aria-hidden="true" />}{busy ? '만드는 중…' : '짧은 주소 만들기'}</button>
        </div>
      </form>
      {review && (
        <DuplicateDialog
          review={review.data}
          changed={review.changed}
          busy={busy}
          onCancel={() => setReview(null)}
          onCreate={() => void submit({ review_token: review.data.review_token, duplicate_decision: 'create_new' })}
        />
      )}
    </>
  );
}
