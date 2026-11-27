'use client';
import { useRef, useState } from 'react';
import Link from 'next/link';
import { apiFetch, ApiError, newIdempotencyKey, type RowError } from '@/lib/client/api';
import { DuplicateDialog, type DuplicateReview } from './DuplicateDialog';
import { CopyButton } from './CopyButton';

interface Course { id: string; name: string; instructor_name: string | null }
interface LinkType { key: string; label: string; slots: { key: string; label: string }[] | null }
interface Created {
  id: string; name: string; course_id: string; short_url: string; destination_url: string;
  slots?: { key: string; label: string; destination_url: string | null }[];
}
interface TypedCreated {
  link_id: string; name: string; course_id: string; short_url: string; destination_url: string;
  slots?: { key: string; label: string; destination_url: string | null }[];
}

export function NewLinkForm({ courses, types = [], isOwner }: { courses: Course[]; types?: LinkType[]; isOwner: boolean }) {
  const [courseId, setCourseId] = useState(courses.length === 1 ? courses[0].id : '');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [typeKey, setTypeKey] = useState('');
  const [slotUrls, setSlotUrls] = useState<Record<string, string>>({});
  const [existing, setExisting] = useState<{ link_id: string; short_url: string } | null>(null);
  const type = types.find((t) => t.key === typeKey) ?? null;
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

  async function submitTyped() {
    const body: Record<string, unknown> = { course_id: courseId, type_key: typeKey, name };
    if (type?.slots) body.slot_urls = Object.fromEntries(type.slots.map((s) => [s.key, (slotUrls[s.key] ?? '').trim() || null]));
    else body.destination_url = url;
    const payload = JSON.stringify(body);
    const key = pending.current?.payload === payload ? pending.current.key : newIdempotencyKey();
    pending.current = { payload, key };
    setBusy(true);
    setError(null);
    setFieldErrors({});
    setExisting(null);
    try {
      const r = await apiFetch<TypedCreated>('/internal/short-links', { method: 'POST', body, idempotencyKey: key });
      pending.current = null;
      const d = r.body;
      setCreated({ id: d.link_id, name: d.name, course_id: d.course_id, short_url: d.short_url, destination_url: d.destination_url, slots: d.slots });
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (e.code !== 'NETWORK_ERROR' && e.code !== 'IDEMPOTENCY_IN_PROGRESS' && e.status < 500) pending.current = null;
      setError(e.message);
      if (e.code === 'LINK_TYPE_EXISTS') setExisting(e.details as { link_id: string; short_url: string });
      const fe: Record<string, string> = {};
      (e.rowErrors ?? []).forEach((r: RowError) => { if (r.field) fe[r.field] = r.message; });
      if (e.code === 'INVALID_DESTINATION_URL' || e.code === 'FORBIDDEN_DESTINATION') fe.destination_url = e.message;
      setFieldErrors(fe);
    } finally {
      setBusy(false);
    }
  }

  async function submit(extra: Record<string, string> = {}) {
    if (typeKey) return submitTyped();
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
          {created.slots && (
            <>
              <dt>전환 주소</dt>
              <dd>
                {created.slots.map((s, i) => (
                  <div key={s.key} className="break">
                    {s.label}: {s.destination_url ?? <span className="muted">비어 있음 (나중에 채우기)</span>}
                    {i === 0 && <span className="pill on plain" style={{ marginLeft: '0.375rem' }}>연결 중</span>}
                  </div>
                ))}
              </dd>
            </>
          )}
        </dl>
        <div className="actions" style={{ marginTop: '1.5rem' }}>
          <Link className="button secondary" href={`/links/${created.id}`}>상세 보기</Link>
          <button className="button" type="button" onClick={() => { setCreated(null); setName(''); setUrl(''); setSlotUrls({}); }}>새 링크 만들기</button>
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
        {types.length > 0 && (
          <label>
            유형 (선택)
            <select value={typeKey} onChange={(e) => { setTypeKey(e.target.value); setExisting(null); setError(null); setFieldErrors({}); }}>
              <option value="">유형 없음 · 일반 링크</option>
              {types.map((t) => (
                <option key={t.key} value={t.key}>{t.label}{t.slots ? ` (전환: ${t.slots.map((s) => s.label).join(' · ')})` : ''}</option>
              ))}
            </select>
            {type && <span className="muted small">강의마다 이 유형의 짧은 주소는 1개만 만들 수 있습니다.</span>}
          </label>
        )}
        {type?.slots ? (
          <fieldset className="slot-fields">
            <legend>전환 주소</legend>
            <p className="muted small" style={{ margin: 0 }}>
              처음에는 &lsquo;{type.slots[0].label}&rsquo;(으)로 연결됩니다. 나머지는 비워 두고, 주소가 나오면 링크 목록이나 상세 화면에서 채운 뒤 전환하세요.
            </p>
            {type.slots.map((s, i) => (
              <label key={s.key}>
                <span>{s.label} {i === 0 ? <span className="muted small">(필수)</span> : <span className="muted small">(나중에 채워도 됨)</span>}</span>
                <input
                  value={slotUrls[s.key] ?? ''}
                  onChange={(e) => setSlotUrls({ ...slotUrls, [s.key]: e.target.value })}
                  required={i === 0}
                  placeholder="https://"
                  inputMode="url"
                />
                {fieldErrors[`slot_urls.${s.key}`] && <span className="error">{fieldErrors[`slot_urls.${s.key}`]}</span>}
              </label>
            ))}
          </fieldset>
        ) : (
          <label>
            긴 주소
            <input value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://" inputMode="url" />
            {fieldErrors.destination_url && <span className="error">{fieldErrors.destination_url}</span>}
          </label>
        )}
        {error && !Object.keys(fieldErrors).length && (
          <p className="error">
            {error}
            {existing && <> <Link href={`/links/${existing.link_id}`}>기존 링크 보기</Link> ({existing.short_url})</>}
          </p>
        )}
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
