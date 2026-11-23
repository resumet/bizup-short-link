'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiError, newIdempotencyKey } from '@/lib/client/api';

interface Props {
  link: { id: string; name: string; destination_url: string; course_id: string | null; status: 'active' | 'inactive'; short_url: string; issued_short_url: string };
  etag: string;
  courses: { id: string; name: string; status: 'active' | 'closed' }[];
}

export function LinkEditor({ link, etag, courses, hasSlots = false }: Props & { hasSlots?: boolean }) {
  const router = useRouter();
  const [name, setName] = useState(link.name);
  const [url, setUrl] = useState(link.destination_url);
  const [courseId, setCourseId] = useState(link.course_id ?? '');
  const [status, setStatus] = useState(link.status);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string; conflict?: boolean } | null>(null);
  const pending = useRef<{ payload: string; key: string } | null>(null);

  const body: Record<string, string> = {};
  if (name !== link.name) body.name = name;
  if (url !== link.destination_url) body.destination_url = url;
  if (courseId && courseId !== (link.course_id ?? '')) body.course_id = courseId;
  if (status !== link.status) body.status = status;
  const dirty = Object.keys(body).length > 0;

  async function save() {
    if (!dirty) return;
    const payload = { ...body, ...(reason.trim() ? { change_reason: reason.trim() } : {}) };
    const sig = JSON.stringify([payload, etag]);
    const key = pending.current?.payload === sig ? pending.current.key : newIdempotencyKey();
    pending.current = { payload: sig, key };
    setBusy(true);
    setMsg(null);
    try {
      await apiFetch(`/internal/links/${link.id}`, { method: 'PATCH', body: payload, ifMatch: etag, idempotencyKey: key });
      pending.current = null;
      setReason('');
      setMsg({ kind: 'ok', text: '저장했습니다. 짧은 주소는 그대로이며 새 접속부터 변경 내용이 적용됩니다.' });
      router.refresh();
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (e.code !== 'NETWORK_ERROR' && e.status < 500) pending.current = null;
      setMsg({ kind: 'error', text: e.message, conflict: e.code === 'PRECONDITION_FAILED' });
    } finally {
      setBusy(false);
    }
  }

  const currentCourse = courses.find((c) => c.id === link.course_id);
  return (
    <form className="card form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h2>수정</h2>
      <label>
        명칭
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
      </label>
      {hasSlots ? (
        <p className="muted small" style={{ margin: 0 }}>목적지는 위의 &lsquo;연결 주소 전환&rsquo;에서 바꿉니다.</p>
      ) : (
      <label>
        현재 목적지
        <input value={url} onChange={(e) => setUrl(e.target.value)} required />
        {url !== link.destination_url && (
          <span className="hint">변경 전: {link.destination_url} → 변경 후 같은 짧은 주소 {link.short_url} 로 이동합니다.</span>
        )}
      </label>
      )}
      <label>
        강의
        <select value={courseId} onChange={(e) => setCourseId(e.target.value)}>
          {!link.course_id && <option value="">미분류</option>}
          {currentCourse && currentCourse.status === 'closed' && (
            <option value={currentCourse.id}>{currentCourse.name} (종료)</option>
          )}
          {courses.filter((c) => c.status === 'active').map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </label>
      <label>
        상태
        <select value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'inactive')}>
          <option value="active">활성</option>
          <option value="inactive">비활성 (방문 시 사용할 수 없음 안내)</option>
        </select>
      </label>
      <label>
        변경 사유 (선택)
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </label>
      {msg && (
        <p className={msg.kind === 'ok' ? 'ok' : 'error'}>
          {msg.text}{' '}
          {msg.conflict && <button type="button" className="linklike" onClick={() => router.refresh()}>최신 내용 불러오기</button>}
        </p>
      )}
      <div className="actions">
        <button className="button" type="submit" disabled={!dirty || busy}>{busy && <span className="spinner" aria-hidden="true" />}{busy ? '저장 중…' : '저장'}</button>
      </div>
    </form>
  );
}
