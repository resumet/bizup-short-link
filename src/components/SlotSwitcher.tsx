'use client';
// 전환 주소: 같은 짧은 주소의 연결 대상을 바꾼다 (예: 단톡방 → 라이브 유튜브 → 앵콜 줌)
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiError, newIdempotencyKey } from '@/lib/client/api';

interface Slot { position: number; label: string; destination_url: string | null }

export function SlotSwitcher({ linkId, etag, slots, activeSlot, shortUrl, readOnly }: {
  linkId: string; etag: string; slots: Slot[]; activeSlot: number | null; shortUrl: string; readOnly: boolean;
}) {
  const router = useRouter();
  const [urls, setUrls] = useState(slots.map((s) => s.destination_url ?? ''));
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string; conflict?: boolean } | null>(null);

  const dirty = urls.some((u, i) => u.trim() !== (slots[i].destination_url ?? ''));

  async function send(body: Record<string, unknown>, okText: string, tag: string) {
    setBusy(tag);
    setMsg(null);
    try {
      await apiFetch(`/internal/links/${linkId}`, { method: 'PATCH', body, ifMatch: etag, idempotencyKey: newIdempotencyKey() });
      setMsg({ kind: 'ok', text: okText });
      router.refresh();
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      const rowMsg = (e.rowErrors ?? []).map((r) => r.message).join(' ');
      setMsg({ kind: 'error', text: `${e.message} ${rowMsg}`.trim(), conflict: e.code === 'PRECONDITION_FAILED' });
    } finally {
      setBusy(null);
    }
  }

  const switchTo = (pos: number) =>
    send({ active_slot: pos }, `'${slots[pos].label}'(으)로 전환했습니다. ${shortUrl} 는 이제 이 주소로 연결됩니다.`, `switch-${pos}`);
  const saveUrls = () =>
    send({ slot_urls: urls.map((u) => u.trim() || null) }, '전환 주소를 저장했습니다.', 'save');

  return (
    <div className="card">
      <p className="muted small" style={{ marginTop: 0 }}>
        짧은 주소는 그대로 두고 연결 대상만 바꿉니다. 전환은 다음 접속부터 바로 적용되고 변경 이력에 남습니다.
      </p>
      <div className="slots">
        {slots.map((s, i) => {
          const active = activeSlot === s.position;
          const saved = s.destination_url;
          return (
            <div key={s.position} className={`slot${active ? ' active' : ''}`}>
              <div className="slot-head">
                <strong>{s.label}</strong>
                {i === 0 && <span className="muted small">기본</span>}
                {active ? <span className="pill on">연결 중</span> : null}
              </div>
              <input
                className="full"
                value={urls[i]}
                placeholder={i === 0 ? 'https://' : '아직 입력하지 않음 — https://'}
                onChange={(e) => setUrls(urls.map((u, j) => (j === i ? e.target.value : u)))}
                disabled={readOnly || busy !== null}
                aria-label={`${s.label} 주소`}
              />
              {!readOnly && !active && (
                <button
                  type="button"
                  className="button small"
                  disabled={!saved || busy !== null || urls[i].trim() !== (saved ?? '')}
                  title={!saved ? '주소를 먼저 저장해 주세요' : urls[i].trim() !== (saved ?? '') ? '변경한 주소를 먼저 저장해 주세요' : undefined}
                  onClick={() => void switchTo(s.position)}
                >
                  {busy === `switch-${s.position}` && <span className="spinner" aria-hidden="true" />}이 주소로 전환
                </button>
              )}
            </div>
          );
        })}
      </div>
      {msg && (
        <p className={msg.kind} role="status">
          {msg.text}{' '}
          {msg.conflict && <button type="button" className="linklike" onClick={() => router.refresh()}>최신 내용 불러오기</button>}
        </p>
      )}
      {!readOnly && (
        <div className="actions" style={{ marginTop: '1rem' }}>
          <button className="button secondary" type="button" disabled={!dirty || busy !== null} onClick={() => void saveUrls()}>
            {busy === 'save' && <span className="spinner" aria-hidden="true" />}주소 저장
          </button>
          {dirty && <span className="muted small">저장하지 않은 변경이 있습니다.</span>}
        </div>
      )}
    </div>
  );
}
