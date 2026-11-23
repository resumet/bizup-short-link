// 시스템 API 키 (사용자 결정: 연동별 다중 키 대신 시스템이 발급한 키 하나로 외부 API 호출)
// 유지하는 PRD 보안 규칙:
// - 원문은 최초 201 응답에서 한 번만, DB 에는 SHA-256 해시만 (§13.8)
// - 발급 재시도는 원문 없는 메타데이터만 (§13.13)
// - 만료 1~365일(기본 90), 재발급 시 기존 키 즉시 폐기 또는 0~168시간 병행 (§13.9~13.10)
// - 폐기는 영구, 해시 제거, 링크·이력 보존 (§13.11), 모든 변경 감사 기록 (§13.14)
import { AppError, validationError } from '@/lib/errors';
import { generateApiKey, hashRequest, sha256 } from '@/lib/crypto';
import { toIso } from '@/lib/time';
import type { Db, Queryable } from '@/lib/db/types';
import { lockRequestScope, lockWorkspace } from '@/lib/db/locks';
import { API_SCOPES, recheckPrincipal, type UserPrincipal } from '@/lib/auth/principal';
import { serviceKeyEnvironment } from '@/lib/auth/api-key';
import { assertAllowedFields, isObject, optionalText, uuidField } from '@/lib/validation';
import { audit, runAdminWrite } from './admin-write';
import { consume, limits } from './ratelimit';

export const SYSTEM_CLIENT_NAME = '시스템 API';
const MAX_LIVE_KEYS = 5;

export const clientEtag = (id: string, version: number) => `"api-client-${id}-v${version}"`;

interface KeyRow {
  id: string; name: string; key_prefix: string; scopes: string[]; status: 'active' | 'suspended' | 'revoked';
  expires_at: Date; scheduled_revoke_at: Date | null; created_at: Date; last_used_at: Date | null;
  revoked_at: Date | null; deleted_at: Date | null; revoke_reason: string | null; created_by: string;
  creator_name: string | null; live: boolean;
}

const KEY_COLUMNS = `k.id, k.name, k.key_prefix, k.scopes, k.status, k.expires_at, k.scheduled_revoke_at, k.created_at,
  k.last_used_at, k.revoked_at, k.deleted_at, k.revoke_reason, k.created_by,
  (select display_name from bzup.workspace_members m where m.workspace_id = k.workspace_id and m.user_id = k.created_by) as creator_name,
  (k.status = 'active' and k.deleted_at is null and clock_timestamp() < k.expires_at
   and (k.scheduled_revoke_at is null or clock_timestamp() < k.scheduled_revoke_at)) as live`;

/** 원문·해시를 포함하지 않는 키 메타데이터 */
export function keyMeta(k: KeyRow) {
  const effective = k.deleted_at ? 'deleted'
    : k.status === 'revoked' ? 'revoked'
    : k.live ? (k.scheduled_revoke_at ? 'rotating' : 'active')
    : k.status === 'suspended' ? 'suspended' : 'expired';
  return {
    key_id: k.id,
    name: k.name,
    key_prefix: k.key_prefix,
    scopes: k.scopes,
    status: k.status,
    effective_status: effective,
    expires_at: toIso(k.expires_at)!,
    scheduled_revoke_at: toIso(k.scheduled_revoke_at),
    created_at: toIso(k.created_at)!,
    created_by_name: k.creator_name,
    last_used_at: toIso(k.last_used_at),
    revoked_at: toIso(k.revoked_at),
    revoke_reason: k.revoke_reason,
  };
}

async function findSystemClient(q: Queryable, workspaceId: string) {
  const [c] = await q.query<{ id: string; default_course_id: string | null; version: number; status: string; name: string }>(
    `select id, default_course_id, version, status, name from bzup.api_clients
      where workspace_id = $1 and is_system and status <> 'deleted'`,
    [workspaceId],
  );
  return c ?? null;
}

async function ensureSystemClient(q: Queryable, owner: UserPrincipal) {
  const existing = await findSystemClient(q, owner.workspaceId);
  if (existing) return existing;
  const [c] = await q.query<{ id: string; default_course_id: string | null; version: number; status: string; name: string }>(
    `insert into bzup.api_clients (workspace_id, name, status, is_system, created_by, updated_by)
     values ($1, $2, 'active', true, $3, $3)
     returning id, default_course_id, version, status, name`,
    [owner.workspaceId, SYSTEM_CLIENT_NAME, owner.userId],
  );
  await audit(q, owner, { objectType: 'api_client', objectId: c.id, action: 'api_client_created', after: { name: c.name, is_system: true } });
  return c;
}

