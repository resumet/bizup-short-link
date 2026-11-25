// 링크 생성·수정·조회 (PRD §5, §8, §11, §14, §16)
// 웹(/internal)과 외부 API(/api/v1)가 같은 로직을 공유한다.
import { randomUUID } from 'node:crypto';
import { AppError, validationError, type RowError } from '@/lib/errors';
import { generateShortCode, hashRequest } from '@/lib/crypto';
import { linkEtag } from '@/lib/etag';
import { toIso } from '@/lib/time';
import { parseDestination, assertAllowedDestination, type ParsedDestination } from '@/lib/url/destination';
import { pgConstraint, pgErrorCode, UNIQUE_VIOLATION, type Db, type Queryable } from '@/lib/db/types';
import { lockRequestScope, lockWorkspace } from '@/lib/db/locks';
import {
  principalRef, recheckPrincipal, requirePermission, sourceOf, type Principal,
} from '@/lib/auth/principal';
import {
  assertAllowedFields, cleanText, externalRefField, isObject, optionalText, uuidField,
} from '@/lib/validation';
import { loadUrlPolicy, shortUrlFor, type UrlPolicy } from './settings';
import { getLedger } from './ledger';
import {
  findSuccess, idemContext, idemScope, saveSuccess, type IdemContext, type StoredResponse,
} from './idempotency';
import {
  analyzeDuplicates, consumeReview, issueReview, needsConfirmation, normalizedInputHash,
  verifyReviewToken, type DuplicateAnalysis, type DupInputRow, type ReviewBinding,
} from './duplicates';
import { consume, limits } from './ratelimit';

export type ApiBase = '/api/v1' | '/internal';

// ---------------------------------------------------------------------------
// 표현
// ---------------------------------------------------------------------------
export interface LinkRow {
  id: string;
  workspace_id: string;
  issued_domain: string;
  short_code: string;
  name: string;
  initial_destination_url: string;
  destination_url: string;
  course_id: string | null;
  external_ref: string | null;
  status: 'active' | 'inactive';
  version: number;
  source: 'web' | 'api';
  creation_mode: 'single' | 'batch';
  generation_batch_id: string | null;
  created_by_type: string;
  created_by_id: string | null;
  created_by_label: string | null;
  updated_by_type: string;
  updated_by_id: string | null;
  updated_by_label: string | null;
  created_at: Date;
  updated_at: Date;
  active_slot: number | null;
}

export interface LinkSlot { position: number; label: string; destination_url: string | null }

/** 링크의 전환 주소 (없으면 null) */
export async function loadSlots(q: Queryable, linkId: string): Promise<LinkSlot[] | null> {
  const rows = await q.query<LinkSlot>(
    `select position, label, destination_url from bzup.link_destination_slots where link_id = $1 order by position`,
    [linkId],
  );
  return rows.length ? rows.map((r) => ({ ...r, position: Number(r.position) })) : null;
}

export const LINK_COLUMNS = `l.id, l.workspace_id, l.issued_domain, l.short_code, l.name, l.initial_destination_url,
  l.destination_url, l.course_id, l.external_ref, l.status, l.version, l.source, l.creation_mode,
  l.generation_batch_id, l.created_by_type, l.created_by_id, l.created_by_label, l.updated_by_type,
  l.updated_by_id, l.updated_by_label, l.created_at, l.updated_at, l.active_slot`;

export function serializeLink(
  l: LinkRow, policy: Pick<UrlPolicy, 'primaryHost' | 'urlConfigVersion'>, slots?: LinkSlot[] | null,
) {
  return {
    id: l.id,
    course_id: l.course_id,
    name: l.name,
    domain: policy.primaryHost,
    issued_domain: l.issued_domain,
    issued_short_url: shortUrlFor(l.issued_domain, l.short_code),
    url_config_version: policy.urlConfigVersion,
    short_code: l.short_code,
    short_url: shortUrlFor(policy.primaryHost, l.short_code),
    initial_destination_url: l.initial_destination_url,
    destination_url: l.destination_url,
    status: l.status,
    version: Number(l.version),
    source: l.source,
    creation_mode: l.creation_mode,
    generation_batch_id: l.generation_batch_id,
    external_ref: l.external_ref,
    created_by: { type: l.created_by_type, id: l.created_by_id, label: l.created_by_label },
    updated_by: { type: l.updated_by_type, id: l.updated_by_id, label: l.updated_by_label },
    created_at: toIso(l.created_at),
    updated_at: toIso(l.updated_at),
    active_slot: l.active_slot === null || l.active_slot === undefined ? null : Number(l.active_slot),
    ...(slots !== undefined ? { destination_slots: slots } : {}),
  };
}

// ---------------------------------------------------------------------------
// 강의
// ---------------------------------------------------------------------------
interface CourseRow { id: string; name: string; status: 'active' | 'closed' }

async function loadCourse(q: Queryable, workspaceId: string, id: string): Promise<CourseRow | null> {
  const r = await q.query<CourseRow>(
    `select id, name, status from bzup.courses where workspace_id = $1 and id = $2`,
    [workspaceId, id],
  );
  return r[0] ?? null;
}

async function requireActiveCourse(q: Queryable, workspaceId: string, id: string): Promise<CourseRow> {
  const c = await loadCourse(q, workspaceId, id);
  if (!c) throw new AppError('COURSE_REQUIRED', '선택한 강의를 찾을 수 없습니다.');
  if (c.status !== 'active') throw new AppError('COURSE_NOT_ACTIVE');
  return c;
}

// ---------------------------------------------------------------------------
// 생성 입력 해석
// ---------------------------------------------------------------------------
export interface SingleCreateInput {
  courseId: string | null;
  name: string;
  destination: ParsedDestination;
  externalRef: string | null;
  reviewToken: string | null;
  decision: 'create_new' | null;
  raw: Record<string, unknown>;
}

