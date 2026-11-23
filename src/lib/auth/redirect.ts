// 인증 후 next 는 허용한 내부 경로만 받는다. 외부 URL·프로토콜 상대 URL 거절 (§18.3)
const ALLOWED_PREFIXES = ['/links', '/admin'];

export function safeNext(next: unknown, fallback = '/links'): string {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return fallback;
  try {
    const u = new URL(next, 'http://internal.invalid');
    if (u.host !== 'internal.invalid') return fallback;
    if (!ALLOWED_PREFIXES.some((p) => u.pathname === p || u.pathname.startsWith(`${p}/`))) return fallback;
    return `${u.pathname}${u.search}`;
  } catch {
    return fallback;
  }
}

/** 쿠키 기반 폼 POST 의 Origin 이 요청 호스트와 같은지 확인 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  const host = req.headers.get('host');
  if (!origin || !host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}
