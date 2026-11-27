import 'server-only';
import { json, LIMITS, readJson, storedToResponse } from '@/lib/http';
import { requireSingleIfMatch } from '@/lib/etag';
import { assertUuidPath } from '@/lib/validation';
import { requireIdempotencyKey } from '@/lib/services/idempotency';
import { importCourses, listCoursesForAdmin, updateCourse } from '@/lib/services/courses';
import { getSystemApiStatus, issueSystemKey, revokeSystemKey } from '@/lib/services/system-api-key';
import { inviteEmployee, listEmployees, resendInvitation, updateEmployee } from '@/lib/services/employees';
import { loadUrlPolicy, originFor } from '@/lib/services/settings';
import { authDirectory } from '@/lib/auth/directory';
import { createLinkType, deleteLinkType, listLinkTypesForAdmin, updateLinkType } from '@/lib/services/link-types-admin';
import type { HandlerCtx } from '@/lib/route';
import type { UserPrincipal } from '@/lib/auth/principal';

type Ctx = HandlerCtx<UserPrincipal>;

export async function handleAdminListCourses(c: Ctx) {
  return json({ data: await listCoursesForAdmin(c.db, c.principal.workspaceId) }, 200, c.requestId);
}


export async function handleAdminUpdateCourse(c: Ctx) {
  const id = assertUuidPath(c.params.id);
  const key = requireIdempotencyKey(c.req.headers.get('idempotency-key'));
  const ifMatch = requireSingleIfMatch(c.req.headers.get('if-match'));
  const body = await readJson(c.req, LIMITS.single);
  return storedToResponse(await updateCourse(c.db, c.principal, id, body, ifMatch, key, c.requestId), c.requestId);
}

export async function handleAdminImportCourses(c: Ctx) {
  const key = requireIdempotencyKey(c.req.headers.get('idempotency-key'));
  const body = await readJson(c.req, LIMITS.edit);
  return storedToResponse(await importCourses(c.db, c.principal, body, key, c.requestId), c.requestId);
}



// ---------------------------------------------------------------------------
// 시스템 API 키
// ---------------------------------------------------------------------------

export async function handleApiKeyStatus(c: Ctx) {
  const s = await getSystemApiStatus(c.db, c.principal);
  return json({ data: s }, 200, c.requestId, s.etag ? { ETag: s.etag } : {});
}

export async function handleApiKeyIssue(c: Ctx) {
  const key = requireIdempotencyKey(c.req.headers.get('idempotency-key'));
  const body = await readJson(c.req, LIMITS.single);
  const r = await issueSystemKey(c.db, c.principal, body, key, c.requestId);
  // 원문이 포함될 수 있는 응답: 공유 캐시·멱등성 저장 대상 아님 (private, no-store 는 json() 기본값)
  return json(r.body, r.status, c.requestId);
}

export async function handleApiKeyRevoke(c: Ctx) {
  const id = assertUuidPath(c.params.id);
  const key = requireIdempotencyKey(c.req.headers.get('idempotency-key'));
  const body = await readJson(c.req, LIMITS.single);
  return storedToResponse(await revokeSystemKey(c.db, c.principal, id, body, key, c.requestId), c.requestId);
}


// ---------------------------------------------------------------------------
// 직원 관리 (§3.3~§3.6)
// ---------------------------------------------------------------------------

async function inviteCtx(c: Ctx) {
  const policy = await loadUrlPolicy(c.db);
  // 초대 메일 링크 → /auth/confirm (token_hash 검증) → 초기 설정 화면
  return { redirectTo: `${originFor(policy.primaryHost)}/auth/confirm?next=/account/setup`, requestId: c.requestId };
}

export async function handleListEmployees(c: Ctx) {
  return json({ data: await listEmployees(c.db, c.principal, authDirectory(c.db)) }, 200, c.requestId);
}

export async function handleInviteEmployee(c: Ctx) {
  const body = await readJson(c.req, LIMITS.single);
  const r = await inviteEmployee(c.db, c.principal, body, authDirectory(c.db), await inviteCtx(c));
  return json(r.body, r.status, c.requestId);
}

export async function handleResendInvitation(c: Ctx) {
  const id = assertUuidPath(c.params.id);
  const r = await resendInvitation(c.db, c.principal, id, authDirectory(c.db), await inviteCtx(c));
  return json(r.body, 200, c.requestId);
}

export async function handleUpdateEmployee(c: Ctx) {
  const id = assertUuidPath(c.params.id);
  const key = requireIdempotencyKey(c.req.headers.get('idempotency-key'));
  const ifMatch = requireSingleIfMatch(c.req.headers.get('if-match'));
  const body = await readJson(c.req, LIMITS.single);
  return storedToResponse(await updateEmployee(c.db, c.principal, id, body, ifMatch, key, c.requestId), c.requestId);
}

// ---------------------------------------------------------------------------
// 짧은 주소 유형 관리
// ---------------------------------------------------------------------------

export async function handleListLinkTypes(c: Ctx) {
  return json({ data: await listLinkTypesForAdmin(c.db) }, 200, c.requestId);
}

export async function handleCreateLinkType(c: Ctx) {
  const key = requireIdempotencyKey(c.req.headers.get('idempotency-key'));
  const body = await readJson(c.req, LIMITS.single);
  return storedToResponse(await createLinkType(c.db, c.principal, body, key, c.requestId), c.requestId);
}

export async function handleUpdateLinkType(c: Ctx) {
  const key = requireIdempotencyKey(c.req.headers.get('idempotency-key'));
  const body = await readJson(c.req, LIMITS.single);
  return storedToResponse(await updateLinkType(c.db, c.principal, c.params.key, body, key, c.requestId), c.requestId);
}

export async function handleDeleteLinkType(c: Ctx) {
  const key = requireIdempotencyKey(c.req.headers.get('idempotency-key'));
  return storedToResponse(await deleteLinkType(c.db, c.principal, c.params.key, key, c.requestId), c.requestId);
}
