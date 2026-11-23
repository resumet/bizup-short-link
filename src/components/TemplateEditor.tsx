'use client';
import { useEffect, useRef, useState } from 'react';
import { apiFetch, ApiError, formatKst, newIdempotencyKey } from '@/lib/client/api';

interface Item { id: string | null; key: string; name: string; is_active: boolean; slots: string }

// 전환 주소 라벨: 쉼표로 구분 입력, 비우면 일반(단일 주소) 항목
const parseSlotText = (t: string): string[] | null => {
  const labels = t.split(',').map((x) => x.trim()).filter(Boolean);
  return labels.length ? labels : null;
};
interface Loaded {
  id: string; display_name: string; version: number;
  items: { id: string; name: string; sort_order: number; is_active: boolean; destination_slots: string[] | null }[];
  revisions: { version: number; created_at: string; actor_name: string | null }[];
}

const MAX_ACTIVE = 100;

export function TemplateEditor() {
  const [data, setData] = useState<Loaded | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string; conflict?: boolean } | null>(null);
  const seq = useRef(0);
  const pending = useRef<{ payload: string; key: string } | null>(null);

  async function load() {
    const r = await apiFetch<{ data: Loaded }>('/internal/admin/generation-template');
    setData(r.body.data);
    setEtag(r.etag);
    setItems(r.body.data.items.map((i) => ({
      id: i.id, key: i.id, name: i.name, is_active: i.is_active, slots: (i.destination_slots ?? []).join(', '),
    })));
  }

  useEffect(() => {
    load().catch((e) => setMsg({ kind: 'error', text: e instanceof ApiError ? e.message : '불러오지 못했습니다.' }));
  }, []);

  const activeCount = items.filter((i) => i.is_active).length;
  const nameCount = new Map<string, number>();
  items.filter((i) => i.is_active).forEach((i) => nameCount.set(i.name.trim(), (nameCount.get(i.name.trim()) ?? 0) + 1));

  const update = (idx: number, patch: Partial<Item>) => setItems(items.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  const move = (idx: number, d: -1 | 1) => {
    const j = idx + d;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[idx], next[j]] = [next[j], next[idx]];
    setItems(next);
  };

  async function save() {
    if (!etag) return;
    const body = {
      items: items.map((i) => ({
        ...(i.id ? { id: i.id } : {}), name: i.name, is_active: i.is_active, destination_slots: parseSlotText(i.slots),
      })),
    };
    const sig = JSON.stringify([body, etag]);
    const key = pending.current?.payload === sig ? pending.current.key : newIdempotencyKey();
    pending.current = { payload: sig, key };
    setBusy(true);
    setMsg(null);
    try {
      const r = await apiFetch<{ version_changed: boolean; data: { version: number } }>('/internal/admin/generation-template', {
        method: 'PUT', body, ifMatch: etag, idempotencyKey: key,
      });
      pending.current = null;
      await load();
      setMsg({ kind: 'ok', text: r.body.version_changed ? `저장했습니다. 목록 버전 ${r.body.data.version}` : '변경된 내용이 없습니다.' });
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (e.code !== 'NETWORK_ERROR' && e.status < 500) pending.current = null;
      const rowMsg = (e.rowErrors ?? []).map((r) => `${r.row}번: ${r.message}`).join(' ');
      setMsg({ kind: 'error', text: `${e.message} ${rowMsg}`.trim(), conflict: e.code === 'PRECONDITION_FAILED' });
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <p className="muted">{msg?.text ?? '불러오는 중…'}</p>;

  return (
    <>
      <div className="card">
        <p>
          <strong>{data.display_name}</strong> · 현재 버전 {data.version} · 활성 {activeCount}/{MAX_ACTIVE}개
        </p>
        <p className="muted">
          긴 주소는 여기에 저장하지 않고 자동생성 실행 때 입력합니다. 항목을 지우는 대신 사용 중지하면 과거 실행 기록에서 항목을 추적할 수 있습니다.
        </p>
        <table className="table" style={{ margin: '1rem 0' }}>
          <thead><tr><th>순서</th><th>명칭</th><th>사용</th><th>순서 변경</th></tr></thead>
          <tbody>
            {items.map((it, idx) => (
              <tr key={it.key} className={it.is_active ? undefined : 'dim'}>
                <td>{idx + 1}</td>
                <td>
                  <input className="full" value={it.name} maxLength={120} onChange={(e) => update(idx, { name: e.target.value })} />
                  {it.is_active && (nameCount.get(it.name.trim()) ?? 0) > 1 && (
                    <div className="warn">같은 이름이 있습니다. 실행 팝업에서는 순서로 구분됩니다.</div>
                  )}
                  {!it.id && <span className="muted"> 새 항목</span>}
                  <label className="inline" style={{ marginTop: '0.375rem', width: '100%' }}>
                    <span className="nowrap">전환 주소</span>
                    <input
                      className="full"
                      value={it.slots}
                      maxLength={220}
                      placeholder="비우면 주소 1개 · 예: 단톡방, 라이브 유튜브, 앵콜 줌"
                      onChange={(e) => update(idx, { slots: e.target.value })}
                      style={{ minHeight: '2rem', fontSize: '0.8125rem' }}
                    />
                  </label>
                  {(() => {
                    const labels = parseSlotText(it.slots);
                    if (!labels) return null;
                    if (labels.length < 2 || labels.length > 5) return <div className="warn">전환 주소는 2~5개로 입력해 주세요.</div>;
                    return <div className="sub">짧은 주소 1개 · 처음엔 &lsquo;{labels[0]}&rsquo;로 연결, 상세에서 {labels.slice(1).join(' · ')}(으)로 전환</div>;
                  })()}
                </td>
                <td>
                  <label className="inline">
                    <input type="checkbox" checked={it.is_active} onChange={(e) => update(idx, { is_active: e.target.checked })} /> {it.is_active ? '사용' : '중지'}
                  </label>
                </td>
                <td className="nowrap">
                  <button type="button" className="button small secondary" onClick={() => move(idx, -1)} disabled={idx === 0}>↑</button>{' '}
                  <button type="button" className="button small secondary" onClick={() => move(idx, 1)} disabled={idx === items.length - 1}>↓</button>
                  {!it.id && (
                    <> <button type="button" className="button small secondary" onClick={() => setItems(items.filter((_, i) => i !== idx))}>삭제</button></>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="actions">
          <button type="button" className="button secondary" onClick={() => setItems([...items, { id: null, key: `new-${++seq.current}`, name: '', is_active: true, slots: '' }])}>
            이름 추가
          </button>
          <button type="button" className="button" disabled={busy || activeCount > MAX_ACTIVE} onClick={() => void save()}>
            {busy && <span className="spinner" aria-hidden="true" />}{busy ? '저장 중…' : '저장'}
          </button>
        </div>
        {activeCount > MAX_ACTIVE && <p className="error">활성 항목은 최대 {MAX_ACTIVE}개입니다.</p>}
        {msg && (
          <p className={msg.kind}>
            {msg.text}{' '}
            {msg.conflict && <button type="button" className="linklike" onClick={() => void load()}>최신 목록 불러오기</button>}
          </p>
        )}
      </div>

      <h2>변경 이력</h2>
      <div className="table-wrap">
      <table className="table small">
        <thead><tr><th>버전</th><th>변경자</th><th>시각</th></tr></thead>
        <tbody>
          {data.revisions.map((r) => (
            <tr key={r.version}><td>{r.version}</td><td>{r.actor_name ?? '-'}</td><td>{formatKst(r.created_at)}</td></tr>
          ))}
          {data.revisions.length === 0 && <tr><td colSpan={3} className="muted">아직 변경 이력이 없습니다.</td></tr>}
        </tbody>
      </table>
      </div>
    </>
  );
}
