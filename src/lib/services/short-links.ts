// 짧은 주소 유형(type_key) 기반 발급 (docs/short-link-api-type-key-request.md)
// 처리 순서: 인증·권한(라우트) → 입력 형식 → 강의 확인 → 같은 강의·유형 링크 존재 시 409 (유형 비활성이어도)
//           → 미등록 유형 422 UNKNOWN_LINK_TYPE → 비활성 유형 422 LINK_TYPE_INACTIVE → 생성
//
// 전환형 유형(slots 가 있는 유형): 링크 하나에 전환 주소 2~5개. 첫 주소만 필수이고 나머지는 나중에 채운다.
// 강의 + 유형으로 링크를 찾아 상태 조회·주소 채우기·전환을 한다 (링크 ID·ETag 불필요).
import { randomUUID } from 'node:crypto';
import { AppError, validationError, type RowError } from '@/lib/errors';
import type { Db, Queryable } from '@/lib/db/types';
import { hasPermission, requirePermission, type Principal } from '@/lib/auth/principal';
import { assertAllowedFields, isObject, UUID_RE } from '@/lib/validation';
import { parseDestination, type ParsedDestination } from '@/lib/url/destination';
import { toIso } from '@/lib/time';
import {
  createSingleLink, getLink, loadSlots, parsePatchBody, parseSingleCreateBody, patchLink, type LinkSlot, type WriteContext,
} from './links';
import { loadUrlPolicy, shortUrlFor } from './settings';
import { SLOT_KEY_RE, type SlotDef } from './slot-defs';

export const TYPE_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const ALLOWED_FIELDS = ['course_id', 'type_key', 'destination_url', 'name', 'slot_urls'] as const;

export interface ShortLinkType { key: string; label: string; active: boolean; slots: SlotDef[] | null }

const TYPE_COLUMNS = 'key, label, active, slots';

export async function loadShortLinkType(q: Queryable, key: string): Promise<ShortLinkType | null> {
  const [t] = await q.query<ShortLinkType>(`select ${TYPE_COLUMNS} from bzup.short_link_types where key = $1`, [key]);
  return t ?? null;
}

/** GET /api/v1/short-link-types: 활성·비활성 모두, key 오름차순. slots: 전환형 유형의 전환 주소 구성 (일반 유형은 null) */
export async function listShortLinkTypes(q: Queryable, p: Principal): Promise<ShortLinkType[]> {
  // 기존 생성용 키(links:create)로도 조회 가능해야 한다
  if (!hasPermission(p, 'links:create') && !hasPermission(p, 'links:read')) requirePermission(p, 'links:create');
  return q.query<ShortLinkType>(`select ${TYPE_COLUMNS} from bzup.short_link_types order by key collate "C"`);
}

export interface TypedCreateInput {
  courseId: string;
  typeKey: string;
  base: Record<string, unknown>;
  /** 전환형 유형의 slot_urls ({ 전환키: URL | null }). 유형을 확인한 뒤 해석한다 */
  slotUrls: Record<string, string | null> | null;
}

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
  let slotUrls: Record<string, string | null> | null = null;
  if (body.slot_urls !== undefined && body.slot_urls !== null) {
    if (!isObject(body.slot_urls) || Array.isArray(body.slot_urls)) {
      throw validationError('slot_urls 는 { "전환키": "URL" 또는 null } 형식의 객체입니다.', [{ field: 'slot_urls', message: '객체 형식' }]);
    }
    slotUrls = {};
    for (const [k, v] of Object.entries(body.slot_urls)) {
      if (v !== null && typeof v !== 'string') {
        throw validationError(`slot_urls.${k} 는 URL 문자열 또는 null 입니다.`, [{ field: `slot_urls.${k}`, message: '문자열 또는 null' }]);
      }
      slotUrls[k] = typeof v === 'string' && v.trim() === '' ? null : v;
    }
  }
  // 이름·주소 형식은 기존 검증을 그대로 사용 (최대 2,000자, http/https, 사용자 정보 금지 등)
  const base = { course_id: body.course_id.toLowerCase(), name: body.name, destination_url: body.destination_url };
  // 전환형은 첫 주소를 slot_urls 로 받을 수 있어 destination_url 이 없을 수 있다 → 주소는 유형 확인 뒤 검증
  const noDest = base.destination_url === undefined || base.destination_url === null || base.destination_url === '';
  parseSingleCreateBody(slotUrls && noDest ? { ...base, destination_url: 'https://example.com/' } : base);
  return { courseId: base.course_id, typeKey: body.type_key, base, slotUrls };
}

