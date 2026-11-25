import { getDb } from '@/lib/db/postgres';
import { errorResponse, json, newRequestId } from '@/lib/http';
import { authenticateApiKey } from '@/lib/auth/api-key';
import { consume, limits } from '@/lib/services/ratelimit';
import { toIso } from '@/lib/time';

export const dynamic = 'force-dynamic';

// 현재 키의 인증·유효 권한·만료 확인. 추가 scope 불필요, 자기 메타데이터만 반환 (§13.5)
export async function GET(req: Request) {
  const requestId = newRequestId();
  try {
    const db = getDb();
    const p = await authenticateApiKey(db, req.headers.get('authorization'));
    await consume(db, limits.apiRead(p));
    return json(
      {
        data: {
          api_client_id: p.apiClientId,
          api_client_name: p.clientName,
          key_id: p.apiKeyId,
          key_name: p.keyName,
          scopes: p.scopes,
          expires_at: toIso(p.expiresAt),
          scheduled_revoke_at: toIso(p.scheduledRevokeAt),
        },
      },
      200,
      requestId,
    );
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
