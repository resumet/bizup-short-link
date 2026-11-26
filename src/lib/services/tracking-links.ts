// 트래킹 링크: 엑셀(추천코드·진행매체·URL) → 강의별 짧은 주소 일괄 발급
// - 이름: {강의명}_{추천코드}_{진행매체}
// - 같은 강의에 이미 있는 URL(정규화 기준, 삭제되지 않은 링크)은 무시하고 새 URL 만 만든다
// - 엑셀 파일은 저장하지 않고, 변환 결과(tracking_uploads·tracking_links)만 보관한다
import { randomUUID } from 'node:crypto';
import { AppError } from '@/lib/errors';
import type { Db, Queryable } from '@/lib/db/types';
import { lockWorkspace } from '@/lib/db/locks';
import { principalRef, recheckPrincipal, requirePermission, sourceOf, type UserPrincipal } from '@/lib/auth/principal';
import { assertAllowedDestination, parseDestination, type ParsedDestination } from '@/lib/url/destination';
import { toIso } from '@/lib/time';
import { UUID_RE } from '@/lib/validation';
import { loadUrlPolicy, shortUrlFor } from './settings';
import { reserveCodes } from './links';
import { consume, limits } from './ratelimit';
import type { TrackingSheetRow } from '@/lib/tracking/excel';

const NAME_MAX = 120;
const FIELD_MAX = 100;

export type TrackingRowStatus = 'created' | 'exists' | 'duplicate_in_file' | 'error';

export interface TrackingRowResult {
  row: number;
  referral_code: string;
  media: string;
  destination_url: string;
  status: TrackingRowStatus;
  name: string | null;
  short_url: string | null;
  link_id: string | null;
  message: string | null;
}

export interface TrackingUploadResult {
  upload_id: string;
  course_id: string;
  course_name: string;
  file_name: string;
  total_rows: number;
  created_count: number;
  skipped_count: number;
  error_count: number;
  rows: TrackingRowResult[];
}

/** 이름: 강의명_추천코드_진행매체 (120자 초과 시 강의명을 줄인다) */
export function trackingLinkName(courseName: string, referralCode: string, media: string): string {
  const tail = `_${referralCode}_${media}`;
  const room = NAME_MAX - [...tail].length;
  const chars = [...courseName.trim()];
  const course = chars.length <= room ? chars.join('') : `${chars.slice(0, Math.max(room - 1, 0)).join('')}…`;
  return [...`${course}${tail}`].slice(0, NAME_MAX).join('');
}

function parseCourseId(v: unknown): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new AppError('COURSE_REQUIRED');
  return v.toLowerCase();
}

async function activeCourse(q: Queryable, workspaceId: string, courseId: string) {
  const [c] = await q.query<{ id: string; name: string; status: string }>(
    `select id, name, status from bzup.courses where workspace_id = $1 and id = $2`, [workspaceId, courseId],
  );
  if (!c) throw new AppError('COURSE_REQUIRED', '선택한 강의를 찾을 수 없습니다.');
  if (c.status !== 'active') throw new AppError('COURSE_NOT_ACTIVE');
  return c;
}

/** 강의에 이미 있는(삭제되지 않은) 링크: 정규화 URL → 링크 */
async function existingByCanonical(q: Queryable, workspaceId: string, courseId: string, canonicals: string[]) {
  if (!canonicals.length) return new Map<string, { id: string; name: string; short_code: string }>();
  const rows = await q.query<{ id: string; name: string; short_code: string; canonical_destination: string }>(
    `select distinct on (canonical_destination) id, name, short_code, canonical_destination
       from bzup.links
      where workspace_id = $1 and course_id = $2 and deleted_at is null and canonical_destination = any($3::text[])
      order by canonical_destination, created_at`,
    [workspaceId, courseId, canonicals],
  );
  return new Map(rows.map((r) => [r.canonical_destination, r]));
}

interface Candidate {
  result: TrackingRowResult;
  dest: ParsedDestination;
  linkId: string;
  shortCode?: string;
}