async function requireCurrentOwner(q: Queryable, p: UserPrincipal) {
  const cur = await recheckPrincipal(q, p);
  if (cur.role !== 'owner') throw new AppError('INSUFFICIENT_PERMISSION');
  return cur;
}

// ---------------------------------------------------------------------------
// 조회
// ---------------------------------------------------------------------------
export async function getSystemApiStatus(db: Db, owner: UserPrincipal) {
  await requireCurrentOwner(db, owner);
  const client = await findSystemClient(db, owner.workspaceId);
  if (!client) return { client: null, etag: null, keys: [], history: [] };
  const keys = await db.query<KeyRow>(
    `select ${KEY_COLUMNS} from bzup.api_keys k
      where k.workspace_id = $1 and k.api_client_id = $2
      order by k.created_at desc limit 30`,
    [owner.workspaceId, client.id],
  );
  const metas = keys.map(keyMeta);
  return {
    client: { id: client.id, name: client.name, default_course_id: client.default_course_id, version: Number(client.version) },
    etag: clientEtag(client.id, Number(client.version)),
    keys: metas.filter((k) => ['active', 'rotating', 'suspended'].includes(k.effective_status)),
    history: metas.filter((k) => !['active', 'rotating', 'suspended'].includes(k.effective_status)).slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// 발급·재발급 (§13.8, §13.10, §13.13)
// ---------------------------------------------------------------------------
interface IssueInput { expiresInDays: number; overlapHours: number; name: string; memo: string | null }

function parseIssueBody(body: unknown): IssueInput {
  if (!isObject(body)) throw new AppError('INVALID_JSON');
  assertAllowedFields(body, ['expires_in_days', 'overlap_hours', 'name', 'memo']);
  const days = body.expires_in_days === undefined ? 90 : body.expires_in_days;
  if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 365) {
    throw new AppError('INVALID_EXPIRATION', '유효기간은 1~365일 사이의 정수로 지정해 주세요. 무기한 키는 발급하지 않습니다.');
  }
  const overlap = body.overlap_hours === undefined ? 24 : body.overlap_hours;
  if (!Number.isInteger(overlap) || (overlap as number) < 0 || (overlap as number) > 168) {
    throw validationError('기존 키 병행 사용 시간은 0~168시간입니다.');
  }
  const name = optionalText(body.name, 'name', '키 이름', 80) ?? '시스템 API 키';
  return { expiresInDays: days as number, overlapHours: overlap as number, name, memo: optionalText(body.memo, 'memo', '메모', 300) };
}

const ISSUE_ROUTE = '/admin/api-key/keys';

export async function issueSystemKey(db: Db, owner: UserPrincipal, body: unknown, idempotencyKey: string, requestId: string) {
  const input = parseIssueBody(body);
  const requestHash = hashRequest(body);
  const keyHash = sha256(idempotencyKey);
  await requireCurrentOwner(db, owner);
  await consume(db, limits.write(owner));

  // 원문은 트랜잭션 커밋 후 이 응답으로만 전달된다. 로그·멱등성 응답 저장·DB 에 남기지 않는다.
  const result = await db.tx(async (q): Promise<
    { replay: true; key: ReturnType<typeof keyMeta> } | { replay: false; key: ReturnType<typeof keyMeta>; plaintext: string }
  > => {
    // 같은 owner·경로·요청 키의 처리 권한 (호스트 제외)
    await lockRequestScope(q, `keyissue|${owner.workspaceId}|${owner.userId}|POST|${ISSUE_ROUTE}|${keyHash.toString('hex')}`);
    await requireCurrentOwner(q, owner);
    const [prev] = await q.query<{ normalized_request_hash: Uint8Array; result_key_id: string }>(
      `select normalized_request_hash, result_key_id from bzup.api_key_issue_requests
        where workspace_id = $1 and actor_user_id = $2 and method = 'POST' and canonical_route = $3 and request_key_hash = $4`,
      [owner.workspaceId, owner.userId, ISSUE_ROUTE, keyHash],
    );
    if (prev) {
      if (!Buffer.from(prev.normalized_request_hash).equals(requestHash)) throw new AppError('IDEMPOTENCY_KEY_REUSED');
      const [k] = await q.query<KeyRow>(`select ${KEY_COLUMNS} from bzup.api_keys k where k.id = $1`, [prev.result_key_id]);
      return { replay: true, key: keyMeta(k) };
    }

    await lockWorkspace(q, owner.workspaceId);
    const cur = await requireCurrentOwner(q, owner);
    const client = await ensureSystemClient(q, cur);
    if (client.status !== 'active') throw new AppError('API_CLIENT_STATE_CONFLICT', '시스템 API 연동이 중지되어 있습니다.');

    // 기존 유효 키 처리
    const existing = await q.query<KeyRow>(
      `select ${KEY_COLUMNS} from bzup.api_keys k
        where k.workspace_id = $1 and k.api_client_id = $2 and k.status in ('active','suspended') and k.deleted_at is null
          and clock_timestamp() < k.expires_at and (k.scheduled_revoke_at is null or clock_timestamp() < k.scheduled_revoke_at)
        for update`,
      [cur.workspaceId, client.id],
    );
    for (const old of existing) {
      if (input.overlapHours === 0) {
        await q.query(
          `update bzup.api_keys set status='revoked', revoked_at=clock_timestamp(), revoked_by=$2, revoke_reason=$3,
                  deleted_at=clock_timestamp(), deleted_by=$2, secret_hash=null, version=version+1,
                  updated_at=clock_timestamp(), updated_by=$2
            where id=$1`,
          [old.id, cur.userId, '재발급으로 즉시 폐기'],
        );
        await audit(q, cur, { objectType: 'api_key', objectId: old.id, action: 'api_key_revoked', before: keyMeta(old), reason: '재발급으로 즉시 폐기', requestId });
      } else if (!old.scheduled_revoke_at) {
        // 종료 시각은 원래 만료와 예약 폐기 중 빠른 시각. 한 번 정하면 뒤로 미루지 않는다.
        await q.query(
          `update bzup.api_keys set scheduled_revoke_at = least(expires_at, clock_timestamp() + make_interval(hours => $2)),
                  rotation_reason = '재발급', version = version + 1, updated_at = clock_timestamp(), updated_by = $3
            where id = $1`,
          [old.id, input.overlapHours, cur.userId],
        );
        await audit(q, cur, { objectType: 'api_key', objectId: old.id, action: 'api_key_rotation_scheduled', before: keyMeta(old), after: { overlap_hours: input.overlapHours }, requestId });
      }
    }
    const [{ n }] = await q.query<{ n: number }>(
      `select count(*)::int as n from bzup.api_keys k
        where k.api_client_id = $1 and k.status in ('active','suspended') and k.deleted_at is null
          and clock_timestamp() < k.expires_at and (k.scheduled_revoke_at is null or clock_timestamp() < k.scheduled_revoke_at)`,
      [client.id],
    );
    if (Number(n) + 1 > MAX_LIVE_KEYS) throw new AppError('API_KEY_LIMIT_EXCEEDED', '함께 사용할 수 있는 키는 최대 5개입니다. 기존 키를 폐기한 뒤 다시 발급해 주세요.');

    // public_id 충돌은 극히 드물지만 재생성한다
    let inserted: KeyRow | null = null;
    let plaintext = '';
    for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
      const g = generateApiKey(serviceKeyEnvironment());
      const rows = await q.query<{ id: string }>(
        `insert into bzup.api_keys (workspace_id, api_client_id, name, memo, public_id, environment, key_prefix, secret_hash,
            scopes, status, expires_at, rotation_of_key_id, created_by, created_at, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active', clock_timestamp() + make_interval(days => $10), $11, $12, clock_timestamp(), $12)
         on conflict (public_id) do nothing
         returning id`,
        [cur.workspaceId, client.id, input.name, input.memo, g.publicId, serviceKeyEnvironment(), g.keyPrefix, g.secretHash,
          [...API_SCOPES], input.expiresInDays, existing[0]?.id ?? null, cur.userId],
      );
      if (rows[0]) {
        [inserted] = await q.query<KeyRow>(`select ${KEY_COLUMNS} from bzup.api_keys k where k.id = $1`, [rows[0].id]);
        plaintext = g.plaintext;
      }
    }
    if (!inserted) throw new AppError('SERVICE_UNAVAILABLE', '키를 발급하지 못했습니다. 다시 시도해 주세요.');

    await q.query(
      `insert into bzup.api_key_issue_requests
         (workspace_id, actor_user_id, method, canonical_route, request_key_hash, normalized_request_hash, api_client_id, result_key_id, rotation_of_key_id)
       values ($1,$2,'POST',$3,$4,$5,$6,$7,$8)`,
      [cur.workspaceId, cur.userId, ISSUE_ROUTE, keyHash, requestHash, client.id, inserted.id, existing[0]?.id ?? null],
    );
    await audit(q, cur, {
      objectType: 'api_key', objectId: inserted.id, action: existing.length ? 'api_key_rotated' : 'api_key_issued',
      after: keyMeta(inserted), requestId,
    });
    return { replay: false, key: keyMeta(inserted), plaintext };
  });

  if (result.replay) {
    return {
      status: 200,
      body: {
        data: { ...result.key, secret_available: false },
        code: 'KEY_ALREADY_CREATED',
        message: '이미 발급된 키입니다. 원문을 보관하지 못했다면 이 키를 폐기하고 새로 발급해 주세요.',
      },
    };
  }
  return { status: 201, body: { data: { ...result.key, api_key: result.plaintext, secret_available: true } } };
}

