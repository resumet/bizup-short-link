import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

// - 공개 짧은 주소(/{code})에는 직원 로그인·세션 갱신을 적용하지 않는다 (§18.3)
// - 코드 뒤 단일 / 는 같은 코드로 처리 (§12.2)
// - 관리 화면·내부 API 에서만 Supabase 세션을 서버가 갱신한다 (BFF)

const CODE_WITH_SLASH = /^\/([0-9A-Za-z]{7})\/$/;
const CSRF_COOKIE = 'bzup_csrf';
const STAFF_PREFIXES = ['/links', '/admin', '/internal', '/login', '/auth', '/account'];

function randomToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const m = CODE_WITH_SLASH.exec(pathname);
  if (m) {
    const url = req.nextUrl.clone();
    url.pathname = `/${m[1]}`;
    return NextResponse.rewrite(url);
  }

  if (!STAFF_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  let res = NextResponse.next({ request: req });
  const secure = process.env.NODE_ENV === 'production';
  const cookieOptions = { httpOnly: true, secure, sameSite: 'lax' as const, path: '/' };

  if (process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY) {
    const supabase = createServerClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY, {
      cookieOptions,
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (list) => {
          for (const c of list) req.cookies.set(c.name, c.value);
          res = NextResponse.next({ request: req });
          for (const c of list) res.cookies.set(c.name, c.value, { ...c.options, ...cookieOptions });
        },
      },
    });
    // 세션 갱신 (토큰 검증 포함)
    await supabase.auth.getUser();
  }

  // 이중 제출 CSRF 토큰 (JS 가 헤더로 되돌려 보내야 하므로 HttpOnly 아님, 호스트 한정)
  if (!req.cookies.get(CSRF_COOKIE)) {
    res.cookies.set(CSRF_COOKIE, randomToken(), { httpOnly: false, secure, sameSite: 'lax', path: '/' });
  }
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