/**
 * 유형 구성에 맞춰 전환 주소를 해석한다.
 * - 일반 유형: slot_urls 를 받지 않는다
 * - 전환형 유형: 첫 주소(필수)는 slot_urls[첫 키] 또는 destination_url, 나머지는 비워 둘 수 있다
 */
export function resolveTypedSlots(type: ShortLinkType, input: TypedCreateInput) {
  if (!type.slots) {
    if (input.slotUrls) {
      throw validationError(`'${type.label}' 유형은 전환 주소를 쓰지 않습니다. destination_url 만 보내 주세요.`,
        [{ field: 'slot_urls', message: '전환형 유형이 아님' }]);
    }
    return { destinationUrl: input.base.destination_url, slots: null };
  }
  const map = input.slotUrls ?? {};
  const keys = type.slots.map((d) => d.key);
  const unknown = Object.keys(map).filter((k) => !keys.includes(k));
  if (unknown.length) {
    throw validationError(`'${type.label}' 유형에 없는 전환 키입니다: ${unknown.join(', ')} (사용 가능: ${keys.join(', ')})`,
      unknown.map((k) => ({ field: `slot_urls.${k}`, message: '없는 전환 키' })));
  }
  const first = type.slots[0];
  const dest = typeof input.base.destination_url === 'string' && input.base.destination_url.trim() ? input.base.destination_url : null;
  const firstFromMap = map[first.key] ?? null;
  if (dest && firstFromMap && firstFromMap !== dest) {
    throw validationError(`destination_url 과 slot_urls.${first.key} 가 다릅니다. 하나만 보내 주세요.`,
      [{ field: `slot_urls.${first.key}`, message: '불일치' }]);
  }
  const firstUrl = firstFromMap ?? dest;
  if (!firstUrl) {
    throw validationError(`첫 번째 전환 주소(${first.key}: ${first.label})는 필수입니다.`, [{ field: `slot_urls.${first.key}`, message: '필수' }]);
  }
  const errors: RowError[] = [];
  const slots = type.slots.map((d, i) => {
    const raw = i === 0 ? firstUrl : map[d.key] ?? null;
    let url: ParsedDestination | null = null;
    if (raw !== null) {
      try { url = parseDestination(raw); } catch (e) {
        if (!(e instanceof AppError)) throw e;
        errors.push({ field: `slot_urls.${d.key}`, message: e.message });
      }
    }
    return { key: d.key, label: d.label, url };
  });
  if (errors.length) throw validationError('전환 주소를 확인해 주세요.', errors);
  return { destinationUrl: firstUrl, slots };
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
  const type = await loadShortLinkType(q, typeKey);
  const existing = await findExisting(q, p.workspaceId, courseId, typeKey);
  if (existing && type) throw await existsError(q, courseId, type, existing);
  if (!type) throw new AppError('UNKNOWN_LINK_TYPE');
  if (!type.active) throw new AppError('LINK_TYPE_INACTIVE');
  return type;
}

const slotOut = (sl: LinkSlot) => ({ key: sl.slot_key, label: sl.label, destination_url: sl.destination_url });

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
    type = (await loadShortLinkType(db, input.typeKey))!;
  }
  const resolved = resolveTypedSlots(type, input);
  const run = (extra: Record<string, unknown>, key: string) =>
    createSingleLink(db, p, {
      ...parseSingleCreateBody({ ...input.base, destination_url: resolved.destinationUrl, ...extra }),
      linkType: input.typeKey,
      slots: resolved.slots,
    }, { ...ctx, idempotencyKey: key });
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
  const slots = type.slots ? await loadSlots(db, d.id) : null;
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
      ...(slots ? { active_slot: slots[0]?.slot_key ?? null, slots: slots.map(slotOut) } : {}),
      created_at: d.created_at,
    },
  };
}