// ---------------------------------------------------------------------------
// 폐기 (§13.11)
// ---------------------------------------------------------------------------
export async function revokeSystemKey(db: Db, owner: UserPrincipal, keyId: string, body: unknown, idempotencyKey: string, requestId: string) {
  if (!isObject(body)) throw new AppError('INVALID_JSON');
  assertAllowedFields(body, ['reason']);
  const reason = optionalText(body.reason, 'reason', '폐기 사유', 300);
  if (!reason) throw validationError('폐기 사유를 입력해 주세요.', [{ field: 'reason', message: '1~300자' }]);
  return runAdminWrite(db, owner, {
    method: 'DELETE', route: `/admin/api-key/keys/${keyId}`, idempotencyKey, hashInput: body, resultObjectType: 'api_key',
  }, async (q, cur) => {
    const [k] = await q.query<KeyRow & { is_system: boolean }>(
      `select ${KEY_COLUMNS}, c.is_system from bzup.api_keys k
         join bzup.api_clients c on c.id = k.api_client_id
        where k.workspace_id = $1 and k.id = $2 for update of k`,
      [cur.workspaceId, keyId],
    );
    if (!k || !k.is_system) throw new AppError('NOT_FOUND');
    if (!k.deleted_at) {
      await q.query(
        `update bzup.api_keys set status='revoked', revoked_at=coalesce(revoked_at, clock_timestamp()), revoked_by=coalesce(revoked_by, $2),
                revoke_reason=coalesce(revoke_reason, $3), deleted_at=clock_timestamp(), deleted_by=$2, secret_hash=null,
                version=version+1, updated_at=clock_timestamp(), updated_by=$2
          where id=$1`,
        [keyId, cur.userId, reason],
      );
      await audit(q, cur, { objectType: 'api_key', objectId: keyId, action: 'api_key_deleted', before: keyMeta(k), reason, requestId });
    }
    return { status: 204, body: null, headers: {}, objectId: keyId };
  });
}

