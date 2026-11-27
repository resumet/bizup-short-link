'use client';
// 짧은 주소 유형 관리: 목록·생성·수정(표시 이름·활성)·제거
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiError, formatKst, newIdempotencyKey } from '@/lib/client/api';

interface SlotDef { key: string; label: string }
interface LinkType {
  key: string; label: string; active: boolean; slots: SlotDef[] | null; link_count: number; used: boolean; created_at: string | null; updated_at: string | null;
}

const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SLOT_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;

/** "chat=단톡방, youtube=유튜브 라이브" → [{key,label}] (빈 값 = 일반 유형). 형식 오류는 문자열 */
function parseSlotSpec(text: string): SlotDef[] | null | string {
  const t = text.trim();
  if (!t) return null;
  const parts = t.split(',').map((x) => x.trim()).filter(Boolean);
  const defs: SlotDef[] = [];
  for (const p of parts) {
    const i = p.indexOf('=');
    const key = (i < 0 ? '' : p.slice(0, i)).trim();
    const label = (i < 0 ? '' : p.slice(i + 1)).trim();
    if (!SLOT_KEY_RE.test(key)) return `'${p}': 키=이름 형식으로, 키는 소문자 영문으로 시작하는 영문·숫자·밑줄입니다.`;
    if (!label || [...label].length > 40) return `'${p}': 이름은 1~40자입니다.`;
    if (defs.some((d) => d.key === key)) return `전환 키가 중복되었습니다: ${key}`;
    defs.push({ key, label });
  }
  if (defs.length < 2 || defs.length > 5) return '전환 주소는 2~5개로 정해 주세요.';
  return defs;
}
const slotSpecOf = (slots: SlotDef[] | null) => (slots ?? []).map((d) => `${d.key}=${d.label}`).join(', ');

