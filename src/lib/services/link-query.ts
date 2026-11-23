// 링크 목록·검색·필터 (PRD §9, §14.5). Excel 내보내기도 같은 필터 규칙을 사용한다 (§1.3-9).
import { AppError, validationError } from '@/lib/errors';
import { hashRequest, SHORT_CODE_RE } from '@/lib/crypto';
import { requirePermission, type Principal } from '@/lib/auth/principal';
import { UUID_RE } from '@/lib/validation';
import { normalizeHostname } from '@/lib/url/destination';
import type { Queryable } from '@/lib/db/types';
import { LINK_COLUMNS, serializeLink, type LinkRow } from './links';
import { loadUrlPolicy, type UrlPolicy } from './settings';

export interface LinkFilters {
  q?: string;
  short_code?: string;
  external_ref?: string;
  course_id?: string;
  course_unassigned?: boolean;
  status?: 'active' | 'inactive';
  source?: 'web' | 'api';
  creation_mode?: 'single' | 'batch';
  generation_batch_id?: string;
  created_from?: string;
  created_to?: string;
}

const FILTER_KEYS = ['q', 'short_code', 'external_ref', 'course_id', 'course_unassigned', 'status', 'source',
  'creation_mode', 'generation_batch_id', 'created_from', 'created_to'] as const;

function isoDate(v: string, field: string): string {
  const d = new Date(v);
  if (Number.isNaN(d.getTime()) || !/^\d{4}-\d{2}-\d{2}/.test(v)) throw validationError(`${field} 형식이 올바르지 않습니다.`);
  return d.toISOString();
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], field: string): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) throw validationError(`${field} 값이 올바르지 않습니다.`);
  return v as T;
}