/** 엑셀 행 → 트래킹 링크 발급 */
export async function createTrackingLinks(
  db: Db, principal: UserPrincipal, input: { courseId: unknown; fileName: string; rows: TrackingSheetRow[] }, requestId: string,
): Promise<TrackingUploadResult> {
  requirePermission(principal, 'links:create');
  const courseId = parseCourseId(input.courseId);
  const fileName = (input.fileName || 'upload.xlsx').slice(0, 255);
  const course0 = await activeCourse(db, principal.workspaceId, courseId);
  const policy0 = await loadUrlPolicy(db);

  // 1) 행 검증·파일 안 중복
  const results: TrackingRowResult[] = [];
  const candidates: Candidate[] = [];
  const seen = new Map<string, number>();
  for (const r of input.rows) {
    const res: TrackingRowResult = {
      row: r.row, referral_code: r.referralCode, media: r.media, destination_url: r.url,
      status: 'error', name: null, short_url: null, link_id: null, message: null,
    };
    results.push(res);
    const missing = [!r.referralCode && '추천코드', !r.media && '진행매체', !r.url && 'URL'].filter(Boolean);
    if (missing.length) { res.message = `${missing.join('·')} 값이 비어 있습니다.`; continue; }
    if ([...r.referralCode].length > FIELD_MAX || [...r.media].length > FIELD_MAX) {
      res.message = `추천코드·진행매체는 ${FIELD_MAX}자 이하여야 합니다.`; continue;
    }
    let dest: ParsedDestination;
    try {
      dest = parseDestination(r.url);
      assertAllowedDestination(dest, policy0.serviceHosts);
    } catch (e) {
      if (e instanceof AppError) { res.message = e.message; continue; }
      throw e;
    }
    res.destination_url = dest.stored;
    const firstRow = seen.get(dest.canonical);
    if (firstRow !== undefined) {
      res.status = 'duplicate_in_file';
      res.message = `${firstRow}행과 같은 URL 입니다.`;
      continue;
    }
    seen.set(dest.canonical, r.row);
    res.name = trackingLinkName(course0.name, r.referralCode, r.media);
    candidates.push({ result: res, dest, linkId: randomUUID() });
  }

  // 2) 강의에 이미 있는 URL 은 무시 (사전 확인 — 잠금 안에서 다시 확인)
  const markExisting = (m: Map<string, { id: string; name: string; short_code: string }>, host: string) => {
    for (const c of candidates) {
      const hit = m.get(c.dest.canonical);
      if (!hit) continue;
      Object.assign(c.result, {
        status: 'exists', name: hit.name, link_id: hit.id, short_url: shortUrlFor(host, hit.short_code),
        message: '이미 이 강의에 있는 URL 이라 건너뛰었습니다.',
      });
    }
  };
  markExisting(await existingByCanonical(db, principal.workspaceId, courseId, candidates.map((c) => c.dest.canonical)), policy0.primaryHost);
  let fresh = candidates.filter((c) => c.result.status === 'error');

  // 3) 호출 한도 (업로드 1회 = 쓰기 1회 + 새 링크 N건)
  await consume(db, [...limits.write(principal), ...(fresh.length ? limits.newLinks(principal, fresh.length) : [])]);

  // 4) 코드 예약 — 회사 잠금 밖
  if (fresh.length) await reserveCodes(db, policy0, principal.workspaceId, fresh);

  const uploadId = await db.tx(async (q) => {
    await lockWorkspace(q, principal.workspaceId);
    const p = await recheckPrincipal(q, principal, 'links:create');
    const course = await activeCourse(q, p.workspaceId, courseId);
    const policy = await loadUrlPolicy(q);
    // 잠금 안에서 최신 상태로 다시 확인 (다른 업로드가 먼저 만든 URL 은 무시로 바뀐다)
    markExisting(await existingByCanonical(q, p.workspaceId, courseId, fresh.map((c) => c.dest.canonical)), policy.primaryHost);
    fresh = fresh.filter((c) => c.result.status === 'error');

    const actor = principalRef(p);
    const counts = {
      created: fresh.length,
      skipped: results.filter((r) => r.status === 'exists' || r.status === 'duplicate_in_file').length,
    };
    const errors = results.length - counts.created - counts.skipped;
    const [up] = await q.query<{ id: string }>(
      `insert into bzup.tracking_uploads
         (workspace_id, course_id, file_name, total_rows, created_count, skipped_count, error_count, actor_id, actor_label, request_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [p.workspaceId, course.id, fileName, results.length, counts.created, counts.skipped, errors, actor.id, actor.label, requestId],
    );
    if (!fresh.length) return up.id;

    const col = <T>(f: (c: Candidate) => T) => fresh.map(f);
    // 여러 행을 한 번에 넣는다 (행마다 왕복하지 않음)
    await q.query(
      `insert into bzup.links
         (id, workspace_id, issued_domain, short_code, name, initial_destination_url, destination_url,
          canonical_destination, destination_fingerprint, course_id, status, version, source, creation_mode,
          created_by_type, created_by_id, created_by_label, updated_by_type, updated_by_id, updated_by_label,
          created_at, updated_at)
       select t.id, $1, $2, t.code, t.name, t.url, t.url, t.canonical, decode(t.fp, 'hex'), $3, 'active', 1, $4, 'single',
              $5, $6, $7, $5, $6, $7, clock_timestamp(), clock_timestamp()
         from unnest($8::uuid[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[])
              as t(id, code, name, url, canonical, fp)`,
      [p.workspaceId, policy.primaryHost, course.id, sourceOf(p), actor.type, actor.id, actor.label,
        col((c) => c.linkId), col((c) => c.shortCode!), col((c) => c.result.name!), col((c) => c.dest.stored),
        col((c) => c.dest.canonical), col((c) => c.dest.fingerprint.toString('hex'))],
    );
    await q.query(
      `insert into bzup.link_revisions
         (workspace_id, link_id, version, action, changed_fields, after_snapshot, actor_type, actor_id,
          actor_label_snapshot, request_id, created_at)
       select $1, l.id, 1, 'created', array['name','destination_url','course_id','status'],
              jsonb_build_object('name', l.name, 'destination_url', l.destination_url, 'course_id', l.course_id,
                                 'course_name_snapshot', $2::text, 'status', 'active'),
              $3, $4, $5, $6, l.created_at
         from bzup.links l where l.id = any($7::uuid[])`,
      [p.workspaceId, course.name, actor.type, actor.id, actor.label, requestId, col((c) => c.linkId)],
    );
    await q.query(
      `insert into bzup.tracking_links
         (workspace_id, course_id, upload_id, link_id, row_number, referral_code, media, destination_url, canonical_destination)
       select $1, $2, $3, t.link_id, t.row_number, t.referral_code, t.media, t.url, t.canonical
         from unnest($4::uuid[], $5::int[], $6::text[], $7::text[], $8::text[], $9::text[])
              as t(link_id, row_number, referral_code, media, url, canonical)`,
      [p.workspaceId, course.id, up.id, col((c) => c.linkId), col((c) => c.result.row), col((c) => c.result.referral_code),
        col((c) => c.result.media), col((c) => c.dest.stored), col((c) => c.dest.canonical)],
    );
    for (const c of fresh) {
      Object.assign(c.result, {
        status: 'created', link_id: c.linkId, short_url: shortUrlFor(policy.primaryHost, c.shortCode!), message: null,
      });
    }
    return up.id;
  });

  return {
    upload_id: uploadId,
    course_id: courseId,
    course_name: course0.name,
    file_name: fileName,
    total_rows: results.length,
    created_count: results.filter((r) => r.status === 'created').length,
    skipped_count: results.filter((r) => r.status === 'exists' || r.status === 'duplicate_in_file').length,
    error_count: results.filter((r) => r.status === 'error').length,
    rows: results,
  };
}

export interface StoredTrackingLink {
  id: string;
  link_id: string;
  name: string;
  referral_code: string;
  media: string;
  destination_url: string;
  short_url: string;
  status: 'active' | 'inactive' | 'deleted';
  created_at: string | null;
  file_name: string;
}

/** 강의의 보관된 트래킹 링크 (최근 업로드 먼저, 엑셀 행 순서) */
export async function listTrackingLinks(q: Queryable, principal: UserPrincipal, courseIdRaw: unknown) {
  requirePermission(principal, 'links:read');
  const courseId = parseCourseId(courseIdRaw);
  const policy = await loadUrlPolicy(q);
  const rows = await q.query<{
    id: string; link_id: string; name: string; referral_code: string; media: string; destination_url: string;
    short_code: string; status: 'active' | 'inactive'; deleted_at: Date | null; created_at: Date; file_name: string;
  }>(
    `select t.id, t.link_id, l.name, t.referral_code, t.media, t.destination_url, l.short_code, l.status, l.deleted_at,
            t.created_at, u.file_name
       from bzup.tracking_links t
       join bzup.links l on l.id = t.link_id
       join bzup.tracking_uploads u on u.id = t.upload_id
      where t.workspace_id = $1 and t.course_id = $2
      order by t.created_at desc, t.row_number
      limit 2000`,
    [principal.workspaceId, courseId],
  );
  return rows.map((r): StoredTrackingLink => ({
    id: r.id, link_id: r.link_id, name: r.name, referral_code: r.referral_code, media: r.media,
    destination_url: r.destination_url, short_url: shortUrlFor(policy.primaryHost, r.short_code),
    status: r.deleted_at ? 'deleted' : r.status, created_at: toIso(r.created_at), file_name: r.file_name,
  }));
}
