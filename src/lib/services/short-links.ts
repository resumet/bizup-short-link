// 짧은 주소 유형(type_key) 기반 발급 (docs/short-link-api-type-key-request.md)
// 처리 순서: 인증·권한(라우트) → 입력 형식 → 강의 확인 → 같은 강의·유형 링크 존재 시 409 (유형 비활성이어도)
//           → 미등록 유형 422 UNKNOWN_LINK_TYPE → 비활성 유형 422 LINK_TYPE_INACTIVE → 생성
import { AppError, validationError } from '@/lib/errors';
import type { Db, Queryable } from '@/lib/db/types';
import { requirePermission, type Principal } from '@/lib/auth/principal';
import { hasPermission } from '@/lib/auth/principal';
import { isObject } from '@/lib/validation';
import { UUID_RE } from '@/lib/validation';
import { createSingleLink, parseSingleCreateBody, type WriteContext } from './links';
import { loadUrlPolicy, shortUrlFor } from './settings';

export const TYPE_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const ALLOWED_FIELDS = ['course_id', 'type_key', 'destination_url', 'name'] as const;

export interface ShortLinkType { key: string; label: string; active: boolean }

/** GET /api/v1/short-link-types: 활성·비활성 모두, key 오름차순 */
export async function listShortLinkTypes(q: Queryable, p: Principal): Promise<ShortLinkType[]> {
  // 기존 생성용 키(links:create)로도 조회 가능해야 한다
  if (!hasPermission(p, 'links:create') && !hasPermission(p, 'links:read')) requirePermission(p, 'links:create');
  return q.query<ShortLinkType>(`select key, label, active from bzup.short_link_types order by key collate "C"`);
}

export interface TypedCreateInput { courseId: string; typeKey: string; base: Record<string, unknown> }

/** 요청 본문 검증. 구형 type 필드·알 수 없는 필드·형식 오류는 422 VALIDATION_ERROR */
export function parseTypedCreateBody(body: unknown): TypedCreateInput {
  if (!isObject(body)) throw new AppError('INVALID_JSON');
  if ('type' in body) {
    throw validationError('type 필드는 더 이상 지원하지 않습니다. type_key 를 사용해 주세요.', [{ field: 'type', message: '폐기된 필드' }]);
  }
  const extra = Object.keys(body).filter((k) => !(ALLOWED_FIELDS as readonly string[]).includes(k));
  if (extra.length) throw validationError(`허용되지 않은 필드입니다: ${extra.join(', ')}`, undefined, { fields: extra });
  if (body.type_key === undefined || body.type_key === null) {
    throw validationError('type_key 를 입력해 주세요.', [{ field: 'type_key', message: '필수' }]);
  }
  if (typeof body.type_key !== 'string' || !TYPE_KEY_RE.test(body.type_key)) {
    throw validationError('type_key 는 소문자 영문으로 시작하고 소문자 영문·숫자·밑줄만 쓸 수 있습니다 (1~64자).',
      [{ field: 'type_key', message: '형식: ^[a-z][a-z0-9_]{0,63}$' }]);
  }
  if (body.course_id === undefined || body.course_id === null || body.course_id === '') {
    throw new AppError('COURSE_REQUIRED', 'course_id(강의 UUID)를 포함해 주세요.');
  }
  if (typeof body.course_id !== 'string' || !UUID_RE.test(body.course_id)) {
    throw new AppError('COURSE_REQUIRED', '강의를 찾을 수 없습니다.');
  }
  // 이름·주소 형식은 기존 검증을 그대로 사용 (최대 2,000자, http/https, 사용자 정보 금지 등)
  const base = { course_id: body.course_id.toLowerCase(), name: body.name, destination_url: body.destination_url };
  parseSingleCreateBody(base);
  return { courseId: base.course_id, typeKey: body.type_key, base };
}

interface ExistingLink { id: string; short_code: string }

async function findExisting(q: Queryable, workspaceId: string, courseId: string, typeKey: string): Promise<ExistingLink | null> {
  const r = await q.query<ExistingLink>(
    `select id, short_code from bzup.links
      where workspace_id = $1 and course_id = $2 and type_key = $3 and deleted_at is null`,
    [workspaceId, courseId, typeKey],
  );
  return r[0] ?? null;
}