/** URLSearchParams 또는 JSON 객체에서 필터를 해석한다. 허용 밖 키는 거절. */
export function parseFilters(src: Record<string, unknown>, extraAllowed: string[] = []): LinkFilters {
  const extra = Object.keys(src).filter((k) => !(FILTER_KEYS as readonly string[]).includes(k) && !extraAllowed.includes(k));
  if (extra.length) throw validationError(`지원하지 않는 필터입니다: ${extra.join(', ')}`);
  const f: LinkFilters = {};
  const s = (k: string) => (src[k] === undefined || src[k] === '' ? undefined : String(src[k]));
  const q = s('q');
  if (q !== undefined) {
    if ([...q].length > 200) throw validationError('검색어는 200자 이내로 입력해 주세요. 긴 주소는 일부만 입력해 검색해 주세요.');
    f.q = q.trim();
  }
  if (s('short_code') !== undefined) f.short_code = s('short_code');
  if (s('external_ref') !== undefined) f.external_ref = s('external_ref');
  if (s('course_id') !== undefined) {
    if (!UUID_RE.test(s('course_id')!)) throw validationError('course_id 형식이 올바르지 않습니다.');
    f.course_id = s('course_id')!.toLowerCase();
  }
  const cu = src.course_unassigned;
  if (cu !== undefined && cu !== '') {
    if (cu !== true && cu !== 'true' && cu !== false && cu !== 'false') throw validationError('course_unassigned 값이 올바르지 않습니다.');
    f.course_unassigned = cu === true || cu === 'true';
  }
  if (f.course_id && f.course_unassigned) throw validationError('course_id와 course_unassigned=true는 함께 사용할 수 없습니다.');
  if (s('status')) f.status = oneOf(s('status'), ['active', 'inactive'] as const, 'status');
  if (s('source')) f.source = oneOf(s('source'), ['web', 'api'] as const, 'source');
  if (s('creation_mode')) f.creation_mode = oneOf(s('creation_mode'), ['single', 'batch'] as const, 'creation_mode');
  if (s('generation_batch_id')) {
    if (!UUID_RE.test(s('generation_batch_id')!)) throw validationError('generation_batch_id 형식이 올바르지 않습니다.');
    f.generation_batch_id = s('generation_batch_id')!.toLowerCase();
  }
  if (s('created_from')) f.created_from = isoDate(s('created_from')!, 'created_from');
  if (s('created_to')) f.created_to = isoDate(s('created_to')!, 'created_to');
  return f;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** 전체 짧은 주소(현재·이전 등록 호스트)를 입력하면 코드로 해석한다. */
function codeFromShortUrl(q: string, policy: UrlPolicy): string | null {
  const m = /^(?:https?:\/\/)?([^/?#]+)\/([0-9A-Za-z]{7})\/?$/.exec(q);
  if (!m) return null;
  const host = normalizeHostname(m[1].toLowerCase().replace(/:\d+$/, '')) ?? '';
  const hostWithPort = m[1].toLowerCase();
  return policy.serviceHosts.includes(host) || policy.serviceHosts.includes(hostWithPort) ? m[2] : null;
}

export function buildWhere(workspaceId: string, f: LinkFilters, policy: UrlPolicy, params: unknown[]): string {
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const w = [`l.workspace_id = ${p(workspaceId)}`];
  if (f.q) {
    const like = `%${escapeLike(f.q)}%`;
    const ors = [
      `l.name ilike ${p(like)} escape '\\'`,
      `l.initial_destination_url ilike ${p(like)} escape '\\'`,
      `l.destination_url ilike ${p(like)} escape '\\'`,
    ];
    const code = SHORT_CODE_RE.test(f.q) ? f.q : codeFromShortUrl(f.q, policy);
    if (code) ors.push(`l.short_code = ${p(code)}`); // 대소문자 구분
    w.push(`(${ors.join(' or ')})`);
  }
  if (f.short_code) w.push(`l.short_code = ${p(f.short_code)}`);
  if (f.external_ref) w.push(`l.external_ref = ${p(f.external_ref)}`);
  if (f.course_id) w.push(`l.course_id = ${p(f.course_id)}`);
  if (f.course_unassigned) w.push(`l.course_id is null`);
  if (f.status) w.push(`l.status = ${p(f.status)}`);
  if (f.source) w.push(`l.source = ${p(f.source)}`);
  if (f.creation_mode) w.push(`l.creation_mode = ${p(f.creation_mode)}`);
  if (f.generation_batch_id) w.push(`l.generation_batch_id = ${p(f.generation_batch_id)}`);
  if (f.created_from) w.push(`l.created_at >= ${p(f.created_from)}::timestamptz`);
  if (f.created_to) w.push(`l.created_at < ${p(f.created_to)}::timestamptz`);
  return w.join(' and ');
}

interface Cursor { t: string; i: string; f: string }

function filterFingerprint(f: LinkFilters): string {
  return hashRequest(f).toString('base64url').slice(0, 16);
}

export async function listLinks(q: Queryable, principal: Principal, query: Record<string, unknown>) {
  requirePermission(principal, 'links:read');
  const { limit: rawLimit, cursor: rawCursor, ...rest } = query;
  const f = parseFilters(rest);
  let limit = 20;
  if (rawLimit !== undefined && rawLimit !== '') {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw validationError('limit은 1~100 사이여야 합니다.');
  }
  let cursor: Cursor | null = null;
  if (rawCursor !== undefined && rawCursor !== '') {
    try {
      cursor = JSON.parse(Buffer.from(String(rawCursor), 'base64url').toString('utf8')) as Cursor;
    } catch {
      throw new AppError('INVALID_CURSOR');
    }
    if (!cursor || typeof cursor.t !== 'string' || typeof cursor.i !== 'string' || !UUID_RE.test(cursor.i)) {
      throw new AppError('INVALID_CURSOR');
    }
    if (cursor.f !== filterFingerprint(f)) throw new AppError('INVALID_CURSOR', '필터가 바뀌면 처음 페이지부터 다시 조회해 주세요.');
  }
  const policy = await loadUrlPolicy(q);
  const params: unknown[] = [];
  let where = buildWhere(principal.workspaceId, f, policy, params);
  if (cursor) {
    params.push(cursor.t, cursor.i);
    where += ` and (l.created_at, l.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(limit + 1);
  const rows = await q.query<LinkRow & { course_name: string | null; course_status: string | null; created_at_text: string; total_views: number; active_slot_label: string | null }>(
    `select ${LINK_COLUMNS}, c.name as course_name, c.status as course_status, l.created_at::text as created_at_text,
            coalesce(vt.total_views, 0)::bigint as total_views,
            (select ds.label from bzup.link_destination_slots ds where ds.link_id = l.id and ds.position = l.active_slot) as active_slot_label
       from bzup.links l
       left join bzup.courses c on c.workspace_id = l.workspace_id and c.id = l.course_id
       left join bzup.link_view_totals vt on vt.link_id = l.id
      where ${where}
      order by l.created_at desc, l.id desc
      limit $${params.length}`,
    params,
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = hasMore && last
    ? Buffer.from(JSON.stringify({ t: last.created_at_text, i: last.id, f: filterFingerprint(f) })).toString('base64url')
    : null;
  return {
    data: page.map((r) => ({
      ...serializeLink(r, policy), course_name: r.course_name, course_status: r.course_status, total_views: Number(r.total_views),
      active_slot_label: r.active_slot_label,
    })),
    pagination: { next_cursor: nextCursor, has_more: hasMore, limit },
  };
}
