// 같은 목적지 재생성 확인 (PRD §6, §14.2~14.3, §15.7)
import { AppError } from '@/lib/errors';
import { hashRequest, randomToken, sha256, stableStringify, constantTimeEqual } from '@/lib/crypto';
import { toIso } from '@/lib/time';
import type { Db, Queryable } from '@/lib/db/types';
import type { Principal } from '@/lib/auth/principal';
import { hasPermission } from '@/lib/auth/principal';
import { shortUrlFor, type UrlPolicy } from './settings';

export interface DupInputRow {
  /** 'single' 또는 template_item_id */
  rowId: string;
  rowNumber: number;
  name: string;
  stored: string;
  canonical: string;
  fingerprint: Buffer;
  externalRef: string | null;
  /** 전환 주소 URL (검토 토큰이 전체 입력에 묶이도록 해시에 포함) */
  slotUrls?: (string | null)[] | null;
}

export interface ExistingDup {
  id: string;
  version: number;
  name: string;
  course_id: string | null;
  course_name: string | null;
  short_code: string;
  status: string;
  created_at: Date;
  canonical_destination: string;
}

export interface DuplicateAnalysis {
  existingByCanonical: Map<string, ExistingDup[]>;
  internalGroups: { canonical: string; rowIds: string[] }[];
  digest: Buffer;
  hasExisting: boolean;
  hasInternal: boolean;
}

export function normalizedInputHash(input: {
  mode: 'single' | 'batch';
  courseId: string;
  templateId: string | null;
  templateVersion: number | null;
  rows: DupInputRow[];
}): Buffer {
  return hashRequest({
    mode: input.mode,
    course_id: input.courseId,
    template_id: input.templateId,
    template_version: input.templateVersion,
    rows: input.rows.map((r) => ({ id: r.rowId, name: r.name, url: r.stored, ref: r.externalRef, slots: r.slotUrls ?? null })),
  });
}

/** 회사 전체(강의·활성 상태 무관)의 현재 목적지와 입력 행끼리의 중복을 확인한다. */
export async function analyzeDuplicates(q: Queryable, workspaceId: string, rows: DupInputRow[]): Promise<DuplicateAnalysis> {
  const fps = [...new Map(rows.map((r) => [r.fingerprint.toString('hex'), r.fingerprint])).values()];
  const found = fps.length
    ? await q.query<ExistingDup>(
        `select l.id, l.version, l.name, l.course_id, c.name as course_name, l.short_code, l.status,
                l.created_at, l.canonical_destination
           from bzup.links l
           left join bzup.courses c on c.workspace_id = l.workspace_id and c.id = l.course_id
          where l.workspace_id = $1 and l.destination_fingerprint = any($2::bytea[]) and l.deleted_at is null
          order by l.created_at desc, l.id desc`,
        [workspaceId, fps],
      )
    : [];
  const canonicals = new Set(rows.map((r) => r.canonical));
  const existingByCanonical = new Map<string, ExistingDup[]>();
  for (const e of found) {
    // 해시 일치 후 canonical 전체 비교
    if (!canonicals.has(e.canonical_destination)) continue;
    const list = existingByCanonical.get(e.canonical_destination) ?? [];
    list.push(e);
    existingByCanonical.set(e.canonical_destination, list);
  }
  const byCanon = new Map<string, string[]>();
  for (const r of rows) byCanon.set(r.canonical, [...(byCanon.get(r.canonical) ?? []), r.rowId]);
  const internalGroups = [...byCanon.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([canonical, rowIds]) => ({ canonical, rowIds }));

  const digestParts = [...existingByCanonical.entries()]
    .flatMap(([canon, list]) => list.map((e) => `${canon}\u0000${e.id}:${e.version}`))
    .sort();
  const digest = sha256(stableStringify({ existing: digestParts, internal: internalGroups.map((g) => g.rowIds) }));
  return {
    existingByCanonical,
    internalGroups,
    digest,
    hasExisting: existingByCanonical.size > 0,
    hasInternal: internalGroups.length > 0,
  };
}

export function needsConfirmation(a: DuplicateAnalysis): boolean {
  return a.hasExisting || a.hasInternal;
}

const MAX_PREVIEW = 5;

/** 응답용 중복 그룹. read 권한 없는 create 전용 키에는 기존 링크 정보를 노출하지 않는다 (§14.2). */
export function buildDuplicateGroups(
  p: Principal,
  rows: DupInputRow[],
  a: DuplicateAnalysis,
  policy: UrlPolicy,
) {
  const canRead = hasPermission(p, 'links:read');
  const canonicals = [...new Set(rows.map((r) => r.canonical))];
  const groups = [];
  for (const canon of canonicals) {
    const existing = a.existingByCanonical.get(canon) ?? [];
    const inputRows = rows.filter((r) => r.canonical === canon);
    if (existing.length === 0 && inputRows.length < 2) continue;
    groups.push({
      input_row_ids: inputRows.map((r) => r.rowId),
      input_rows: inputRows.map((r) => ({ row_id: r.rowId, row_number: r.rowNumber, name: r.name })),
      existing_count: existing.length,
      ...(canRead
        ? {
            existing_links: existing.slice(0, MAX_PREVIEW).map((e) => ({
              id: e.id,
              name: e.name,
              course_id: e.course_id,
              course_name: e.course_name,
              short_url: shortUrlFor(policy.primaryHost, e.short_code),
              status: e.status,
              created_at: toIso(e.created_at),
            })),
          }
        : {}),
    });
  }
  return groups;
}