function parseReviewFields(body: Record<string, unknown>) {
  const reviewToken = body.review_token === undefined || body.review_token === null ? null : body.review_token;
  if (reviewToken !== null && (typeof reviewToken !== 'string' || reviewToken.length > 200)) {
    throw validationError('review_token 형식이 올바르지 않습니다.');
  }
  const decision = body.duplicate_decision ?? null;
  if (decision !== null && decision !== 'create_new') {
    throw validationError('duplicate_decision은 create_new만 사용할 수 있습니다.');
  }
  if ((reviewToken === null) !== (decision === null)) {
    throw validationError('review_token과 duplicate_decision=create_new를 함께 보내야 합니다.');
  }
  return { reviewToken: reviewToken as string | null, decision: decision as 'create_new' | null };
}

export function parseSingleCreateBody(body: unknown): SingleCreateInput {
  if (!isObject(body)) throw new AppError('INVALID_JSON');
  assertAllowedFields(body, ['course_id', 'name', 'destination_url', 'external_ref', 'review_token', 'duplicate_decision']);
  const errors: RowError[] = [];
  let name = '';
  let destination: ParsedDestination | null = null;
  try { name = cleanText(body.name, 'name', '명칭', 1, 120); } catch (e) { collect(e, errors, 'name'); }
  try { destination = parseDestination(body.destination_url); } catch (e) { collect(e, errors, 'destination_url'); }
  if (errors.length) throw validationError('입력값을 확인해 주세요.', errors);
  const courseId = body.course_id === undefined ? null : uuidField(body.course_id, 'course_id');
  if (body.course_id === null) throw validationError('course_id는 null일 수 없습니다.');
  return {
    courseId,
    name,
    destination: destination!,
    externalRef: externalRefField(body.external_ref),
    ...parseReviewFields(body),
    raw: body,
  };
}

function collect(e: unknown, errors: RowError[], field: string, extra: Partial<RowError> = {}) {
  if (e instanceof AppError) {
    if (e.rowErrors?.length) errors.push(...e.rowErrors.map((r) => ({ ...r, ...extra })));
    else errors.push({ field, message: e.message, ...extra });
    if (e.code !== 'VALIDATION_ERROR' && e.code !== 'INVALID_DESTINATION_URL') throw e;
    return;
  }
  throw e;
}

export interface BatchCreateInput {
  courseId: string | null;
  templateId: string;
  templateVersion: number;
  items: {
    templateItemId: string;
    destination: ParsedDestination;
    externalRef: string | null;
    /** 전환 주소 항목: 템플릿 라벨 순서의 URL (0번 필수, 나머지는 null 가능) */
    slotUrls: (ParsedDestination | null)[] | null;
  }[];
  reviewToken: string | null;
  decision: 'create_new' | null;
  raw: Record<string, unknown>;
}

const MAX_SLOT_URLS = 5;

function parseSlotUrls(raw: unknown, errors: RowError[], extra: Partial<RowError>): (ParsedDestination | null)[] | null {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_SLOT_URLS) {
    errors.push({ field: 'slot_urls', message: '전환 주소 목록 형식이 올바르지 않습니다.', ...extra });
    return null;
  }
  return raw.map((u, i) => {
    if ((u === null || u === undefined || (typeof u === 'string' && u.trim() === '')) && i > 0) return null;
    try {
      return parseDestination(u);
    } catch (e) {
      collect(e, errors, `slot_urls[${i}]`, extra);
      return null;
    }
  });
}

export function parseBatchCreateBody(body: unknown): BatchCreateInput {
  if (!isObject(body)) throw new AppError('INVALID_JSON');
  assertAllowedFields(body, ['course_id', 'template_id', 'template_version', 'items', 'review_token', 'duplicate_decision']);
  const templateId = uuidField(body.template_id, 'template_id');
  if (!Number.isInteger(body.template_version) || (body.template_version as number) < 1) {
    throw validationError('template_version이 올바르지 않습니다.');
  }
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) {
    throw new AppError('TEMPLATE_ITEMS_MISMATCH', '자동생성 항목은 1~100개여야 합니다.');
  }
  const errors: RowError[] = [];
  const items: BatchCreateInput['items'] = [];
  const seen = new Set<string>();
  body.items.forEach((it, idx) => {
    if (!isObject(it)) throw validationError(`${idx + 1}번째 항목 형식이 올바르지 않습니다.`);
    assertAllowedFields(it, ['template_item_id', 'destination_url', 'slot_urls', 'external_ref']);
    const templateItemId = uuidField(it.template_item_id, 'template_item_id');
    if (seen.has(templateItemId)) throw new AppError('TEMPLATE_ITEMS_MISMATCH', '같은 항목이 두 번 포함되어 있습니다.');
    seen.add(templateItemId);
    let destination: ParsedDestination | null = null;
    let slotUrls: (ParsedDestination | null)[] | null = null;
    if (it.slot_urls !== undefined) {
      if (it.destination_url !== undefined) throw validationError('destination_url과 slot_urls는 함께 보낼 수 없습니다.');
      const before = errors.length;
      slotUrls = parseSlotUrls(it.slot_urls, errors, { template_item_id: templateItemId, row: idx + 1 });
      if (slotUrls && errors.length === before) destination = slotUrls[0];
    } else {
      try { destination = parseDestination(it.destination_url); } catch (e) {
        collect(e, errors, 'destination_url', { template_item_id: templateItemId, row: idx + 1 });
      }
    }
    let externalRef: string | null = null;
    try { externalRef = externalRefField(it.external_ref); } catch (e) {
      collect(e, errors, 'external_ref', { template_item_id: templateItemId, row: idx + 1 });
    }
    items.push({ templateItemId, destination: destination!, externalRef, slotUrls });
  });
  if (errors.length) throw validationError('자동생성 목록의 주소를 확인해 주세요.', errors);
  const refs = items.map((i) => i.externalRef).filter((r): r is string => r !== null);
  if (new Set(refs).size !== refs.length) throw new AppError('EXTERNAL_REF_EXISTS', '같은 external_ref가 요청 안에 중복되어 있습니다.');
  const courseId = body.course_id === undefined ? null : uuidField(body.course_id, 'course_id');
  return {
    courseId,
    templateId,
    templateVersion: body.template_version as number,
    items,
    ...parseReviewFields(body),
    raw: body,
  };
}