async function existsError(q: Queryable, courseId: string, type: ShortLinkType, link: ExistingLink) {
  const policy = await loadUrlPolicy(q);
  return new AppError('LINK_TYPE_EXISTS', undefined, {
    details: {
      course_id: courseId, type_key: type.key, type_label: type.label,
      link_id: link.id, short_code: link.short_code, short_url: shortUrlFor(policy.primaryHost, link.short_code),
    },
  });
}

/** 강의·유형 사전 확인 (트랜잭션 안의 최종 확인은 runCreate 가 회사 잠금 아래에서 다시 수행) */
export async function precheckTyped(q: Queryable, p: Principal, courseId: string, typeKey: string): Promise<ShortLinkType> {
  const course = await q.query<{ status: string }>(
    `select status from bzup.courses where workspace_id = $1 and id = $2`, [p.workspaceId, courseId],
  );
  if (!course[0]) throw new AppError('COURSE_REQUIRED', '강의를 찾을 수 없습니다.');
  if (course[0].status !== 'active') throw new AppError('COURSE_NOT_ACTIVE');
  const [type] = await q.query<ShortLinkType>(`select key, label, active from bzup.short_link_types where key = $1`, [typeKey]);
  const existing = await findExisting(q, p.workspaceId, courseId, typeKey);
  if (existing && type) throw await existsError(q, courseId, type, existing);
  if (!type) throw new AppError('UNKNOWN_LINK_TYPE');
  if (!type.active) throw new AppError('LINK_TYPE_INACTIVE');
  return type;
}

/** POST /api/v1/short-links */
export async function createTypedShortLink(db: Db, p: Principal, body: unknown, ctx: WriteContext, clientKey = false) {
  requirePermission(p, 'links:create');
  const input = parseTypedCreateBody(body);
  let type: ShortLinkType;
  let existsErr: AppError | null = null;
  try {
    type = await precheckTyped(db, p, input.courseId, input.typeKey);
  } catch (e) {
    // 호출자가 준 Idempotency-Key 로 이미 성공한 요청이면 원래 응답을 재사용해야 하므로 재생을 먼저 시도한다
    if (!(clientKey && e instanceof AppError && e.code === 'LINK_TYPE_EXISTS')) throw e;
    existsErr = e;
    const d = e.details as { type_key: string; type_label: string };
    type = { key: d.type_key, label: d.type_label, active: true };
  }
  const run = (extra: Record<string, unknown>, key: string) =>
    createSingleLink(db, p, { ...parseSingleCreateBody({ ...input.base, ...extra }), linkType: input.typeKey }, { ...ctx, idempotencyKey: key });
  let r;
  try {
    try {
      r = await run({}, ctx.idempotencyKey);
    } catch (e) {
      // 같은 목적지가 다른 링크에 있어도 확인 없이 새로 만든다 (같은 강의·유형만 막는다)
      const token = e instanceof AppError && e.code === 'DUPLICATE_DESTINATION' ? (e.details as { review_token?: string })?.review_token : null;
      if (!token) throw e;
      r = await run({ review_token: token, duplicate_decision: 'create_new' }, `${ctx.idempotencyKey}:dup`);
    }
  } catch (e) {
    if (existsErr && e instanceof AppError && e.code === 'LINK_TYPE_EXISTS') throw existsErr;
    // DB 고유 제약 충돌(동시 발급)도 409 로 기존 링크를 돌려준다
    if ((e as { code?: string })?.code === '23505') {
      const existing = await findExisting(db, p.workspaceId, input.courseId, input.typeKey);
      if (existing) throw await existsError(db, input.courseId, type, existing);
    }
    throw e;
  }
  const d = (r.body as { data: { id: string; short_code: string; short_url: string; course_id: string; type_key: string; name: string; destination_url: string; created_at: string } }).data;
  const [label] = await db.query<{ label: string }>(`select label from bzup.short_link_types where key = $1`, [d.type_key]);
  return {
    status: r.status,
    body: {
      short_url: d.short_url,
      short_code: d.short_code,
      link_id: d.id,
      course_id: d.course_id,
      type_key: d.type_key,
      type_label: label?.label ?? type.label,
      name: d.name,
      destination_url: d.destination_url,
      created_at: d.created_at,
    },
  };
}
