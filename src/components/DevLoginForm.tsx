'use client';
import { useRef, useState } from 'react';

const ROLE_LABEL: Record<string, string> = { owner: '최고관리자', editor: '직원', viewer: '조회자' };

interface Account { email: string; display_name: string; role: string; status: string }

export function DevLoginForm({ next, accounts }: { next: string; accounts: Account[] }) {
  const [email, setEmail] = useState(accounts[0]?.email ?? '');
  const [submitting, setSubmitting] = useState(false);
  const pw = useRef<HTMLInputElement>(null);
  return (
    <>
      <form method="post" action="/auth/dev-login" className="form" onSubmit={() => setSubmitting(true)}>
        <input type="hidden" name="next" value={next} />
        <label>
          이메일
          <input name="email" type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          비밀번호
          <input ref={pw} name="password" type="password" required autoComplete="current-password" autoFocus />
        </label>
        <button className="button" type="submit" disabled={submitting} style={{ minHeight: '2.75rem' }}>
          {submitting && <span className="spinner" aria-hidden="true" />}로그인
        </button>
      </form>
      {accounts.length > 0 && (
        <div className="account-list">
          <p className="muted small" style={{ margin: '0 0 0.25rem' }}>개발 계정 — 누르면 이메일이 채워집니다</p>
          {accounts.map((a) => (
            <button
              key={a.email}
              type="button"
              aria-pressed={email === a.email}
              onClick={() => { setEmail(a.email); pw.current?.focus(); }}
            >
              <span>
                <strong>{a.display_name}</strong>
                <br />
                <span className="email">{a.email}</span>
              </span>
              <span className={`pill ${a.status === 'active' ? 'on' : 'off'}`}>
                {ROLE_LABEL[a.role]}{a.status === 'suspended' ? ' · 중지' : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
