import Link from 'next/link';

// 루트 / 는 서비스 안내·로그인 진입 화면이다. 짧은 주소는 /{short_code} 로 처리한다 (§20.2).
export default function Home() {
  return (
    <main className="center">
      <h1 className="hero-title">BZUP Link</h1>
      <p className="hero-sub">강의별 짧은 주소를 만들고, 주소는 그대로 둔 채 목적지를 바꿉니다.</p>
      <Link className="button" href="/links" style={{ minHeight: '2.75rem', padding: '0.625rem 1.5rem', fontSize: '1rem' }}>
        로그인하고 시작하기
      </Link>
      <p className="muted small" style={{ marginTop: '2rem' }}>비즈업 내부 직원용 서비스</p>
    </main>
  );
}
