// /api/v1 과 /internal 이 공유하는 링크 핸들러
import 'server-only';
import { json, LIMITS, readJson, searchParamsObject, storedToResponse } from '@/lib/http';
import { requireSingleIfMatch } from '@/lib/etag';
import { assertUuidPath } from '@/lib/validation';
import { requireIdempotencyKey } from '@/lib/services/idempotency';
import {
  batchBody, createBatch, createSingleLink, getLink, getLinkRevisions, parseBatchCreateBody, parsePatchBody,
  parseSingleCreateBody, patchLink, preflight, serializeLink,
} from '@/lib/services/links';
import { listLinks } from '@/lib/services/link-query';
import { getDailyViews } from '@/lib/services/views';
import { requirePermission } from '@/lib/auth/principal';
import { AppError } from '@/lib/errors';
import type { HandlerCtx } from '@/lib/route';

const writeCtx = (c: HandlerCtx, key: string) => ({ idempotencyKey: key, requestId: c.requestId, apiBase: c.apiBase });

export async function handleCreateLink(c: HandlerCtx) {
  const key = requireIdempotencyKey(c.req.headers.get('idempotency-key'));
  const input = parseSingleCreateBody(await readJson(c.req, LIMITS.single));
  const r = await createSingleLink(c.db, c.principal, input, writeCtx(c, key));
  return storedToResponse(r, c.requestId);
}

export async function handleListLinks(c: HandlerCtx) {
  const result = await listLinks(c.db, c.principal, searchParamsObject(c.req.url));
  return json(result, 200, c.requestId);
}

export async function handleGetLink(c: HandlerCtx) {
  const id = assertUuidPath(c.params.id);
  const { link, slots, policy, etag } = await getLink(c.db, c.principal, id);
  return json({ data: serializeLink(link, policy, slots) }, 200, c.requestId, { ETag: etag });
}

export async function handlePatchLink(c: HandlerCtx) {
  const id = assertUuidPath(c.params.id);
  // 권한·멱등성 재생을 If-Match 평가보다 먼저 수행한다 (§14.6)
  requirePermission(c.principal, 'links:update');
  const key = requireIdempotencyKey(c.req.headers.get('idempotency-key'));
  const ifMatch = requireSingleIfMatch(c.req.headers.get('if-match'));
  const input = parsePatchBody(await readJson(c.req, LIMITS.single));
  const r = await patchLink(c.db, c.principal, id, input, ifMatch, writeCtx(c, key));
  return storedToResponse(r, c.requestId);
}

export async function handleRevisions(c: HandlerCtx) {
  const id = assertUuidPath(c.params.id);
  return json({ data: await getLinkRevisions(c.db, c.principal, id) }, 200, c.requestId);
}

export async function handleViews(c: HandlerCtx) {
  const id = assertUuidPath(c.params.id);
  const raw = new URL(c.req.url).searchParams.get('days');
  const days = raw === null ? 30 : Number(raw);
  return json({ data: await getDailyViews(c.db, c.principal, id, days) }, 200, c.requestId);
}

export async function handlePreflight(c: HandlerCtx) {
  const body = await readJson(c.req, LIMITS.bulk);
  return json({ data: await preflight(c.db, c.principal, body) }, 200, c.requestId);
}

export async function handleCreateBatch(c: HandlerCtx) {
  const key = requireIdempotencyKey(c.req.headers.get('idempotency-key'));
  const input = parseBatchCreateBody(await readJson(c.req, LIMITS.bulk));
  const r = await createBatch(c.db, c.principal, input, writeCtx(c, key));
  return storedToResponse(r, c.requestId);
}

export async function handleGetBatch(c: HandlerCtx) {
  requirePermission(c.principal, 'links:read');
  const id = assertUuidPath(c.params.id);
  return json({ data: await batchBody(c.db, c.principal.workspaceId, id) }, 200, c.requestId);
}

export async function handleListCourses(c: HandlerCtx) {
  // 웹은 직원 모두, 외부는 courses:read
  if (c.principal.kind === 'api_client') requirePermission(c.principal, 'courses:read');
  const sp = new URL(c.req.url).searchParams;
  const status = sp.get('status');
  if (status && status !== 'active' && status !== 'closed') throw new AppError('VALIDATION_ERROR', 'status 값이 올바르지 않습니다.');
  const rows = await c.db.query<{ id: string; name: string; instructor_name: string | null; status: string; created_at: Date; updated_at: Date; version: number }>(
    `select id, name, instructor_name, status, created_at, updated_at, version from bzup.courses
      where workspace_id = $1 and ($2::text is null or status = $2)
      order by status, name, created_at`,
    [c.principal.workspaceId, status],
  );
  return json({ data: rows.map((r) => ({ ...r, version: Number(r.version) })) }, 200, c.requestId);
}

export async function handleGetTemplate(c: HandlerCtx) {
  requirePermission(c.principal, 'links:create');
  const t = await c.db.query<{ id: string; display_name: string; version: number }>(
    `select id, display_name, version from bzup.generation_templates where workspace_id = $1`,
    [c.principal.workspaceId],
  );
  if (!t[0]) return json({ data: null }, 200, c.requestId);
  const items = await c.db.query<{ id: string; name: string; sort_order: number }>(
    `select id, name, sort_order, destination_slots from bzup.generation_template_items where template_id = $1 and is_active order by sort_order, id`,
    [t[0].id],
  );
  return json({ data: { id: t[0].id, display_name: t[0].display_name, version: Number(t[0].version), items } }, 200, c.requestId);
}