// ---------------------------------------------------------------------------
// 기본 강의 (§13.4)
// ---------------------------------------------------------------------------
export async function updateSystemClient(db: Db, owner: UserPrincipal, body: unknown, ifMatch: string, idempotencyKey: string, requestId: string) {
  if (!isObject(body)) throw new AppError('INVALID_JSON');
  assertAllowedFields(body, ['default_course_id']);
  if (!('default_course_id' in body)) throw validationError('default_course_id가 필요합니다.');
  const courseId = body.default_course_id === null ? null : uuidField(body.default_course_id, 'default_course_id');
  return runAdminWrite(db, owner, {
    method: 'PATCH', route: '/admin/api-key', idempotencyKey, hashInput: { body, if_match: ifMatch }, resultObjectType: 'api_client',
  }, async (q, cur) => {
    const client = await ensureSystemClient(q, cur);
    const etag = clientEtag(client.id, Number(client.version));
    if (ifMatch !== etag) throw new AppError('PRECONDITION_FAILED', undefined, { headers: { ETag: etag } });
    if (courseId) {
      const [c] = await q.query<{ status: string }>(`select status from bzup.courses where workspace_id = $1 and id = $2`, [cur.workspaceId, courseId]);
      if (!c) throw new AppError('COURSE_REQUIRED', '선택한 강의를 찾을 수 없습니다.');
      if (c.status !== 'active') throw new AppError('COURSE_NOT_ACTIVE');
    }
    let version = Number(client.version);
    if (courseId !== client.default_course_id) {
      const [u] = await q.query<{ version: number }>(
        `update bzup.api_clients set default_course_id=$2, version=version+1, updated_by=$3, updated_at=clock_timestamp()
          where id=$1 returning version`,
        [client.id, courseId, cur.userId],
      );
      version = Number(u.version);
      await audit(q, cur, {
        objectType: 'api_client', objectId: client.id, action: 'api_client_default_course_changed',
        before: { default_course_id: client.default_course_id }, after: { default_course_id: courseId }, requestId,
      });
    }
    return {
      status: 200,
      body: { data: { id: client.id, default_course_id: courseId, version } },
      headers: { ETag: clientEtag(client.id, version) },
      objectId: client.id,
    };
  });
}
