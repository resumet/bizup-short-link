'use client';
// 이메일 링크 확인 폼. token_hash 는 쿼리로, Supabase 기본 템플릿의 세션 토큰·오류는 # 로 온다.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { SubmitButton } from './SubmitButton';

type Fields = Record<string, string>;
type State = { kind: 'loading' } | { kind: 'form'; fields: Fields; type: string | null } | { kind: 'error'; message: string };

const EXPIRED = '링크가 만료되었거나 이미 사용되었습니다. 초대 메일은 최고관리자에게 다시 보내 달라고 요청해 주세요.';

export function ConfirmLinkForm({ tokenHash, type, next }: { tokenHash: string | null; type: string | null; next: string | null }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    // 토큰이 주소창·방문 기록에 남지 않도록 # 를 지운다
    if (window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search);
    const base: Fields = {};
    if (next) base.next = next;
    if (tokenHash && type) {
      setState({ kind: 'form', fields: { ...base, token_hash: tokenHash, type }, type });
    } else if (hash.get('access_token') && hash.get('refresh_token')) {
      const t = hash.get('type') ?? type;
      setState({
        kind: 'form',
        type: t,
        fields: { ...base, access_token: hash.get('access_token')!, refresh_token: hash.get('refresh_token')!, ...(t ? { type: t } : {}) },
      });
    } else {
      setState({ kind: 'error', message: EXPIRED });
    }
  }, [tokenHash, type, next]);

  if (state.kind === 'loading') return <p className="muted">링크를 확인하는 중…</p>;
  if (state.kind === 'error') {
    return (
      <>
        <p className="error" role="alert">{state.message}</p>
        <p className="muted small"><Link href="/login">로그인 화면으로</Link></p>
      </>
    );
  }
  const label = state.type === 'invite' ? '초대 수락하고 계정 설정하기' : state.type === 'recovery' ? '비밀번호 재설정 계속하기' : '계속하기';
  return (
    <form method="post" action="/auth/confirm" className="form">
      <p className="muted" style={{ margin: '0 0 1rem' }}>아래 버튼을 눌러 계속해 주세요.</p>
      {Object.entries(state.fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <SubmitButton>{label}</SubmitButton>
    </form>
  );
}
