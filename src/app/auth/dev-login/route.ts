// 로컬 개발 전용 로그인 (DEV_AUTH=true, 운영·Vercel 에서는 404)
import { getDb } from '@/lib/db/postgres';
import { loadUrlPolicy } from '@/lib/services/settings';
import { checkDevPassword, createDevSession, DEV_SESSION_COOKIE, isDevAuthEnabled } from '@/lib/auth/dev-auth';
import { safeNext, sameOrigin } from '@/lib/auth/redirect';

export const dynamic = 'force-dynamic';

function redirect(req: Request, path: string, cookie?: string): Response {
  void req;
  // path 는 항상 내부 상대 경로 (safeNext 또는 /login)
  const headers = new Headers({ Location: path, 'Cache-Control': 'private, no-store' });
  if (cookie) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}

export async function POST(req: Request) {
  if (!isDevAuthEnabled()) return new Response('Not Found', { status: 404 });
  if (!sameOrigin(req)) return new Response('Forbidden', { status: 403 });

  const form = await req.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const password = String(form.get('password') ?? '');
  const next = safeNext(form.get('next'));

  if (!email || !checkDevPassword(password)) return redirect(req, `/login?error=invalid&next=${encodeURIComponent(next)}`);

  const db = getDb();
  const policy = await loadUrlPolicy(db);
  const rows = await db.query<{ user_id: string }>(
    `select user_id from bzup.workspace_members where workspace_id = $1 and lower(email) = $2`,
    [policy.workspaceId, email],
  );
  if (!rows[0]) return redirect(req, `/login?error=invalid&next=${encodeURIComponent(next)}`);

  // 멤버십 상태(중지 등)는 로그인 후 보호된 요청마다 공통 함수로 판정한다.
  const s = createDevSession(rows[0].user_id);
  const cookie = `${DEV_SESSION_COOKIE}=${s.value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${s.maxAge}`;
  return redirect(req, next, cookie);
}
