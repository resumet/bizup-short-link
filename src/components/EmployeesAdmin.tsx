'use client';
// 최고관리자 직원 관리 (§3.3): 초대·재발송·역할 변경·접근 중지/재개
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch, ApiError, formatKst, newIdempotencyKey } from '@/lib/client/api';

type Role = 'owner' | 'editor' | 'viewer';
interface Member {
  id: string; display_name: string; email: string; role: Role;
  status: 'invited' | 'onboarding' | 'active' | 'suspended'; version: number;
  invited_at: string | null; joined_at: string | null; last_sign_in_at: string | null;
  can_login: 'yes' | 'no' | 'unknown' | null; reason: string | null;
  invitation: { id: string; status: string; error: string | null } | null;
}
interface PendingInvitation { id: string; email: string; display_name: string; role: Role; status: string; last_error_code: string | null; created_at: string }
interface Data { members: Member[]; pending_invitations: PendingInvitation[]; auth_status: 'ok' | 'unavailable' }

const ROLE_LABEL: Record<Role, string> = { owner: '최고관리자', editor: '직원', viewer: '조회자' };
const STATUS_LABEL: Record<Member['status'], string> = { invited: '초대 대기', onboarding: '초기 설정 대기', active: '활성', suspended: '접근 중지' };
const INVITE_LABEL: Record<string, string> = { sending: '발송 처리 중', sent: '발송 요청 완료', failed: '발송 실패', pending: '대기', accepted: '수락', revoked: '취소' };
const etagOf = (m: Member) => `"member-${m.id}-v${m.version}"`;

