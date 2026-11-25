'use client';
// 링크 상세 위험 구역: 삭제 안내 → 명칭 입력 확인 → 삭제
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiError, newIdempotencyKey } from '@/lib/client/api';

interface Props {
  linkId: string;
  name: string;
  shortUrl: string;
  etag: string;
  totalViews: number;
}

export function LinkDangerZone({ linkId, name, shortUrl, etag, totalViews }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <h2 id="danger-zone" className="danger-title">위험 구역</h2>
      <section className="card danger-zone" aria-labelledby="danger-zone">
        <div className="danger-row">
          <div>
            <strong>이 링크 삭제</strong>
            <ul className="muted small">
              <li>짧은 주소 <code>{shortUrl.replace(/^https?:\/\//, '')}</code>가 <strong>즉시 작동을 멈춥니다</strong>. 이미 공유한 주소로 들어오면 &lsquo;찾을 수 없음&rsquo;이 표시됩니다.</li>
              <li>링크 목록·검색·같은 목적지 확인에서 사라지고, 다시 되돌릴 수 없습니다.</li>
              <li>같은 짧은 주소(코드)는 다시 발급되지 않습니다. 변경 이력·조회수 기록은 보관됩니다.</li>
              <li>API 로 만든 링크라면, 같은 강의·type 으로 새 짧은 주소를 다시 만들 수 있게 됩니다.</li>
            </ul>
          </div>
          <button type="button" className="button danger" onClick={() => setOpen(true)}>링크 삭제</button>
        </div>
      </section>
      {open && <DeleteDialog linkId={linkId} name={name} shortUrl={shortUrl} etag={etag} totalViews={totalViews} onClose={() => setOpen(false)} />}
    </>
  );
}

function DeleteDialog({ linkId, name, shortUrl, etag, totalViews, onClose }: Props & { onClose: () => void }) {
  const router = useRouter();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef(newIdempotencyKey());
  const matches = typed.trim() === name;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function remove() {
    if (!matches) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/internal/links/${linkId}`, {
        method: 'DELETE', ifMatch: etag, idempotencyKey: keyRef.current, body: { confirm_name: typed.trim() },
      });
      router.replace('/links?notice=deleted');
      router.refresh();
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError && e.code === 'PRECONDITION_FAILED') {
        setError('다른 사람이 이 링크를 먼저 수정했습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.');
        return;
      }
      setError(e instanceof ApiError ? e.message : '삭제하지 못했습니다.');
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-title">
      <div className="modal">
        <h2 id="delete-title">링크를 삭제할까요?</h2>
        <p><strong>{name}</strong> · <code>{shortUrl.replace(/^https?:\/\//, '')}</code></p>
        <p className="warn">
          삭제하면 이 짧은 주소는 바로 작동하지 않으며 되돌릴 수 없습니다.
          {totalViews > 0 && <> 지금까지 {totalViews.toLocaleString('ko-KR')}번 열린 주소입니다.</>}
        </p>
        <form className="form" onSubmit={(e) => { e.preventDefault(); void remove(); }}>
          <label>
            확인을 위해 링크 명칭 <strong>{name}</strong> 을(를) 그대로 입력해 주세요.
            <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" disabled={busy} aria-invalid={typed !== '' && !matches} />
          </label>
          {typed !== '' && !matches && <p className="muted small" style={{ margin: 0 }}>명칭이 일치하지 않습니다.</p>}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="button secondary" onClick={onClose} disabled={busy}>취소</button>
            <button type="submit" className="button danger" disabled={!matches || busy}>
              {busy && <span className="spinner" aria-hidden="true" />}삭제
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
