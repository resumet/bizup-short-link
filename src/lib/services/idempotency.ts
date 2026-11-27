// 멱등성 계약 (PRD §16.2, §16.5)
// 범위: 회사 + 주체 + method + 정규 route + 키. 호스트 제외.
import { AppError } from '@/lib/errors';
import { IDEMPOTENCY_KEY_RE, sha256, sha256Hex, constantTimeEqual } from '@/lib/crypto';
import type { Queryable } from '@/lib/db/types';
import type { Principal } from '@/lib/auth/principal';

export interface StoredResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export interface IdemContext {
  workspaceId: string;
  principalType: 'user' | 'api_client';
  principalId: string;
  method: string;
  route: string;
  keyHash: Buffer;
  requestHash: Buffer;
}

export function requireIdempotencyKey(header: string | null): string {
  if (!header) throw new AppError('IDEMPOTENCY_KEY_REQUIRED');
  if (!IDEMPOTENCY_KEY_RE.test(header)) {
    throw new AppError('VALIDATION_ERROR', 'Idempotency-Key는 8~128자의 영문·숫자·.:_- 만 사용할 수 있습니다.');
  }
  return header;
}

export function idemContext(
  p: Principal,
  method: string,
  route: string,
  key: string,
  requestHash: Buffer,
): IdemContext {
  return {
    workspaceId: p.workspaceId,
    principalType: p.kind,
    principalId: p.kind === 'user' ? p.userId : p.apiClientId, // 키 교체 후에도 같은 범위 (§16.5)
    method,
    route,
    keyHash: sha256(key),
    requestHash,
  };
}

export function idemScope(c: IdemContext): string {
  return `${c.workspaceId}|${c.principalType}|${c.principalId}|${c.method}|${c.route}|${c.keyHash.toString('hex')}`;
}

/** 성공 기록 조회. 같은 키·다른 내용이면 IDEMPOTENCY_KEY_REUSED */
export async function findSuccess(q: Queryable, c: IdemContext): Promise<StoredResponse | null> {
  const rows = await q.query<{
    normalized_request_hash: Uint8Array; response_status: number; response_body: string | null; response_headers: Record<string, string>;
  }>(
    `select normalized_request_hash, response_status, response_body, response_headers
       from bzup.idempotency_records
      where workspace_id = $1 and principal_type = $2 and principal_id = $3
        and method = $4 and route = $5 and key_hash = $6 and expires_at > now()`,
    [c.workspaceId, c.principalType, c.principalId, c.method, c.route, c.keyHash],
  );
  const r = rows[0];
  if (!r) return null;
  if (!constantTimeEqual(Buffer.from(r.normalized_request_hash), c.requestHash)) {
    throw new AppError('IDEMPOTENCY_KEY_REUSED');
  }
  return {
    status: r.response_status,
    body: r.response_body === null ? null : JSON.parse(r.response_body),
    headers: r.response_headers ?? {},
  };
}

export async function saveSuccess(
  q: Queryable,
  c: IdemContext,
  resp: StoredResponse,
  extra: {
    resolvedCourseId?: string | null;
    resultLinkId?: string | null;
    resultObjectType?: string | null;
    resultObjectId?: string | null;
  } = {},
): Promise<void> {
  // 만료된 같은 범위의 기록은 정리 후 새로 저장한다.
  await q.query(
    `delete from bzup.idempotency_records
      where workspace_id = $1 and principal_type = $2 and principal_id = $3
        and method = $4 and route = $5 and key_hash = $6 and expires_at <= now()`,
    [c.workspaceId, c.principalType, c.principalId, c.method, c.route, c.keyHash],
  );
  await q.query(
    `insert into bzup.idempotency_records
       (workspace_id, principal_type, principal_id, method, route, key_hash, normalized_request_hash,
        resolved_course_id, response_status, response_body, response_headers,
        result_link_id, result_object_type, result_object_id, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text::jsonb,$12,$13,$14, now() + interval '24 hours')`,
    [
      c.workspaceId, c.principalType, c.principalId, c.method, c.route, c.keyHash, c.requestHash,
      extra.resolvedCourseId ?? null, resp.status, JSON.stringify(resp.body), JSON.stringify(resp.headers),
      extra.resultLinkId ?? null, extra.resultObjectType ?? null, extra.resultObjectId ?? null,
    ],
  );
}

export function scopeHashHex(c: IdemContext): string {
  return sha256Hex(idemScope(c));
}