export function EmployeesAdmin({ meId }: { meId: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState({ display_name: '', email: '', role: 'editor' as Role });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const r = await apiFetch<{ data: Data }>('/internal/admin/employees');
      setData(r.body.data);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : '직원 목록을 불러오지 못했습니다.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<unknown>, okText: string | ((r: unknown) => string)) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      setMsg({ kind: 'ok', text: typeof okText === 'string' ? okText : okText(r) });
      await load();
      return true;
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof ApiError ? e.message : '처리하지 못했습니다.' });
      if (e instanceof ApiError && e.code === 'PRECONDITION_FAILED') await load();
      return false;
    } finally {
      setBusy(false);
    }
  }

  const invite = () => run(
    () => apiFetch<{ delivery: string }>('/internal/admin/employees', { method: 'POST', body: form }),
    (r) => {
      const d = (r as { body: { delivery: string } }).body.delivery;
      if (d === 'dev_auto_accepted') return '로컬 개발 모드: 메일 없이 바로 활성 직원으로 등록했습니다. 개발 로그인으로 접속할 수 있습니다.';
      if (d === 'linked_existing_account') return '이미 있는 계정에 연결했습니다. 그 계정으로 로그인하면 초기 설정 후 사용할 수 있습니다.';
      return '초대 메일 발송을 요청했습니다. 직원이 메일의 링크로 비밀번호를 설정하면 활성 상태가 됩니다.';
    },
  ).then((ok) => ok && setForm({ display_name: '', email: '', role: 'editor' }));

  const resend = (invitationId: string) => run(
    () => apiFetch(`/internal/admin/invitations/${invitationId}/resend`, { method: 'POST', body: {} }),
    '초대 메일을 다시 요청했습니다.',
  );

  const patch = (m: Member, body: Record<string, unknown>, okText: string) => run(
    () => apiFetch(`/internal/admin/employees/${m.id}`, { method: 'PATCH', idempotencyKey: newIdempotencyKey(), ifMatch: etagOf(m), body }),
    okText,
  );

  const members = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.members ?? []).filter((m) =>
      (!q || m.display_name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q))
      && (!statusFilter || m.status === statusFilter));
  }, [data, query, statusFilter]);

  return (
    <>
      <form className="card form inline-form" onSubmit={(e) => { e.preventDefault(); void invite(); }}>
        <h2>직원 초대</h2>
        <div className="row">
          <label>이름 <input value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} maxLength={80} required /></label>
          <label className="grow">이메일 <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} maxLength={254} required /></label>
          <label>
            역할{' '}
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              <option value="editor">직원</option>
              <option value="viewer">조회자</option>
              <option value="owner">최고관리자</option>
            </select>
          </label>
          <button className="button" type="submit" disabled={busy || !form.display_name.trim() || !form.email.trim()}>
            {busy && <span className="spinner" aria-hidden="true" />}초대
          </button>
        </div>
      </form>
      {msg && <p className={msg.kind} role="status">{msg.text}</p>}
      {loadError && <p className="error">{loadError} <button className="button small secondary" type="button" onClick={() => void load()}>다시 불러오기</button></p>}
      {data?.auth_status === 'unavailable' && (
        <p className="warn">로그인 계정 상태를 확인할 수 없어 &lsquo;로그인 가능&rsquo;을 확인 불가로 표시합니다. <button className="button small secondary" type="button" onClick={() => void load()}>재조회</button></p>
      )}

      {data && data.pending_invitations.length > 0 && (
        <div className="card">
          <h2>발송하지 못한 초대</h2>
          <ul className="plain-list">
            {data.pending_invitations.map((i) => (
              <li key={i.id}>
                {i.display_name} · {i.email} · {ROLE_LABEL[i.role]} · <span className="warn">{INVITE_LABEL[i.status] ?? i.status}</span>
                {i.last_error_code && <span className="muted small"> ({i.last_error_code})</span>}{' '}
                <button className="button small secondary" type="button" disabled={busy} onClick={() => void resend(i.id)}>다시 보내기</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="row" style={{ margin: '1rem 0 0.5rem' }}>
        <input placeholder="이름·이메일 검색" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="이름·이메일 검색" />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="직원 상태">
          <option value="">전체 상태</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <span className="muted">{data ? `${members.length}명` : '불러오는 중…'}</span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr><th>이름</th><th>이메일</th><th>역할</th><th>직원 상태</th><th>로그인 가능</th><th>초대일</th><th>가입일</th><th>마지막 로그인</th><th>관리</th></tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const self = meId === m.id;
              return (
                <tr key={m.id} className={m.status === 'suspended' ? 'dim' : undefined}>
                  <td className="col-name">{m.display_name}{self && <span className="sub">나</span>}</td>
                  <td>{m.email}</td>
                  <td>
                    <select
                      value={m.role}
                      disabled={busy}
                      aria-label={`${m.display_name} 역할`}
                      onChange={(e) => void patch(m, { role: e.target.value }, `${m.display_name}님의 역할을 ${ROLE_LABEL[e.target.value as Role]}(으)로 변경했습니다.`)}
                    >
                      <option value="owner">최고관리자</option>
                      <option value="editor">직원</option>
                      <option value="viewer">조회자</option>
                    </select>
                  </td>
                  <td>
                    <span className={`pill ${m.status === 'active' ? 'on' : 'off'}`}>{STATUS_LABEL[m.status]}</span>
                    {m.invitation && m.status !== 'active' && m.status !== 'suspended' && (
                      <span className="sub">{INVITE_LABEL[m.invitation.status] ?? m.invitation.status}</span>
                    )}
                  </td>
                  <td>
                    {m.can_login === 'yes' ? '가능' : m.can_login === 'unknown' ? '확인 불가' : '불가'}
                    {m.reason && <span className="sub">{m.reason}</span>}
                  </td>
                  <td className="nowrap num">{formatKst(m.invited_at)}</td>
                  <td className="nowrap num">{formatKst(m.joined_at)}</td>
                  <td className="nowrap num">{m.last_sign_in_at ? formatKst(m.last_sign_in_at) : <span className="muted">기록 없음</span>}</td>
                  <td className="nowrap">
                    {(m.status === 'invited' || m.status === 'onboarding') && m.invitation && (
                      <><button className="button small secondary" type="button" disabled={busy} onClick={() => void resend(m.invitation!.id)}>초대 재발송</button>{' '}</>
                    )}
                    {m.status === 'suspended'
                      ? <button className="button small secondary" type="button" disabled={busy} onClick={() => void patch(m, { status: 'active' }, `${m.display_name}님의 접근을 재개했습니다.`)}>재개</button>
                      : <button className="button small secondary" type="button" disabled={busy} onClick={() => void patch(m, { status: 'suspended' }, `${m.display_name}님의 접근을 중지했습니다. 만든 링크는 그대로 동작합니다.`)}>접근 중지</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
