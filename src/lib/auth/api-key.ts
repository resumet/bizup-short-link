// 외부 API 키 필수 인증 (PRD §13.5)
// - Authorization: Bearer {BZUP_API_KEY} 만 허용. query·body·cookie·X-API-Key 대체 인증 없음
// - 키 없음·형식 오류·오답·중지·만료·폐기·삭제·연동 중지는 모두 401 INVALID_API_KEY
// - 상태 확인 실패는 503 (허용 캐시로 우회하지 않음)
import { AppError } from '@/lib/errors';
import { constantTimeEqual, parseApiKey, type KeyEnvironment } from '@/lib/crypto';
import type { Db } from '@/lib/db/types';
import type { ApiPrincipal, ApiScope } from './principal';

export function serviceKeyEnvironment(): KeyEnvironment {
  return process.env.BZUP_KEY_ENV === 'test' ? 'test' : 'live';
}

export async function authenticateApiKey(db: Db, authorization: string | null): Promise<ApiPrincipal & {
  keyName: string; expiresAt: Date; scheduledRevokeAt: Date | null;
}> {
  const m = /^Bearer ([^\s]+)$/.exec(authorization ?? '');
  if (!m) throw new AppError('INVALID_API_KEY');
  const parsed = parseApiKey(m[1]);
  if (!parsed || parsed.env !== serviceKeyEnvironment()) throw new AppError('INVALID_API_KEY');

  let rows;
  try {
    rows = await db.query<{
      id: string; workspace_id: string; api_client_id: string; name: string; scopes: string[];
      secret_hash: Uint8Array | null; expires_at: Date; scheduled_revoke_at: Date | null;
      client_name: string; valid: boolean; environment: string;
    }>(
      `select k.id, k.workspace_id, k.api_client_id, k.name, k.scopes, k.secret_hash, k.expires_at,
              k.scheduled_revoke_at, k.environment, c.name as client_name,
              (k.status = 'active' and k.deleted_at is null and c.status = 'active'
               and clock_timestamp() < k.expires_at
               and (k.scheduled_revoke_at is null or clock_timestamp() < k.scheduled_revoke_at)) as valid
         from bzup.api_keys k
         join bzup.api_clients c on c.workspace_id = k.workspace_id and c.id = k.api_client_id
        where k.public_id = $1`,
      [parsed.publicId],
    );
  } catch {
    throw new AppError('SERVICE_UNAVAILABLE');
  }
  const k = rows[0];
  if (!k || !k.secret_hash || k.environment !== parsed.env) throw new AppError('INVALID_API_KEY');
  if (!constantTimeEqual(Buffer.from(k.secret_hash), parsed.hash)) throw new AppError('INVALID_API_KEY');
  if (!k.valid) throw new AppError('INVALID_API_KEY');

  // last_used_at: 최대 60초 묶음 갱신, 권한 판단·version 과 무관 (§13.6)
  db.query(
    `update bzup.api_keys set last_used_at = clock_timestamp()
      where id = $1 and (last_used_at is null or last_used_at < clock_timestamp() - interval '60 seconds')`,
    [k.id],
  ).catch(() => undefined);

  return {
    kind: 'api_client',
    workspaceId: k.workspace_id,
    apiClientId: k.api_client_id,
    apiKeyId: k.id,
    scopes: k.scopes as ApiScope[],
    clientName: k.client_name,
    keyName: k.name,
    expiresAt: k.expires_at,
    scheduledRevokeAt: k.scheduled_revoke_at,
  };
}
