'use client';
// 링크 목록에서 바로 전환: 연결 중인 전환 주소 표시 + 메뉴 (채워진 주소는 바로 전환, 빈 주소는 입력 후 저장·전환)
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { apiFetch, ApiError, newIdempotencyKey } from '@/lib/client/api';

export interface QuickSlot { position: number; label: string; destination_url: string | null }

export function SlotQuickSwitch({ linkId, etag, slots, activeSlot, readOnly }: {
  linkId: string; etag: string; slots: QuickSlot[]; activeSlot: number | null; readOnly: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const box = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // 표 영역(가로 스크롤)에 잘리지 않도록 화면 기준으로 띄운다
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const active = slots.find((s) => s.position === activeSlot) ?? null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const place = () => {
      const r = trigger.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(360, window.innerWidth - 32);
      setPos({ top: r.bottom + 6, left: Math.max(16, Math.min(r.left, window.innerWidth - width - 16)) });
    };
    place();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  async function send(body: Record<string, unknown>, tag: string) {
    setBusy(tag);
    setError(null);
    try {
      await apiFetch(`/internal/links/${linkId}`, { method: 'PATCH', body, ifMatch: etag, idempotencyKey: newIdempotencyKey() });
      setOpen(false);
      setDrafts({});
      router.refresh();
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      const rows = (e.rowErrors ?? []).map((r) => r.message).join(' ');
      setError(e.code === 'PRECONDITION_FAILED' ? '다른 곳에서 먼저 바뀌었습니다. 목록을 새로 불러온 뒤 다시 시도해 주세요.' : `${e.message} ${rows}`.trim());
    } finally {
      setBusy(null);
    }
  }

  const fill = (s: QuickSlot, andSwitch: boolean) => {
    const url = (drafts[s.position] ?? '').trim();
    if (!url) return;
    void send({
      slot_urls: slots.map((x) => (x.position === s.position ? url : x.destination_url)),
      ...(andSwitch ? { active_slot: s.position } : {}),
    }, `${andSwitch ? 'fill-switch' : 'fill'}-${s.position}`);
  };

  if (readOnly) return active ? <span className="pill on plain">{active.label}</span> : null;

  return (
    <span className="quick-switch" ref={box}>
      <button
        ref={trigger}
        type="button"
        className="pill on plain quick-switch-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="연결 주소 전환"
        onClick={() => { setOpen(!open); setError(null); }}
      >
        {active?.label ?? '전환'} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="quick-switch-menu" role="dialog" aria-label="연결 주소 전환" style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}>
          {slots.map((s) => {
            const isActive = s.position === activeSlot;
            return (
              <div key={s.position} className={`qs-row${isActive ? ' active' : ''}`}>
                <div className="qs-head">
                  <strong>{s.label}</strong>
                  {isActive && <span className="pill on">연결 중</span>}
                </div>
                {s.destination_url ? (
                  <div className="qs-body">
                    <span className="qs-url" title={s.destination_url}>{s.destination_url.replace(/^https?:\/\//, '')}</span>
                    {!isActive && (
                      <button type="button" className="button small" disabled={busy !== null} onClick={() => void send({ active_slot: s.position }, `switch-${s.position}`)}>
                        {busy === `switch-${s.position}` && <span className="spinner" aria-hidden="true" />}이 주소로 전환
                      </button>
                    )}
                  </div>
                ) : (
                  <form className="qs-body" onSubmit={(e) => { e.preventDefault(); fill(s, true); }}>
                    <input
                      className="full"
                      value={drafts[s.position] ?? ''}
                      onChange={(e) => setDrafts({ ...drafts, [s.position]: e.target.value })}
                      placeholder="비어 있음 — https://"
                      inputMode="url"
                      aria-label={`${s.label} 주소`}
                      disabled={busy !== null}
                    />
                    <span className="qs-actions">
                      <button type="button" className="button small secondary" disabled={busy !== null || !(drafts[s.position] ?? '').trim()} onClick={() => fill(s, false)}>
                        {busy === `fill-${s.position}` && <span className="spinner" aria-hidden="true" />}저장
                      </button>
                      <button type="submit" className="button small" disabled={busy !== null || !(drafts[s.position] ?? '').trim()}>
                        {busy === `fill-switch-${s.position}` && <span className="spinner" aria-hidden="true" />}저장하고 전환
                      </button>
                    </span>
                  </form>
                )}
              </div>
            );
          })}
          {error && <p className="error small" role="alert">{error}</p>}
          <p className="muted small qs-foot">채워진 주소를 바꾸거나 비우려면 <Link href={`/links/${linkId}`}>상세 화면</Link>에서 수정합니다.</p>
        </div>
      )}
    </span>
  );
}
