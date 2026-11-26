// HTTP 공통: JSON 본문 한도, 오류 응답, no-store, X-Request-Id (PRD §13.1, §14.8)
import { randomUUID } from 'node:crypto';
import { AppError, isAppError } from '@/lib/errors';
import { pgErrorCode } from '@/lib/db/types';
import type { StoredResponse } from '@/lib/services/idempotency';

export const KiB = 1024;
export const LIMITS = {
  single: 32 * KiB,
  bulk: 2 * 1024 * KiB,
  edit: 128 * KiB,
} as const;

export function newRequestId(): string {
  return randomUUID();
}

export function baseHeaders(requestId: string, extra: Record<string, string> = {}): Headers {
  const h = new Headers({
    'Cache-Control': 'private, no-store',
    'X-Request-Id': requestId,
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  return h;
}

export function json(body: unknown, status: number, requestId: string, headers: Record<string, string> = {}): Response {
  const h = baseHeaders(requestId, headers);
  h.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: h });
}

export function storedToResponse(r: StoredResponse, requestId: string): Response {
  return json(r.body, r.status, requestId, r.headers);
}

export async function readJson(req: Request, maxBytes: number): Promise<unknown> {
  const ct = req.headers.get('content-type') ?? '';
  if (!/^application\/json(\s*;|$)/i.test(ct)) throw new AppError('UNSUPPORTED_MEDIA_TYPE');
  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > maxBytes) throw new AppError('PAYLOAD_TOO_LARGE');
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new AppError('PAYLOAD_TOO_LARGE');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new AppError('INVALID_JSON', '요청 본문은 UTF-8이어야 합니다.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('INVALID_JSON');
  }
}

/** DB 연결·가용성 오류 판별 → 503 */
function isUnavailable(e: unknown): boolean {
  const code = pgErrorCode(e) ?? '';
  return (
    /^08/.test(code) || // connection exception
    code === '57P01' || code === '57P02' || code === '57P03' || code === '53300' ||
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_ENDED'].includes(code)
  );
}

export function errorResponse(e: unknown, requestId: string): Response {
  let err: AppError;
  if (isAppError(e)) err = e;
  else if (isUnavailable(e)) err = new AppError('SERVICE_UNAVAILABLE');
  else if (pgErrorCode(e) === '42P01' || pgErrorCode(e) === '42703') {
    // 테이블·열 없음: 배포된 코드보다 DB 마이그레이션이 뒤처진 경우
    console.error(`[${requestId}] schema out of date`, e instanceof Error ? e.message : '', pgErrorCode(e));
    err = new AppError('SERVICE_UNAVAILABLE', 'DB 구성이 최신이 아닙니다. 관리자가 DB 마이그레이션(npm run db:migrate:prod)을 적용해야 합니다.');
  } else {
    // 요청 본문·URL·헤더 원문을 로그에 남기지 않는다 (§18.5)
    console.error(`[${requestId}] unexpected error`, e instanceof Error ? `${e.name}: ${e.message}` : 'unknown', pgErrorCode(e) ?? '');
    err = new AppError('INTERNAL_ERROR');
  }
  const headers: Record<string, string> = { ...(err.headers ?? {}) };
  if (err.code === 'INVALID_API_KEY') headers['WWW-Authenticate'] = 'Bearer realm="bzup-api"';
  if (err.code === 'SERVICE_UNAVAILABLE' && !headers['Retry-After']) headers['Retry-After'] = '1';
  return json(
    {
      error: {
        code: err.code,
        message: err.message,
        request_id: requestId,
        ...(err.rowErrors?.length ? { row_errors: err.rowErrors } : {}),
        ...(err.details ? { details: err.details } : {}),
      },
    },
    err.status,
    requestId,
    headers,
  );
}

export function searchParamsObject(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  const sp = new URL(url).searchParams;
  for (const [k, v] of sp) {
    if (k in out) throw new AppError('VALIDATION_ERROR', `${k} 파라미터는 한 번만 보낼 수 있습니다.`);
    out[k] = v;
  }
  return out;
}
