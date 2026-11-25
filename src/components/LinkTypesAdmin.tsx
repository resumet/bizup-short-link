'use client';
// 짧은 주소 유형 관리: 목록·생성·수정(표시 이름·활성)·제거
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiError, formatKst, newIdempotencyKey } from '@/lib/client/api';

interface LinkType { key: string; label: string; active: boolean; link_count: number; used: boolean; created_at: string | null; updated_at: string | null }

const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

export function LinkTypesAdmin({ types }: { types: LinkType[] }) {
  const router = useRouter();
  const [form, setForm] = useState({ key: '', label: '' });
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

  const create = () => call(
    () => apiFetch('/internal/admin/short-link-types', { method: 'POST', idempotencyKey: newIdempotencyKey(), body: { key: form.key, label: form.label } }),
    `유형 ${form.key} 을(를) 추가했습니다.`,
  ).then((ok) => ok && setForm({ key: '', label: '' }));

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
      <form className="card form inline-form" onSubmit={(e) => { e.preventDefault(); if (keyValid && !keyTaken) void create(); }}>
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
          <button className="button" type="submit" disabled={busy || !keyValid || keyTaken || !form.label.trim()}>
            {busy && <span className="spinner" aria-hidden="true" />}추가
          </button>
        </div>
        {form.key !== '' && !keyValid && <p className="muted small" style={{ margin: 0 }}>소문자 영문으로 시작하고 소문자 영문·숫자·밑줄만 쓸 수 있습니다 (1~64자).</p>}
        {keyTaken && <p className="muted small" style={{ margin: 0 }}>이미 있는 key 입니다. 다른 용도라면 새 key 를 사용해 주세요.</p>}
        <p className="muted small" style={{ margin: '0.25rem 0 0' }}>key 는 API 요청의 <code>type_key</code> 로 쓰이며, 만든 뒤에는 바꿀 수 없습니다.</p>
      </form>
      {msg && <p className={msg.kind} role="status">{msg.text}</p>}

      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>key</th><th>표시 이름</th><th>상태</th><th className="right">링크 수</th><th>수정</th><th>관리</th></tr></thead>
          <tbody>
            {types.map((t) => (
              <tr key={t.key} className={t.active ? undefined : 'dim'}>
                <td><code>{t.key}</code></td>
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
