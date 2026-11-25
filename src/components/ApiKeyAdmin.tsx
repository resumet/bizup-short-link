'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiError, formatKst, newIdempotencyKey } from '@/lib/client/api';
import { CopyButton } from './CopyButton';

interface KeyMeta {
  key_id: string; name: string; key_prefix: string; scopes: string[]; effective_status: string;
  expires_at: string; scheduled_revoke_at: string | null; created_at: string; created_by_name: string | null;
  last_used_at: string | null; revoked_at: string | null; revoke_reason: string | null;
}
interface Status {
  client: { id: string; name: string; version: number } | null;
  etag: string | null;
  keys: KeyMeta[];
  history: KeyMeta[];
}

const STATUS_LABEL: Record<string, [string, string]> = {
  active: ['사용 중', 'on'],
  rotating: ['교체 예정', 'closed'],
  suspended: ['일시중지', 'off'],
  expired: ['만료', 'off'],
  revoked: ['폐기', 'off'],
  deleted: ['폐기', 'off'],
};

function daysLeft(iso: string) {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

export function ApiKeyAdmin({ initial, origin }: {
  initial: Status; origin: string;
}) {
  const router = useRouter();
  const s = initial;
  const [days, setDays] = useState(90);
  const [overlap, setOverlap] = useState(24);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [revealed, setRevealed] = useState<{ key: string; meta: KeyMeta } | null>(null);
  const [revoking, setRevoking] = useState<KeyMeta | null>(null);
  const [reason, setReason] = useState('');
  const issueAttempt = useRef<{ sig: string; key: string } | null>(null);

  const hasKey = s.keys.some((k) => k.effective_status === 'active');

  async function issue() {
    const body = { expires_in_days: days, overlap_hours: overlap };
    const sig = JSON.stringify(body);
    // 응답 유실 시 같은 요청 키로 재시도하면 원문 없이 같은 키 정보를 돌려받는다
    const key = issueAttempt.current?.sig === sig ? issueAttempt.current.key : newIdempotencyKey();
    issueAttempt.current = { sig, key };
    setBusy(true);
    setMsg(null);
    try {
      const r = await apiFetch<{ data: KeyMeta & { api_key?: string; secret_available: boolean }; message?: string }>(
        '/internal/admin/api-key/keys', { method: 'POST', body, idempotencyKey: key },
      );
      issueAttempt.current = null;
      if (r.status === 201 && r.body.data.api_key) {
        setRevealed({ key: r.body.data.api_key, meta: r.body.data });
      } else {
        setMsg({ kind: 'warn', text: r.body.message ?? '이미 발급된 키입니다.' });
      }
      router.refresh();
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (e.code !== 'NETWORK_ERROR' && e.code !== 'IDEMPOTENCY_IN_PROGRESS') issueAttempt.current = null;
      setMsg({ kind: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!revoking || !reason.trim()) return;
    setBusy(true);
    try {
      await apiFetch(`/internal/admin/api-key/keys/${revoking.key_id}`, {
        method: 'DELETE', body: { reason: reason.trim() }, idempotencyKey: newIdempotencyKey(),
      });
      setRevoking(null);
      setReason('');
      setMsg({ kind: 'ok', text: '키를 폐기했습니다. 이미 만든 짧은 주소와 기록은 유지됩니다.' });
      router.refresh();
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof ApiError ? e.message : '폐기하지 못했습니다.' });
    } finally {
      setBusy(false);
    }
  }


  return (
    <>
      {msg && <p className={msg.kind} role="status">{msg.text}</p>}

      <div className="card">
        <h2>{hasKey ? '키 재발급' : '시스템 API 키 발급'}</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          시스템 키 하나로 외부 API(짧은 주소 생성·조회·수정, 강의 조회)를 호출합니다. 원문은 발급 직후 한 번만 표시되고 서버에는 저장하지 않습니다.
        </p>
        <div className="row">
          <label className="field">
            유효기간
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={30}>30일</option>
              <option value={90}>90일 (권장)</option>
              <option value={180}>180일</option>
              <option value={365}>365일</option>
            </select>
          </label>
          {hasKey && (
            <label className="field">
              기존 키
              <select value={overlap} onChange={(e) => setOverlap(Number(e.target.value))}>
                <option value={0}>즉시 폐기 (유출 의심 시)</option>
                <option value={24}>24시간 동안 함께 사용 (권장)</option>
                <option value={72}>72시간 동안 함께 사용</option>
                <option value={168}>7일 동안 함께 사용</option>
              </select>
            </label>
          )}
          <button className="button" type="button" disabled={busy} onClick={() => void issue()}>
            {busy && <span className="spinner" aria-hidden="true" />}{hasKey ? '새 키로 재발급' : '키 발급'}
          </button>
        </div>
      </div>

      <h2>사용 중인 키</h2>
      {s.keys.length === 0 ? (
        <div className="card empty"><p>발급된 키가 없습니다. 외부 API 호출은 모두 거절됩니다.</p></div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>식별자</th><th>상태</th><th>만료</th><th>마지막 사용</th><th>발급</th><th /></tr></thead>
            <tbody>
              {s.keys.map((k) => {
                const [label, cls] = STATUS_LABEL[k.effective_status] ?? ['-', 'off'];
                const left = daysLeft(k.expires_at);
                return (
                  <tr key={k.key_id}>
                    <td><code>{k.key_prefix}_••••</code><span className="sub">{k.name}</span></td>
                    <td>
                      <span className={`pill ${cls}`}>{label}</span>
                      {k.scheduled_revoke_at && <span className="sub">{formatKst(k.scheduled_revoke_at)}에 종료</span>}
                    </td>
                    <td className="num">
                      {formatKst(k.expires_at)}
                      <span className={`sub ${left <= 7 ? 'warn' : ''}`}>{left <= 7 ? `${left}일 후 만료됩니다. 새 키로 교체해 주세요.` : `${left}일 남음`}</span>
                    </td>
                    <td className="num">{k.last_used_at ? formatKst(k.last_used_at) : <span className="muted">사용 기록 없음</span>}</td>
                    <td className="num">{formatKst(k.created_at)}<span className="sub">{k.created_by_name}</span></td>
                    <td className="right">
                      <button className="button small secondary" type="button" onClick={() => { setRevoking(k); setReason(''); }}>폐기</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}


      <h2>호출 방법</h2>
      <div className="card">
        <p className="muted small" style={{ marginTop: 0 }}>모든 요청에 <code>Authorization: Bearer 키</code> 헤더가 필요합니다. 키는 서버 환경변수에 보관하고 브라우저·공개 저장소에 넣지 마세요.</p>
        <pre className="code-block">{`# 키 확인
curl ${origin}/api/v1/auth-check \\
  -H "Authorization: Bearer $BZUP_API_KEY"

# 짧은 주소 생성 (같은 요청 재시도 시 같은 Idempotency-Key 사용)
curl -X POST ${origin}/api/v1/links \\
  -H "Authorization: Bearer $BZUP_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{"course_id":"강의 UUID","name":"웨비나 안내","destination_url":"https://example.com/webinar"}'

# 강의 UUID 목록
curl ${origin}/api/v1/courses \\
  -H "Authorization: Bearer $BZUP_API_KEY"`}</pre>
        <p className="muted small">전체 API 스펙: <a href="/docs/api" target="_blank" rel="noopener">/docs/api</a> (로그인 없이 공유 가능)</p>
        <p className="muted small">짧은 주소 생성·사전 확인·자동생성 요청에는 <code>course_id</code>(강의 관리의 UUID)가 반드시 필요합니다.</p>
      </div>

      {s.history.length > 0 && (
        <>
          <h2>지난 키</h2>
          <div className="table-wrap">
            <table className="table small">
              <thead><tr><th>식별자</th><th>상태</th><th>발급</th><th>종료</th><th>사유</th></tr></thead>
              <tbody>
                {s.history.map((k) => (
                  <tr key={k.key_id} className="dim">
                    <td><code>{k.key_prefix}</code></td>
                    <td>{STATUS_LABEL[k.effective_status]?.[0]}</td>
                    <td className="num">{formatKst(k.created_at)}</td>
                    <td className="num">{formatKst(k.revoked_at ?? k.scheduled_revoke_at ?? k.expires_at)}</td>
                    <td>{k.revoke_reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {revealed && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h2>✓ API 키를 발급했습니다</h2>
            <p className="warn">키는 지금 한 번만 확인할 수 있습니다. 안전한 곳에 보관해 주세요.</p>
            <div className="secret">
              <code className="break">{revealed.key}</code>
              <CopyButton text={revealed.key} />
            </div>
            <p className="muted small">만료: {formatKst(revealed.meta.expires_at)} · 창을 닫으면 원문을 다시 볼 수 없습니다. 잃어버렸다면 폐기 후 새로 발급하세요.</p>
            <div className="modal-actions">
              <button className="button" type="button" onClick={() => setRevealed(null)}>보관했습니다</button>
            </div>
          </div>
        </div>
      )}

      {revoking && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h2>키 폐기 (영구)</h2>
            <p>이 키를 사용하는 외부 연동은 중단됩니다. 이미 만든 짧은 주소와 기록은 유지됩니다.</p>
            <p className="muted small"><code>{revoking.key_prefix}</code> · {revoking.name}</p>
            <label className="field">
              폐기 사유
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="예: 유출 의심, 연동 종료" autoFocus />
            </label>
            <div className="modal-actions">
              <button className="button secondary" type="button" onClick={() => setRevoking(null)} disabled={busy}>취소</button>
              <button className="button danger" type="button" onClick={() => void revoke()} disabled={busy || !reason.trim()}>
                {busy && <span className="spinner" aria-hidden="true" />}폐기
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