// ---------------------------------------------------------------------------
// 전환형 짧은 주소: 강의 + 유형으로 찾아 상태 조회 · 주소 채우기 · 전환
// 같은 요청을 반복해도 결과가 같다 (이미 그 상태면 변경 없음 → changed_fields: []).
// ---------------------------------------------------------------------------
interface TypedTarget { courseId: string; typeKey: string }

function parseTarget(src: Record<string, unknown>): TypedTarget {
  if (src.course_id === undefined || src.course_id === null || src.course_id === '') {
    throw new AppError('COURSE_REQUIRED', 'course_id(강의 UUID)를 포함해 주세요.');
  }
  if (typeof src.course_id !== 'string' || !UUID_RE.test(src.course_id)) {
    throw new AppError('COURSE_REQUIRED', '강의를 찾을 수 없습니다.');
  }
  if (typeof src.type_key !== 'string' || !TYPE_KEY_RE.test(src.type_key)) {
    throw validationError('type_key 를 확인해 주세요.', [{ field: 'type_key', message: '형식: ^[a-z][a-z0-9_]{0,63}$' }]);
  }
  return { courseId: src.course_id.toLowerCase(), typeKey: src.type_key };
}

function parseSlotKey(v: unknown): string {
  if (typeof v !== 'string' || !SLOT_KEY_RE.test(v)) {
    throw validationError('slot 은 전환 키(예: chat, youtube)입니다.', [{ field: 'slot', message: '전환 키' }]);
  }
  return v;
}

async function loadTyped(q: Queryable, p: Principal, t: TypedTarget) {
  const existing = await findExisting(q, p.workspaceId, t.courseId, t.typeKey);
  if (!existing) {
    throw new AppError('NOT_FOUND', '이 강의에 해당 유형의 짧은 주소가 없습니다. 먼저 POST /api/v1/short-links 로 만들어 주세요.');
  }
  const loaded = await getLink(q, p, existing.id);
  const type = await loadShortLinkType(q, t.typeKey);
  return { ...loaded, typeLabel: type?.label ?? null };
}
type Typed = Awaited<ReturnType<typeof loadTyped>>;

function stateBody(x: Typed, changed?: string[]) {
  const { link, slots, policy } = x;
  const active = slots && link.active_slot !== null ? slots[Number(link.active_slot)] ?? null : null;
  return {
    link_id: link.id,
    short_url: shortUrlFor(policy.primaryHost, link.short_code),
    short_code: link.short_code,
    course_id: link.course_id,
    type_key: link.type_key ?? null,
    type_label: x.typeLabel,
    name: link.name,
    status: link.status,
    destination_url: link.destination_url,
    switchable: Boolean(slots),
    active_slot: active?.slot_key ?? null,
    active_slot_label: active?.label ?? null,
    slots: slots ? slots.map(slotOut) : null,
    updated_at: toIso(link.updated_at),
    ...(changed ? { changed_fields: changed } : {}),
  };
}

/** GET /api/v1/short-links?course_id=&type_key= */
export async function getTypedLinkState(db: Db, p: Principal, query: Record<string, unknown>) {
  requirePermission(p, 'links:read');
  return stateBody(await loadTyped(db, p, parseTarget(query)));
}

function requireSlot(x: Typed, key: string): LinkSlot {
  if (!x.slots) throw new AppError('LINK_NOT_SWITCHABLE');
  const slot = x.slots.find((sl) => sl.slot_key === key);
  if (!slot) {
    const keys = x.slots.map((sl) => sl.slot_key).filter(Boolean).join(', ');
    throw new AppError('UNKNOWN_SLOT', `없는 전환 키입니다: ${key} (사용 가능: ${keys})`);
  }
  return slot;
}