export function LinkTypesAdmin({ types }: { types: LinkType[] }) {
  const router = useRouter();
  const [form, setForm] = useState({ key: '', label: '', slots: '' });
  const [slotEditing, setSlotEditing] = useState<string | null>(null);
  const [slotDraft, setSlotDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [removing, setRemoving] = useState<LinkType | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function call(fn: () => Promise<unknown>, okText: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: 'ok', text: okText });
      router.refresh();
      return true;
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof ApiError ? e.message : '처리하지 못했습니다.' });
      return false;
    } finally {
      setBusy(false);
    }
  }

  const keyValid = KEY_RE.test(form.key);
  const keyTaken = types.some((t) => t.key === form.key);
  const formSlots = parseSlotSpec(form.slots);
  const slotDraftParsed = parseSlotSpec(slotDraft);

  const create = () => call(
    () => apiFetch('/internal/admin/short-link-types', {
      method: 'POST', idempotencyKey: newIdempotencyKey(),
      body: { key: form.key, label: form.label, ...(Array.isArray(formSlots) ? { slots: formSlots } : {}) },
    }),
    `유형 ${form.key} 을(를) 추가했습니다.`,
  ).then((ok) => ok && setForm({ key: '', label: '', slots: '' }));

  const patch = (t: LinkType, body: Record<string, unknown>, okText: string) => call(
    () => apiFetch(`/internal/admin/short-link-types/${t.key}`, { method: 'PATCH', idempotencyKey: newIdempotencyKey(), body }),
    okText,
  );

  const remove = (t: LinkType) => call(
    () => apiFetch(`/internal/admin/short-link-types/${t.key}`, { method: 'DELETE', idempotencyKey: newIdempotencyKey() }),
    `유형 ${t.key} 을(를) 제거했습니다.`,
  ).then(() => setRemoving(null));

  return (
    <>
      <form className="card form inline-form" onSubmit={(e) => { e.preventDefault(); if (keyValid && !keyTaken && typeof formSlots !== 'string') void create(); }}>
        <h2>유형 추가</h2>
        <div className="row">
          <label>
            key
            <input
              value={form.key}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
              maxLength={64}
              placeholder="예: webinar_replay"
              className="mono"
              aria-invalid={form.key !== '' && (!keyValid || keyTaken)}
              required
            />
          </label>
          <label className="grow">표시 이름 <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} maxLength={120} placeholder="예: 다시보기 QR" required /></label>
          <button className="button" type="submit" disabled={busy || !keyValid || keyTaken || !form.label.trim() || typeof formSlots === 'string'}>
            {busy && <span className="spinner" aria-hidden="true" />}추가
          </button>
        </div>
        {form.key !== '' && !keyValid && <p className="muted small" style={{ margin: 0 }}>소문자 영문으로 시작하고 소문자 영문·숫자·밑줄만 쓸 수 있습니다 (1~64자).</p>}
        {keyTaken && <p className="muted small" style={{ margin: 0 }}>이미 있는 key 입니다. 다른 용도라면 새 key 를 사용해 주세요.</p>}
        <label>
          전환 주소 (선택 · 전환형 유형)
          <input
            value={form.slots}
            onChange={(e) => setForm({ ...form, slots: e.target.value })}
            placeholder="예: chat=단톡방, youtube=유튜브 라이브, zoom=줌 라이브"
            aria-invalid={typeof formSlots === 'string'}
          />
        </label>
        {typeof formSlots === 'string'
          ? <p className="error small" style={{ margin: 0 }}>{formSlots}</p>
          : <p className="muted small" style={{ margin: 0 }}>비우면 일반 유형입니다. 채우면 이 유형의 짧은 주소는 첫 주소로 시작하고, 나머지 주소는 나중에 채워 전환합니다 (2~5개).</p>}
        <p className="muted small" style={{ margin: '0.25rem 0 0' }}>key 는 API 요청의 <code>type_key</code> 로 쓰이며, 만든 뒤에는 바꿀 수 없습니다.</p>
      </form>
      {msg && <p className={msg.kind} role="status">{msg.text}</p>}

      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>key</th><th>표시 이름</th><th>전환 주소</th><th>상태</th><th className="right">링크 수</th><th>수정</th><th>관리</th></tr></thead>
          <tbody>
            {types.map((t) => (
              <tr key={t.key} className={t.active ? undefined : 'dim'}>
                <td className="nowrap"><code>{t.key}</code></td>
                <td className="col-name">
                  {editing === t.key ? (
                    <span className="row" style={{ gap: '0.375rem' }}>
                      <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={120} autoFocus aria-label={`${t.key} 표시 이름`} />
                      <button className="button small" type="button" disabled={busy || !draft.trim()} onClick={async () => {
                        if (await patch(t, { label: draft }, '표시 이름을 바꿨습니다.')) setEditing(null);
                      }}>저장</button>
                      <button className="button small secondary" type="button" onClick={() => setEditing(null)}>취소</button>
                    </span>
                  ) : t.label}
                </td>
                <td className="col-meta">
                  {slotEditing === t.key ? (
                    <span className="row" style={{ gap: '0.375rem', flexWrap: 'wrap' }}>
                      <input value={slotDraft} onChange={(e) => setSlotDraft(e.target.value)} autoFocus placeholder="chat=단톡방, youtube=유튜브 라이브" aria-label={`${t.key} 전환 주소`} />
                      <button className="button small" type="button" disabled={busy || typeof slotDraftParsed === 'string'} onClick={async () => {
                        if (typeof slotDraftParsed === 'string') return;
                        if (await patch(t, { slots: slotDraftParsed }, '전환 주소 구성을 바꿨습니다.')) setSlotEditing(null);
                      }}>저장</button>
                      <button className="button small secondary" type="button" onClick={() => setSlotEditing(null)}>취소</button>
                      {typeof slotDraftParsed === 'string' && <span className="error small">{slotDraftParsed}</span>}
                    </span>
                  ) : t.slots ? (
                    <span>{t.slots.map((d) => d.label).join(' → ')}<span className="sub"><code>{t.slots.map((d) => d.key).join(' · ')}</code></span></span>
                  ) : <span className="muted">일반</span>}
                  {slotEditing !== t.key && !t.used && (
                    <span className="sub">
                      <button className="linklike small" type="button" disabled={busy} onClick={() => { setSlotEditing(t.key); setSlotDraft(slotSpecOf(t.slots)); }}>
                        {t.slots ? '구성 수정' : '전환형으로 바꾸기'}
                      </button>
                    </span>
                  )}
                </td>
                <td>{t.active ? <span className="pill on">사용중</span> : <span className="pill off">비활성</span>}</td>
                <td className="num right">{t.link_count}</td>
                <td className="nowrap num">{formatKst(t.updated_at)}</td>
                <td className="nowrap">
                  {editing !== t.key && (
                    <button className="button small secondary" type="button" disabled={busy} onClick={() => { setEditing(t.key); setDraft(t.label); }}>이름 수정</button>
                  )}{' '}
                  {t.active
                    ? <button className="button small secondary" type="button" disabled={busy} onClick={() => void patch(t, { active: false }, `${t.key} 을(를) 비활성화했습니다. 이미 발급된 주소는 계속 동작합니다.`)}>비활성화</button>
                    : <button className="button small secondary" type="button" disabled={busy} onClick={() => void patch(t, { active: true }, `${t.key} 을(를) 다시 사용합니다.`)}>활성화</button>}{' '}
                  <button
                    className="button small secondary"
                    type="button"
                    disabled={busy || t.used}
                    title={t.used ? '이 유형으로 발급된 링크가 있어 제거할 수 없습니다. 비활성화를 사용해 주세요.' : undefined}
                    onClick={() => setRemoving(t)}
                  >제거</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        한 번이라도 링크 발급에 쓰인 유형은 제거할 수 없고 비활성화만 할 수 있습니다. 비활성 유형으로는 새 짧은 주소를 만들 수 없지만, 이미 발급된 주소는 계속 동작합니다.
        전환 주소 구성은 그 유형으로 링크를 만들기 전까지만 바꿀 수 있습니다.
      </p>

      {removing && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="remove-type-title">
          <div className="modal">
            <h2 id="remove-type-title">유형을 제거할까요?</h2>
            <p><code>{removing.key}</code> · {removing.label}</p>
            <p className="warn">제거하면 이 key 로 짧은 주소를 발급할 수 없고, 이 key 를 쓰는 연동(대시보드 등)은 <code>UNKNOWN_LINK_TYPE</code> 오류를 받습니다.</p>
            <div className="modal-actions">
              <button className="button secondary" type="button" disabled={busy} onClick={() => setRemoving(null)}>취소</button>
              <button className="button danger" type="button" disabled={busy} onClick={() => void remove(removing)}>
                {busy && <span className="spinner" aria-hidden="true" />}제거
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