export function duplicateKind(a: DuplicateAnalysis): 'existing' | 'internal' | 'both' {
  if (a.hasExisting && a.hasInternal) return 'both';
  return a.hasExisting ? 'existing' : 'internal';
}

export interface ReviewBinding {
  mode: 'single' | 'batch';
  courseId: string;
  templateId: string | null;
  templateVersion: number | null;
  inputHash: Buffer;
}

/** 별도 짧은 처리로 검토 기록·토큰 발급. 코드 예약·링크 생성을 하지 않는다. */
export async function issueReview(
  db: Db,
  p: Principal,
  binding: ReviewBinding,
  rows: DupInputRow[],
  a: DuplicateAnalysis,
  policy: UrlPolicy,
) {
  const token = randomToken('rvw_');
  const groups = buildDuplicateGroups(p, rows, a, policy);
  const r = await db.query<{ expires_at: Date }>(
    `insert into bzup.generation_reviews
       (token_hash, workspace_id, principal_type, principal_id, mode, normalized_input_hash, resolved_course_id,
        template_id, template_version, existing_duplicate_digest, internal_duplicate_groups, preview_snapshot, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text::jsonb,$12::text::jsonb, clock_timestamp() + interval '10 minutes')
     returning expires_at`,
    [
      sha256(token), p.workspaceId, p.kind, p.kind === 'user' ? p.userId : p.apiClientId, binding.mode,
      binding.inputHash, binding.courseId, binding.templateId, binding.templateVersion, a.digest,
      JSON.stringify(a.internalGroups.map((g) => g.rowIds)), JSON.stringify({ duplicate_kind: duplicateKind(a) }),
    ],
  );
  return {
    review_token: token,
    expires_at: toIso(r[0].expires_at),
    requires_confirmation: true,
    duplicate_kind: duplicateKind(a),
    duplicate_groups: groups,
  };
}

export interface ReviewRecord {
  id: string;
  digest: Buffer;
}

/**
 * 최종 요청의 검토 토큰 검증 (소비는 호출자가 같은 트랜잭션에서 수행).
 * 토큰 보유만으로 동의로 보지 않는다: duplicate_decision=create_new 가 필요하다.
 */
export async function verifyReviewToken(
  q: Queryable,
  p: Principal,
  token: string,
  binding: ReviewBinding,
): Promise<ReviewRecord> {
  const rows = await q.query<{
    id: string; workspace_id: string; principal_type: string; principal_id: string; mode: string;
    normalized_input_hash: Uint8Array; resolved_course_id: string; template_id: string | null;
    template_version: number | null; existing_duplicate_digest: Uint8Array; consumed_at: Date | null; expired: boolean;
  }>(
    `select id, workspace_id, principal_type, principal_id, mode, normalized_input_hash, resolved_course_id,
            template_id, template_version, existing_duplicate_digest, consumed_at,
            (expires_at <= clock_timestamp()) as expired
       from bzup.generation_reviews where token_hash = $1
       for update`,
    [sha256(token)],
  );
  const r = rows[0];
  const principalId = p.kind === 'user' ? p.userId : p.apiClientId;
  if (!r || r.workspace_id !== p.workspaceId || r.principal_type !== p.kind || r.principal_id !== principalId) {
    throw new AppError('REVIEW_MISMATCH');
  }
  if (r.consumed_at) throw new AppError('REVIEW_ALREADY_USED');
  if (r.expired) throw new AppError('REVIEW_EXPIRED');
  if (
    r.mode !== binding.mode ||
    r.resolved_course_id !== binding.courseId ||
    (r.template_id ?? null) !== binding.templateId ||
    (r.template_version ?? null) !== binding.templateVersion ||
    !constantTimeEqual(Buffer.from(r.normalized_input_hash), binding.inputHash)
  ) {
    throw new AppError('REVIEW_MISMATCH');
  }
  return { id: r.id, digest: Buffer.from(r.existing_duplicate_digest) };
}

export async function consumeReview(q: Queryable, reviewId: string, operationId: string): Promise<void> {
  const r = await q.query(
    `update bzup.generation_reviews set consumed_at = clock_timestamp(), consumed_by_operation_id = $2
      where id = $1 and consumed_at is null returning id`,
    [reviewId, operationId],
  );
  if (r.length !== 1) throw new AppError('REVIEW_ALREADY_USED');
}