/** 현재 상태를 읽어 patchLink 로 반영한다. 그 사이 다른 변경이 끼어들면(버전 충돌) 다시 읽어 재시도한다 */
async function applyTyped(db: Db, p: Principal, t: TypedTarget, ctx: WriteContext, build: (x: Typed) => Record<string, unknown> | null) {
  requirePermission(p, 'links:update');
  for (let attempt = 0; ; attempt++) {
    const x = await loadTyped(db, p, t);
    const body = build(x);
    if (!body) return stateBody(x, []);
    try {
      const r = await patchLink(db, p, x.link.id, parsePatchBody(body), x.etag, { ...ctx, idempotencyKey: randomUUID() });
      const changed = (r.body as { changed_fields: string[] }).changed_fields;
      return stateBody(await loadTyped(db, p, t), changed);
    } catch (e) {
      if (e instanceof AppError && e.code === 'PRECONDITION_FAILED' && attempt < 2) continue;
      throw e;
    }
  }
}

/**
 * PUT /api/v1/short-links/slots: 전환 주소 채우기·바꾸기·비우기 (activate=true 면 채우고 바로 전환)
 * { course_id, type_key, slot, destination_url: "https://..." | null, activate?: boolean }
 */
export async function setTypedSlot(db: Db, p: Principal, body: unknown, ctx: WriteContext) {
  if (!isObject(body)) throw new AppError('INVALID_JSON');
  assertAllowedFields(body, ['course_id', 'type_key', 'slot', 'destination_url', 'activate']);
  const t = parseTarget(body);
  const key = parseSlotKey(body.slot);
  if (!('destination_url' in body)) {
    throw validationError('destination_url 을 보내 주세요. 비우려면 null 을 보냅니다.', [{ field: 'destination_url', message: '필수 (null 허용)' }]);
  }
  const rawUrl = body.destination_url;
  if (rawUrl !== null && typeof rawUrl !== 'string') throw validationError('destination_url 은 URL 문자열 또는 null 입니다.');
  const url = rawUrl === null || rawUrl.trim() === '' ? null : parseDestination(rawUrl).stored;
  if (body.activate !== undefined && typeof body.activate !== 'boolean') throw validationError('activate 는 true/false 입니다.');
  const activate = body.activate === true;
  if (activate && !url) throw new AppError('SLOT_EMPTY', '주소를 비우면서 전환할 수는 없습니다.');
  return applyTyped(db, p, t, ctx, (x) => {
    const slot = requireSlot(x, key);
    const isActive = Number(x.link.active_slot) === slot.position;
    if (!url && isActive) {
      throw new AppError('SLOT_EMPTY', `'${slot.label}' 주소는 지금 연결 중이라 비울 수 없습니다. 다른 주소로 먼저 전환해 주세요.`);
    }
    const urlChanged = slot.destination_url !== url;
    const switchNeeded = activate && !isActive;
    if (!urlChanged && !switchNeeded) return null;
    return {
      ...(urlChanged ? { slot_urls: x.slots!.map((sl) => (sl.position === slot.position ? url : sl.destination_url)) } : {}),
      ...(switchNeeded ? { active_slot: slot.position } : {}),
    };
  });
}

/** POST /api/v1/short-links/switch: { course_id, type_key, slot } */
export async function switchTypedSlot(db: Db, p: Principal, body: unknown, ctx: WriteContext) {
  if (!isObject(body)) throw new AppError('INVALID_JSON');
  assertAllowedFields(body, ['course_id', 'type_key', 'slot']);
  const t = parseTarget(body);
  const key = parseSlotKey(body.slot);
  return applyTyped(db, p, t, ctx, (x) => {
    const slot = requireSlot(x, key);
    if (!slot.destination_url) {
      throw new AppError('SLOT_EMPTY', `'${slot.label}' 주소가 비어 있어 전환할 수 없습니다. 주소를 먼저 채워 주세요 (PUT /api/v1/short-links/slots).`);
    }
    if (Number(x.link.active_slot) === slot.position) return null;
    return { active_slot: slot.position };
  });
}
