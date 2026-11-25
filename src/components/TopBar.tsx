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
        {me.role !== 'viewer' && <Link href="/links/new" className={cls('new')} aria-current={current('new')}>짧은 주소 만들기</Link>}
        {me.role === 'owner' && (
          <>
            <Link href="/admin/courses" className={cls('courses')} aria-current={current('courses')}>강의 관리</Link>
            <Link href="/admin/generation-template" className={cls('template')} aria-current={current('template')}>자동생성 이름 목록</Link>
            <Link href="/admin/link-types" className={cls('linktypes')} aria-current={current('linktypes')}>유형 관리</Link>
            <Link href="/admin/employees" className={cls('employees')} aria-current={current('employees')}>직원 관리</Link>
            <Link href="/admin/api-key" className={cls('apikey')} aria-current={current('apikey')}>API 키</Link>
          </>
        )}
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
