import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

// 로컬 개발 전용 로그인. Supabase 없이 직원 세션을 흉내낸다.
// - DEV_AUTH=true 이고 운영 빌드·Vercel 이 아닐 때만 활성화
// - 권한 판정은 실제와 같은 workspace_members 멤버십·공통 함수 사용
// - 쿠키는 HMAC 서명, HttpOnly, SameSite=Lax, 호스트 한정

export const DEV_SESSION_COOKIE = 'bzup_dev_session';
const MAX_AGE_SEC = 12 * 60 * 60;

export function isDevAuthEnabled(): boolean {
  return (
    process.env.DEV_AUTH === 'true' &&
    process.env.NODE_ENV !== 'production' &&
    !process.env.VERCEL &&
    !process.env.VERCEL_ENV
  );
}

function secret(): string {
  const s = process.env.DEV_AUTH_SECRET;
  if (!s || s.length < 32) throw new Error('DEV_AUTH_SECRET(32자 이상)가 필요합니다.');
  return s;
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function createDevSession(userId: string): { value: string; maxAge: number } {
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: Math.floor(Date.now() / 1000) + MAX_AGE_SEC })).toString('base64url');
  return { value: `${payload}.${sign(payload)}`, maxAge: MAX_AGE_SEC };
}

export function readDevSession(value: string | undefined): string | null {
  if (!value || !isDevAuthEnabled()) return null;
  const [payload, mac] = value.split('.');
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(payload));
  const got = Buffer.from(mac);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { uid: string; exp: number };
    if (typeof uid !== 'string' || typeof exp !== 'number' || exp < Date.now() / 1000) return null;
    return uid;
  } catch {
    return null;
  }
}

export function checkDevPassword(input: string): boolean {
  const expected = process.env.DEV_LOGIN_PASSWORD ?? '';
  if (!expected) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
