import Link from 'next/link';
import type { UserPrincipal } from '@/lib/auth/principal';

const ROLE_LABEL = { owner: '최고관리자', editor: '직원', viewer: '조회자' } as const;

export function TopBar({ me, active }: { me: UserPrincipal; active?: string }) {
  const cls = (key: string) => (active === key ? 'active' : undefined);
  const current = (key: string) => (active === key ? ('page' as const) : undefined);
  return (
    <header className="topbar">
      <Link href="/links" className="brand">BZUP Link</Link>
      <nav aria-label="주 메뉴">
        <Link href="/links" className={cls('links')} aria-current={current('links')}>링크 목록</Link>
        {me.role !== 'viewer' && (
          <div className="nav-group">
            <span className={`nav-group-label${active === 'new' || active === 'tracking' ? ' active' : ''}`} tabIndex={0} aria-haspopup="true">
              짧은 주소 만들기 <span aria-hidden="true">▾</span>
            </span>
            <div className="nav-sub" role="group" aria-label="짧은 주소 만들기">
              <Link href="/links/tracking" className={cls('tracking')} aria-current={current('tracking')}>트래킹 링크 만들기</Link>
              <Link href="/links/new" className={cls('new')} aria-current={current('new')}>일반 링크 만들기</Link>
            </div>
          </div>
        )}
        {me.role === 'owner' && (
          <>
            <Link href="/admin/courses" className={cls('courses')} aria-current={current('courses')}>강의 관리</Link>
            <Link href="/admin/generation-template" className={cls('template')} aria-current={current('template')}>자동생성 이름 목록</Link>
            <Link href="/admin/link-types" className={cls('linktypes')} aria-current={current('linktypes')}>유형 관리</Link>
            <Link href="/admin/employees" className={cls('employees')} aria-current={current('employees')}>직원 관리</Link>
            <Link href="/admin/api-key" className={cls('apikey')} aria-current={current('apikey')}>API 키</Link>
          </>
        )}
        <a href="/docs/api" target="_blank" rel="noopener" title="새 탭에서 API 문서 열기">API 스펙 ↗</a>
      </nav>
      <span className="me">
        <span className="avatar" aria-hidden="true">{[...me.displayName][0]}</span>
        <span>{me.displayName} · {ROLE_LABEL[me.role]}</span>
        <form method="post" action="/auth/logout" style={{ display: 'inline' }}>
          <button className="linklike" type="submit">로그아웃</button>
        </form>
      </span>
    </header>
  );
}

export function AccessDenied({ message }: { message: string }) {
  return (
    <main className="center">
      <div className="card narrow">
        <h1>접근할 수 없습니다</h1>
        <p className="error">{message}</p>
        <div className="actions" style={{ marginTop: '1rem' }}>
          <Link className="button secondary" href="/links">링크 목록으로</Link>
          <form method="post" action="/auth/logout"><button className="button" type="submit">다른 계정으로 로그인</button></form>
        </div>
      </div>
    </main>
  );
}

export { StatusPillClient as StatusPill } from './StatusPillClient';
