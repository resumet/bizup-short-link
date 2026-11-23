// 만료 기록 정리 (Vercel Cron 이 호출)
// Vercel Cron 은 `Authorization: Bearer ${CRON_SECRET}` 를 보낸다. 직원 세션·API 키로는 호출할 수 없다.
import { timingSafeEqual } from 'node:crypto';
import { getDb } from '@/lib/db/postgres';
import { errorResponse, json, newRequestId } from '@/lib/http';
import { cleanupExpired } from '@/lib/services/cleanup';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const got = Buffer.from(req.headers.get('authorization') ?? '');
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function GET(req: Request) {
  const requestId = newRequestId();
  if (!authorized(req)) return json({ error: { code: 'NOT_FOUND', message: 'Not Found', request_id: requestId } }, 404, requestId);
  try {
    const result = await cleanupExpired(getDb(), { timeBudgetMs: 20_000 });
    console.log(`[${requestId}] cleanup`, JSON.stringify(result));
    return json({ data: result }, 200, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