// ---------------------------------------------------------------------------
// 생성 공통 처리 (§16.3)
// ---------------------------------------------------------------------------
class NeedsReview extends Error {
  constructor(readonly changed: boolean, readonly analysis: DuplicateAnalysis, readonly binding: ReviewBinding,
    readonly rows: DupInputRow[], readonly policy: UrlPolicy) {
    super('needs review');
  }
}
class RetryFromEntry extends Error {}

interface PlannedRow extends DupInputRow {
  linkId: string;
  /** 전환 주소: 라벨·URL (null = 아직 입력 안 함). 0번이 기본 연결 */
  slots: { label: string; url: ParsedDestination | null }[] | null;
  templateItemId: string | null;
  sortOrder: number;
  shortCode?: string;
}

interface CreatePlan {
  mode: 'single' | 'batch';
  /** 요청에 명시된 강의. 생략 시 null */
  requestedCourseId: string | null;
  reviewToken: string | null;
  decision: 'create_new' | null;
  templateId: string | null;
  templateVersion: number | null;
  /** 생성 예정 행 수 (생성량 한도 차감용) */
  rowCount: number;
  /** 배치: 트랜잭션 안에서 이름 목록과 대조해 행을 만든다 */
  buildRows: (q: Queryable) => Promise<PlannedRow[]>;
}

const MAX_CODE_ATTEMPTS = 5;
const MAX_ENTRY_RETRIES = 3;

async function reserveCodes(db: Db, policy: UrlPolicy, workspaceId: string, rows: PlannedRow[]): Promise<void> {
  const ledger = getLedger(db);
  // 제한된 병렬성
  const CONCURRENCY = 8;
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next++];
      let ok = false;
      for (let i = 0; i < MAX_CODE_ATTEMPTS && !ok; i++) {
        const code = generateShortCode();
        ok = await ledger.reserve({ namespaceId: policy.namespaceId, shortCode: code, linkId: row.linkId, workspaceId });
        if (ok) row.shortCode = code;
      }
      if (!ok) throw new AppError('SERVICE_UNAVAILABLE', '짧은 주소 코드를 발급하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
}

/** 강의는 모든 생성 요청에 강의 UUID(course_id)로 지정한다. API 기본 강의는 없다. */
function resolveCourseId(p: Principal, requested: string | null): string {
  if (requested) return requested;
  throw p.kind === 'api_client'
    ? new AppError('COURSE_REQUIRED', 'course_id(강의 UUID)를 포함해 주세요.')
    : new AppError('COURSE_REQUIRED');
}

async function checkExternalRefs(q: Queryable, workspaceId: string, rows: PlannedRow[]) {
  const refs = rows.map((r) => r.externalRef).filter((r): r is string => r !== null);
  if (!refs.length) return;
  const found = await q.query<{ external_ref: string }>(
    `select external_ref from bzup.links where workspace_id = $1 and external_ref = any($2::text[])`,
    [workspaceId, refs],
  );
  if (found.length) {
    throw new AppError('EXTERNAL_REF_EXISTS', '이미 사용 중인 external_ref입니다.', {
      details: { external_refs: found.map((f) => f.external_ref) },
    });
  }
}

async function runCreate(
  db: Db,
  principal: Principal,
  plan: CreatePlan,
  idem: IdemContext,
  requestId: string,
  apiBase: ApiBase,
): Promise<StoredResponse & { replayed: boolean }> {
  // 1) 빠른 성공 기록 조회
  const quick = await findSuccess(db, idem);
  if (quick) return { ...quick, replayed: true };

  // 일반 쓰기 한도와 신규 생성량 N건 (공유 카운터). 성공 재생은 차감하지 않고,
  // 내부 재시도로 같은 HTTP 요청의 N건을 반복 차감하지 않는다 (§16.3-4, §17.2).
  await consume(db, [...limits.write(principal), ...limits.newLinks(principal, plan.rowCount)]);

  for (let attempt = 0; ; attempt++) {
    try {
      return await db.tx(async (q) => {
        // 2) 멱등성 처리 권한 → 성공 기록 재확인
        await lockRequestScope(q, idemScope(idem));
        const replay = await findSuccess(q, idem);
        if (replay) return { ...replay, replayed: true };

        // 3) 신규 작업 사전 검증
        const resolvedCourseId = resolveCourseId(principal, plan.requestedCourseId);
        await requireActiveCourse(q, principal.workspaceId, resolvedCourseId);
        const rows = await plan.buildRows(q);
        const policy0 = await loadUrlPolicy(q);
        for (const r of rows) assertRowDestinations(r, policy0.serviceHosts);
        await checkExternalRefs(q, principal.workspaceId, rows);

        const binding: ReviewBinding = {
          mode: plan.mode,
          courseId: resolvedCourseId,
          templateId: plan.templateId,
          templateVersion: plan.templateVersion,
          inputHash: normalizedInputHash({
            mode: plan.mode, courseId: resolvedCourseId, templateId: plan.templateId,
            templateVersion: plan.templateVersion, rows,
          }),
        };
        const pre = await analyzeDuplicates(q, principal.workspaceId, rows);
        let reviewId: string | null = null;
        if (plan.reviewToken) {
          const rec = await verifyReviewToken(q, principal, plan.reviewToken, binding);
          reviewId = rec.id;
          if (needsConfirmation(pre) && !rec.digest.equals(pre.digest)) {
            throw new NeedsReview(true, pre, binding, rows, policy0);
          }
        } else if (needsConfirmation(pre)) {
          throw new NeedsReview(false, pre, binding, rows, policy0);
        }

        // 5) 독립 원장 코드 예약 — 회사 잠금 밖
        await reserveCodes(db, policy0, principal.workspaceId, rows);

        // 6) 회사 쓰기 잠금 후 최신 상태 재검사
        await lockWorkspace(q, principal.workspaceId);
        const p = await recheckPrincipal(q, principal, 'links:create');
        const course = await requireActiveCourse(q, p.workspaceId, resolvedCourseId);
        if (plan.mode === 'batch') {
          const t = await q.query<{ version: number }>(
            `select version from bzup.generation_templates where workspace_id = $1 and id = $2`,
            [p.workspaceId, plan.templateId],
          );
          if (!t[0] || Number(t[0].version) !== plan.templateVersion) throw new AppError('TEMPLATE_CHANGED');
        }
        const policy = await loadUrlPolicy(q);
        for (const r of rows) assertRowDestinations(r, policy.serviceHosts);
        await checkExternalRefs(q, p.workspaceId, rows);
        const fin = await analyzeDuplicates(q, p.workspaceId, rows);
        if (needsConfirmation(fin)) {
          if (!reviewId) throw new NeedsReview(false, fin, binding, rows, policy);
          if (!fin.digest.equals(pre.digest)) throw new NeedsReview(true, fin, binding, rows, policy);
        }

        // 7) 저장
        const actor = principalRef(p);
        const source = sourceOf(p);
        let batchId: string | null = null;
        if (plan.mode === 'batch') {
          const b = await q.query<{ id: string }>(
            `insert into bzup.generation_batches
               (workspace_id, course_id, template_id, template_version, issued_domain_snapshot,
                url_config_version_snapshot, count, source, actor_type, actor_id, actor_label_snapshot,
                api_key_id, request_id)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
            [p.workspaceId, course.id, plan.templateId, plan.templateVersion, policy.primaryHost,
              policy.urlConfigVersion, rows.length, source, actor.type, actor.id, actor.label, actor.apiKeyId, requestId],
          );
          batchId = b[0].id;
        }
        const created: LinkRow[] = [];
        for (const r of rows) {
          const ins = await q.query<LinkRow>(
            `insert into bzup.links as l
               (id, workspace_id, issued_domain, short_code, name, initial_destination_url, destination_url,
                canonical_destination, destination_fingerprint, course_id, external_ref, status, version, source,
                creation_mode, generation_batch_id, created_by_type, created_by_id, created_by_label,
                created_api_key_id, updated_by_type, updated_by_id, updated_by_label, created_at, updated_at, active_slot)
             values ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,'active',1,$11,$12,$13,$14,$15,$16,$17,$14,$15,$16,
                     clock_timestamp(), clock_timestamp(), $18)
             returning ${LINK_COLUMNS}`,
            [r.linkId, p.workspaceId, policy.primaryHost, r.shortCode, r.name, r.stored, r.canonical, r.fingerprint,
              course.id, r.externalRef, source, plan.mode, batchId, actor.type, actor.id, actor.label, actor.apiKeyId,
              r.slots ? 0 : null],
          );
          const link = ins[0];
          created.push(link);
          if (r.slots) {
            for (const [pos, sl] of r.slots.entries()) {
              await q.query(
                `insert into bzup.link_destination_slots (link_id, position, label, destination_url) values ($1,$2,$3,$4)`,
                [link.id, pos, sl.label, sl.url?.stored ?? null],
              );
            }
          }
          await q.query(
            `insert into bzup.link_revisions
               (workspace_id, link_id, version, action, changed_fields, before_snapshot, after_snapshot,
                actor_type, actor_id, actor_label_snapshot, api_key_id, generation_batch_id, request_id, created_at)
             values ($1,$2,1,'created',$3,null,$4::text::jsonb,$5,$6,$7,$8,$9,$10, $11)`,
            [p.workspaceId, link.id, ['name', 'destination_url', 'course_id', 'status'],
              JSON.stringify({ name: link.name, destination_url: link.destination_url, course_id: course.id,
                course_name_snapshot: course.name, status: 'active',
                ...(r.slots ? { active_slot: 0, active_slot_label: r.slots[0].label,
                  destination_slots: r.slots.map((x) => ({ label: x.label, destination_url: x.url?.stored ?? null })) } : {}) }),
              actor.type, actor.id, actor.label, actor.apiKeyId, batchId, requestId, link.created_at],
          );
          if (batchId) {
            await q.query(
              `insert into bzup.generation_batch_items
                 (batch_id, template_item_id, link_id, name_snapshot, destination_url_snapshot, short_url_snapshot, sort_order)
               values ($1,$2,$3,$4,$5,$6,$7)`,
              [batchId, r.templateItemId, link.id, link.name, link.destination_url,
                shortUrlFor(policy.primaryHost, link.short_code), r.sortOrder],
            );
          }
        }
        if (reviewId) await consumeReview(q, reviewId, requestId);

        let resp: StoredResponse;
        if (plan.mode === 'single') {
          const l = created[0];
          resp = {
            status: 201,
            body: { data: serializeLink(l, policy) },
            headers: {
              Location: `${apiBase}/links/${l.id}`,
              ETag: linkEtag(l.id, 1, policy.urlConfigVersion),
            },
          };
        } else {
          resp = {
            status: 201,
            body: {
              data: await batchBody(q, p.workspaceId, batchId!),
            },
            headers: { Location: `${apiBase}/link-batches/${batchId}` },
          };
        }
        await saveSuccess(q, idem, resp, {
          resolvedCourseId: course.id,
          resultLinkId: plan.mode === 'single' ? created[0].id : null,
          resultBatchId: batchId,
        });
        return { ...resp, replayed: false };
      });
    } catch (e) {
      if (e instanceof NeedsReview) {
        const review = await issueReview(db, principal, e.binding, e.rows, e.analysis, e.policy);
        throw new AppError(e.changed ? 'DUPLICATE_REVIEW_CHANGED' : 'DUPLICATE_DESTINATION', undefined, {
          details: review,
        });
      }
      const isCodeCollision = pgErrorCode(e) === UNIQUE_VIOLATION && (pgConstraint(e) ?? '').includes('short_code');
      if ((isCodeCollision || e instanceof RetryFromEntry) && attempt + 1 < MAX_ENTRY_RETRIES) continue;
      if (isCodeCollision) throw new AppError('SERVICE_UNAVAILABLE', '짧은 주소 코드를 발급하지 못했습니다.');
      if (pgErrorCode(e) === UNIQUE_VIOLATION && (pgConstraint(e) ?? '').includes('external_ref')) {
        throw new AppError('EXTERNAL_REF_EXISTS', '이미 사용 중인 external_ref입니다.');
      }
      throw e;
    }
  }
}

function parsedOf(r: DupInputRow): ParsedDestination {
  return { stored: r.stored, canonical: r.canonical, fingerprint: r.fingerprint, host: new URL(r.stored).hostname };
}

function plannedFrom(rowId: string, rowNumber: number, name: string, d: ParsedDestination, externalRef: string | null,
  templateItemId: string | null, sortOrder: number): PlannedRow {
  return {
    rowId, rowNumber, name, stored: d.stored, canonical: d.canonical, fingerprint: d.fingerprint, externalRef,
    linkId: randomUUID(), templateItemId, sortOrder, slots: null,
  };
}

/** 이름 목록 버전·활성 항목 구성과 요청 행을 대조해 생성할 행을 만든다 (생성·프리플라이트 공용) */
async function buildBatchRows(q: Queryable, workspaceId: string, input: BatchCreateInput): Promise<PlannedRow[]> {
  const t = await q.query<{ id: string; version: number }>(
    `select id, version from bzup.generation_templates where workspace_id = $1 and id = $2`,
    [workspaceId, input.templateId],
  );
  if (!t[0]) throw new AppError('NOT_FOUND', '자동생성 목록을 찾을 수 없습니다.');
  if (Number(t[0].version) !== input.templateVersion) throw new AppError('TEMPLATE_CHANGED');
  const items = await q.query<{ id: string; name: string; sort_order: number; destination_slots: string[] | null }>(
    `select id, name, sort_order, destination_slots from bzup.generation_template_items
      where template_id = $1 and is_active order by sort_order, id`,
    [input.templateId],
  );
  if (items.length === 0) throw new AppError('TEMPLATE_EMPTY');
  const byId = new Map(input.items.map((i) => [i.templateItemId, i]));
  const missing = items.filter((i) => !byId.has(i.id)).map((i) => i.id);
  const extra = input.items.filter((i) => !items.some((t2) => t2.id === i.templateItemId)).map((i) => i.templateItemId);
  if (missing.length || extra.length) {
    throw new AppError('TEMPLATE_ITEMS_MISMATCH', '자동생성 목록의 모든 활성 항목을 정확히 한 번씩 보내야 합니다.', {
      details: { missing_template_item_ids: missing, unknown_template_item_ids: extra },
    });
  }
  return items.map((it, idx) => {
    const inp = byId.get(it.id)!;
    const labels = it.destination_slots;
    if (labels && (!inp.slotUrls || inp.slotUrls.length !== labels.length)) {
      throw new AppError('TEMPLATE_ITEMS_MISMATCH', `'${it.name}' 항목은 전환 주소 ${labels.length}개(slot_urls)를 보내야 합니다.`, {
        details: { template_item_id: it.id, destination_slots: labels },
      });
    }
    if (!labels && inp.slotUrls) {
      throw new AppError('TEMPLATE_ITEMS_MISMATCH', `'${it.name}' 항목은 destination_url 하나만 받습니다.`, { details: { template_item_id: it.id } });
    }
    const row = plannedFrom(it.id, idx + 1, it.name, inp.destination, inp.externalRef, it.id, idx + 1);
    if (labels) {
      row.slots = labels.map((label, i) => ({ label, url: inp.slotUrls![i] }));
      row.slotUrls = row.slots.map((x) => x.url?.stored ?? null);
    }
    return row;
  });
}

/** 기본 목적지와 전환 주소 전체의 금지 목적지 검사 */
function assertRowDestinations(r: PlannedRow, serviceHosts: string[]) {
  assertAllowedDestination(parsedOf(r), serviceHosts);
  for (const sl of r.slots ?? []) if (sl.url) assertAllowedDestination(sl.url, serviceHosts);
}

export interface WriteContext {
  idempotencyKey: string;
  requestId: string;
  apiBase: ApiBase;
}

export async function createSingleLink(db: Db, principal: Principal, input: SingleCreateInput, ctx: WriteContext) {
  requirePermission(principal, 'links:create');
  const requestHash = hashRequest({ course_specified: input.courseId !== null, body: input.raw });
  const idem = idemContext(principal, 'POST', '/links', ctx.idempotencyKey, requestHash);
  return runCreate(db, principal, {
    mode: 'single',
    requestedCourseId: input.courseId,
    reviewToken: input.reviewToken,
    decision: input.decision,
    templateId: null,
    templateVersion: null,
    rowCount: 1,
    buildRows: async () => [plannedFrom('single', 1, input.name, input.destination, input.externalRef, null, 1)],
  }, idem, ctx.requestId, ctx.apiBase);
}

export async function createBatch(db: Db, principal: Principal, input: BatchCreateInput, ctx: WriteContext) {
  requirePermission(principal, 'links:create');
  const requestHash = hashRequest({ course_specified: input.courseId !== null, body: input.raw });
  const idem = idemContext(principal, 'POST', '/link-batches', ctx.idempotencyKey, requestHash);
  return runCreate(db, principal, {
    mode: 'batch',
    requestedCourseId: input.courseId,
    reviewToken: input.reviewToken,
    decision: input.decision,
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    rowCount: input.items.length,
    buildRows: (q) => buildBatchRows(q, principal.workspaceId, input),
  }, idem, ctx.requestId, ctx.apiBase);
}

export async function batchBody(q: Queryable, workspaceId: string, batchId: string) {
  const b = await q.query<{
    id: string; course_id: string; template_id: string; template_version: number; status: string; count: number;
    url_config_version_snapshot: number; issued_domain_snapshot: string; created_at: Date;
    actor_type: string; actor_id: string; actor_label_snapshot: string; source: string;
  }>(
    `select * from bzup.generation_batches where workspace_id = $1 and id = $2`,
    [workspaceId, batchId],
  );
  if (!b[0]) throw new AppError('NOT_FOUND');
  const items = await q.query<{
    template_item_id: string; link_id: string; name_snapshot: string; short_url_snapshot: string; destination_url_snapshot: string;
  }>(
    `select template_item_id, link_id, name_snapshot, short_url_snapshot, destination_url_snapshot
       from bzup.generation_batch_items where batch_id = $1 order by sort_order`,
    [batchId],
  );
  const x = b[0];
  return {
    id: x.id,
    course_id: x.course_id,
    template_id: x.template_id,
    template_version: Number(x.template_version),
    status: x.status,
    total_count: Number(x.count),
    source: x.source,
    actor: { type: x.actor_type, id: x.actor_id, label: x.actor_label_snapshot },
    url_config_version: Number(x.url_config_version_snapshot),
    created_at: toIso(x.created_at),
    results: items.map((i) => ({
      template_item_id: i.template_item_id,
      link_id: i.link_id,
      name: i.name_snapshot,
      short_url: i.short_url_snapshot,
      destination_url: i.destination_url_snapshot,
    })),
  };
}

// ---------------------------------------------------------------------------
// 중복 프리플라이트 (§14.2)
// ---------------------------------------------------------------------------
export async function preflight(db: Db, principal: Principal, body: unknown) {
  requirePermission(principal, 'links:create');
  if (!isObject(body)) throw new AppError('INVALID_JSON');
  const mode = body.mode;
  if (mode !== 'single' && mode !== 'batch') throw validationError('mode는 single 또는 batch여야 합니다.');
  const { mode: _m, ...rest } = body;
  void _m;
  await consume(db, limits.preflight(principal));
  const outcome = await db.tx(async (q) => {
    let rows: PlannedRow[];
    let requestedCourseId: string | null;
    let templateId: string | null = null;
    let templateVersion: number | null = null;
    if (mode === 'single') {
      const input = parseSingleCreateBody(rest);
      if (input.reviewToken) throw validationError('프리플라이트에는 review_token을 보내지 않습니다.');
      requestedCourseId = input.courseId;
      rows = [plannedFrom('single', 1, input.name, input.destination, input.externalRef, null, 1)];
    } else {
      const input = parseBatchCreateBody(rest);
      if (input.reviewToken) throw validationError('프리플라이트에는 review_token을 보내지 않습니다.');
      requestedCourseId = input.courseId;
      templateId = input.templateId;
      templateVersion = input.templateVersion;
      // 배치 행 구성 검증은 생성과 같은 규칙
      rows = await buildBatchRows(q, principal.workspaceId, input);
    }
    const courseId = resolveCourseId(principal, requestedCourseId);
    await requireActiveCourse(q, principal.workspaceId, courseId);
    const policy = await loadUrlPolicy(q);
    for (const r of rows) assertRowDestinations(r, policy.serviceHosts);
    await checkExternalRefs(q, principal.workspaceId, rows);
    const a = await analyzeDuplicates(q, principal.workspaceId, rows);
    const binding: ReviewBinding = {
      mode, courseId, templateId, templateVersion,
      inputHash: normalizedInputHash({ mode, courseId, templateId, templateVersion, rows }),
    };
    return { courseId, rows, a, policy, binding };
  }, { readOnly: true });
  const { courseId, rows, a, policy, binding } = outcome;
  if (!needsConfirmation(a)) {
    return { review_token: null, expires_at: null, requires_confirmation: false, resolved_course_id: courseId, duplicate_groups: [] };
  }
  // 토큰 발급은 코드 예약·링크 생성을 하지 않는 별도 짧은 처리
  return { ...(await issueReview(db, principal, binding, rows, a, policy)), resolved_course_id: courseId };
}

// ---------------------------------------------------------------------------
// 조회
// ---------------------------------------------------------------------------
export async function getLink(q: Queryable, principal: Principal, id: string) {
  requirePermission(principal, 'links:read');
  const rows = await q.query<LinkRow>(
    `select ${LINK_COLUMNS} from bzup.links l where l.workspace_id = $1 and l.id = $2`,
    [principal.workspaceId, id],
  );
  if (!rows[0]) throw new AppError('NOT_FOUND');
  const policy = await loadUrlPolicy(q);
  const slots = await loadSlots(q, id);
  return { link: rows[0], slots, policy, etag: linkEtag(rows[0].id, Number(rows[0].version), policy.urlConfigVersion) };
}

export async function getLinkRevisions(q: Queryable, principal: Principal, id: string) {
  requirePermission(principal, 'links:read');
  const exists = await q.query(`select 1 from bzup.links where workspace_id = $1 and id = $2`, [principal.workspaceId, id]);
  if (!exists.length) throw new AppError('NOT_FOUND');
  const rows = await q.query<{
    version: number; action: string; changed_fields: string[]; before_snapshot: unknown; after_snapshot: unknown;
    actor_type: string; actor_id: string | null; actor_label_snapshot: string | null; api_key_id: string | null;
    generation_batch_id: string | null; request_id: string | null; reason: string | null; created_at: Date;
  }>(
    `select version, action, changed_fields, before_snapshot, after_snapshot, actor_type, actor_id, actor_label_snapshot,
            api_key_id, generation_batch_id, request_id, reason, created_at
       from bzup.link_revisions where workspace_id = $1 and link_id = $2 order by version desc`,
    [principal.workspaceId, id],
  );
  return rows.map((r) => ({
    version: Number(r.version),
    action: r.action,
    changed_fields: r.changed_fields,
    before: r.before_snapshot,
    after: r.after_snapshot,
    actor: { type: r.actor_type, id: r.actor_id, label: r.actor_label_snapshot, api_key_id: r.api_key_id },
    generation_batch_id: r.generation_batch_id,
    request_id: r.request_id,
    reason: r.reason,
    created_at: toIso(r.created_at),
  }));
}

// ---------------------------------------------------------------------------
// 수정 (§11, §14.6, §16.4)
// ---------------------------------------------------------------------------
const PATCHABLE = ['name', 'destination_url', 'course_id', 'status', 'active_slot', 'slot_urls'] as const;
const IMMUTABLE = ['id', 'short_code', 'issued_domain', 'issued_short_url', 'domain', 'short_url', 'initial_destination_url',
  'source', 'creation_mode', 'generation_batch_id', 'external_ref', 'version', 'created_at', 'updated_at', 'url_config_version'];

export interface PatchInput {
  name?: string;
  destination?: ParsedDestination;
  courseId?: string;
  status?: 'active' | 'inactive';
  /** 전환 주소 링크: 연결할 위치 */
  activeSlot?: number;
  /** 전환 주소 링크: 위치별 URL (null = 비움) */
  slotUrls?: (ParsedDestination | null)[];
  reason: string | null;
  raw: Record<string, unknown>;
}

export function parsePatchBody(body: unknown): PatchInput {
  if (!isObject(body)) throw new AppError('INVALID_JSON');
  const imm = Object.keys(body).filter((k) => IMMUTABLE.includes(k));
  if (imm.length) throw validationError(`변경할 수 없는 필드입니다: ${imm.join(', ')}`);
  assertAllowedFields(body, [...PATCHABLE, 'change_reason']);
  for (const k of PATCHABLE) {
    if (k in body && body[k] === null) throw validationError(`${k} 값을 지울 수 없습니다.`);
  }
  if (!PATCHABLE.some((k) => k in body)) throw validationError('name, destination_url, course_id, status, active_slot, slot_urls 중 하나 이상이 필요합니다.');
  const out: PatchInput = { reason: optionalText(body.change_reason, 'change_reason', '변경 사유', 500), raw: body };
  if ('name' in body) out.name = cleanText(body.name, 'name', '명칭', 1, 120);
  if ('destination_url' in body) out.destination = parseDestination(body.destination_url);
  if ('course_id' in body) out.courseId = uuidField(body.course_id, 'course_id');
  if ('status' in body) {
    if (body.status !== 'active' && body.status !== 'inactive') throw validationError('status는 active 또는 inactive여야 합니다.');
    out.status = body.status;
  }
  if ('active_slot' in body) {
    if (!Number.isInteger(body.active_slot) || (body.active_slot as number) < 0 || (body.active_slot as number) > 4) {
      throw validationError('active_slot은 0~4 사이의 정수입니다.');
    }
    out.activeSlot = body.active_slot as number;
  }
  if ('slot_urls' in body) {
    if (!Array.isArray(body.slot_urls) || body.slot_urls.length < 2 || body.slot_urls.length > 5) {
      throw validationError('slot_urls는 전환 주소 개수만큼의 배열이어야 합니다.');
    }
    const errors: RowError[] = [];
    out.slotUrls = body.slot_urls.map((u, i) => {
      if (u === null || (typeof u === 'string' && u.trim() === '')) return null;
      try { return parseDestination(u); } catch (e) { collect(e, errors, `slot_urls[${i}]`); return null; }
    });
    if (errors.length) throw validationError('전환 주소를 확인해 주세요.', errors);
  }
  if (out.destination && (out.activeSlot !== undefined || out.slotUrls)) {
    throw validationError('destination_url과 active_slot·slot_urls는 함께 보낼 수 없습니다.');
  }
  return out;
}

export async function patchLink(
  db: Db, principal: Principal, id: string, input: PatchInput, ifMatch: string, ctx: WriteContext,
): Promise<StoredResponse & { replayed: boolean }> {
  requirePermission(principal, 'links:update');
  const requestHash = hashRequest({ body: input.raw, if_match: ifMatch });
  const idem = idemContext(principal, 'PATCH', `/links/${id}`, ctx.idempotencyKey, requestHash);
  const quick = await findSuccess(db, idem);
  if (quick) return { ...quick, replayed: true };
  await consume(db, limits.write(principal));

  return db.tx(async (q) => {
    await lockRequestScope(q, idemScope(idem));
    const replay = await findSuccess(q, idem);
    if (replay) return { ...replay, replayed: true };

    await lockWorkspace(q, principal.workspaceId);
    const p = await recheckPrincipal(q, principal, 'links:update');
    const rows = await q.query<LinkRow>(
      `select ${LINK_COLUMNS} from bzup.links l where l.workspace_id = $1 and l.id = $2 for update`,
      [p.workspaceId, id],
    );
    const cur = rows[0];
    if (!cur) throw new AppError('NOT_FOUND');
    const policy = await loadUrlPolicy(q);
    const currentEtag = linkEtag(cur.id, Number(cur.version), policy.urlConfigVersion);
    if (ifMatch !== currentEtag) {
      const policyChanged = ifMatch.startsWith(`"link-${cur.id}-v${cur.version}-u`);
      throw new AppError('PRECONDITION_FAILED', policyChanged
        ? '서비스 주소 설정이 변경되었습니다. 최신 정보를 불러와 다시 저장해 주세요.'
        : undefined, { headers: { ETag: currentEtag } });
    }

    const changed: string[] = [];
    let next = {
      name: cur.name, destination_url: cur.destination_url, course_id: cur.course_id, status: cur.status,
      active_slot: cur.active_slot === null ? null : Number(cur.active_slot),
    };
    let canonical: string | null = null;
    let fingerprint: Buffer | null = null;
    const setDestination = (d: ParsedDestination) => {
      assertAllowedDestination(d, policy.serviceHosts);
      next = { ...next, destination_url: d.stored };
      canonical = d.canonical;
      fingerprint = d.fingerprint;
      changed.push('destination_url');
    };
    if (input.name !== undefined && input.name !== cur.name) { next = { ...next, name: input.name }; changed.push('name'); }

    // 전환 주소
    const curSlots = await loadSlots(q, id);
    let nextSlots = curSlots;
    if (!curSlots && (input.activeSlot !== undefined || input.slotUrls)) {
      throw validationError('전환 주소가 없는 링크입니다. destination_url로 목적지를 변경해 주세요.');
    }
    if (curSlots && input.destination) {
      throw validationError('전환 주소 링크는 active_slot(전환) 또는 slot_urls(주소 수정)로 변경해 주세요.');
    }
    if (curSlots) {
      if (input.slotUrls) {
        if (input.slotUrls.length !== curSlots.length) throw validationError(`slot_urls는 ${curSlots.length}개여야 합니다.`);
        for (const u of input.slotUrls) if (u) assertAllowedDestination(u, policy.serviceHosts);
        nextSlots = curSlots.map((sl, i) => ({ ...sl, destination_url: input.slotUrls![i]?.stored ?? null }));
        if (nextSlots.some((sl, i) => sl.destination_url !== curSlots[i].destination_url)) changed.push('slot_urls');
      }
      const target = input.activeSlot ?? next.active_slot ?? 0;
      if (target >= curSlots.length) throw validationError('없는 전환 주소 위치입니다.');
      const targetUrl = nextSlots![target].destination_url;
      if (!targetUrl) {
        throw validationError(`'${curSlots[target].label}' 주소가 비어 있어 연결할 수 없습니다. 주소를 먼저 입력해 주세요.`);
      }
      if (target !== next.active_slot) { next = { ...next, active_slot: target }; changed.push('active_slot'); }
      if (targetUrl !== cur.destination_url) {
        const idx = input.slotUrls ? target : -1;
        setDestination(idx >= 0 && input.slotUrls![idx] ? input.slotUrls![idx]! : parseDestination(targetUrl));
      }
    } else if (input.destination && input.destination.stored !== cur.destination_url) {
      setDestination(input.destination);
    }
    let newCourseName: string | null = null;
    if (input.courseId !== undefined && input.courseId !== cur.course_id) {
      const c = await requireActiveCourse(q, p.workspaceId, input.courseId);
      newCourseName = c.name;
      next = { ...next, course_id: input.courseId };
      changed.push('course_id');
    }
    if (input.status !== undefined && input.status !== cur.status) { next = { ...next, status: input.status }; changed.push('status'); }

    let result: LinkRow = cur;
    if (changed.length) {
      const actor = principalRef(p);
      const upd = await q.query<LinkRow>(
        `update bzup.links l set name = $3, destination_url = $4,
                canonical_destination = coalesce($5, canonical_destination),
                destination_fingerprint = coalesce($6, destination_fingerprint),
                course_id = $7, status = $8, version = version + 1, updated_at = clock_timestamp(),
                updated_by_type = $9, updated_by_id = $10, updated_by_label = $11, active_slot = $12
          where workspace_id = $1 and id = $2
          returning ${LINK_COLUMNS}`,
        [p.workspaceId, id, next.name, next.destination_url, canonical, fingerprint, next.course_id, next.status,
          actor.type, actor.id, actor.label, next.active_slot],
      );
      result = upd[0];
      if (changed.includes('slot_urls') && nextSlots) {
        for (const sl of nextSlots) {
          await q.query(
            `update bzup.link_destination_slots set destination_url = $3, updated_at = clock_timestamp()
              where link_id = $1 and position = $2 and destination_url is distinct from $3`,
            [id, sl.position, sl.destination_url],
          );
        }
      }
      const oldCourseName = cur.course_id ? (await loadCourse(q, p.workspaceId, cur.course_id))?.name ?? null : null;
      const snap = (v: typeof next, courseName: string | null, slots: LinkSlot[] | null) => ({
        name: v.name, destination_url: v.destination_url, course_id: v.course_id, course_name_snapshot: courseName, status: v.status,
        ...(slots ? {
          active_slot: v.active_slot,
          active_slot_label: v.active_slot === null ? null : slots[v.active_slot]?.label ?? null,
          destination_slots: slots.map((sl) => ({ label: sl.label, destination_url: sl.destination_url })),
        } : {}),
      });
      await q.query(
        `insert into bzup.link_revisions
           (workspace_id, link_id, version, action, changed_fields, before_snapshot, after_snapshot,
            actor_type, actor_id, actor_label_snapshot, api_key_id, request_id, reason, created_at)
         values ($1,$2,$3,'updated',$4,$5::text::jsonb,$6::text::jsonb,$7,$8,$9,$10,$11,$12,$13)`,
        [p.workspaceId, id, result.version, changed,
          JSON.stringify(snap({
            name: cur.name, destination_url: cur.destination_url, course_id: cur.course_id, status: cur.status,
            active_slot: cur.active_slot === null ? null : Number(cur.active_slot),
          }, oldCourseName, curSlots)),
          JSON.stringify(snap(next, newCourseName ?? oldCourseName, nextSlots)),
          actor.type, actor.id, actor.label, actor.apiKeyId, ctx.requestId, input.reason, result.updated_at],
      );
    }
    const resp: StoredResponse = {
      status: 200,
      body: { data: serializeLink(result, policy, await loadSlots(q, id)), changed_fields: changed },
      headers: { ETag: linkEtag(result.id, Number(result.version), policy.urlConfigVersion) },
    };
    await saveSuccess(q, idem, resp, { resultLinkId: id });
    return { ...resp, replayed: false };
  });
}
