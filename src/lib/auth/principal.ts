// 인증 주체와 권한 (PRD §3.2, §13.5, §13.7)
import { AppError } from '@/lib/errors';
import type { Queryable } from '@/lib/db/types';

export const API_SCOPES = ['links:create', 'links:read', 'links:update', 'courses:read'] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export type Role = 'owner' | 'editor' | 'viewer';

export interface UserPrincipal {
  kind: 'user';
  workspaceId: string;
  userId: string;
  memberId: string;
  role: Role;
  displayName: string;
}

export interface ApiPrincipal {
  kind: 'api_client';
  workspaceId: string;
  apiClientId: string;
  apiKeyId: string;
  scopes: ApiScope[];
  clientName: string;
}

export type Principal = UserPrincipal | ApiPrincipal;

/** 업무 권한. API 키는 scope, 직원은 역할로 판단한다. */
export type Permission = ApiScope;

const ROLE_PERMS: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(API_SCOPES),
  editor: new Set(API_SCOPES),
  viewer: new Set<Permission>(['links:read', 'courses:read']),
};

export function hasPermission(p: Principal, perm: Permission): boolean {
  return p.kind === 'user' ? ROLE_PERMS[p.role].has(perm) : p.scopes.includes(perm);
}

export function requirePermission(p: Principal, perm: Permission): void {
  if (hasPermission(p, perm)) return;
  throw p.kind === 'user' ? new AppError('INSUFFICIENT_PERMISSION') : new AppError('INSUFFICIENT_SCOPE');
}

export function requireOwner(p: Principal): asserts p is UserPrincipal {
  if (p.kind !== 'user' || p.role !== 'owner') throw new AppError('INSUFFICIENT_PERMISSION');
}

export function principalRef(p: Principal): { type: 'user' | 'api_client'; id: string; label: string; apiKeyId: string | null } {
  return p.kind === 'user'
    ? { type: 'user', id: p.userId, label: p.displayName, apiKeyId: null }
    : { type: 'api_client', id: p.apiClientId, label: p.clientName, apiKeyId: p.apiKeyId };
}

export function sourceOf(p: Principal): 'web' | 'api' {
  return p.kind === 'user' ? 'web' : 'api';
}

/**
 * 회사 잠금 이후 별도 SQL 문으로 현재 권한을 다시 읽는다 (§16.2).
 * API 키의 만료·폐기 예정은 실제 현재 시각(clock_timestamp)으로 판정한다 (§13.9).
 * 현재 권한을 반영한 새 principal 을 돌려준다.
 */
export async function recheckPrincipal<P extends Principal>(q: Queryable, p: P, perm?: Permission): Promise<P> {
  if (p.kind === 'user') {
    const rows = await q.query<{ role: Role; status: string; display_name: string }>(
      `select role, status, display_name from bzup.workspace_members
        where workspace_id = $1 and user_id = $2`,
      [p.workspaceId, p.userId],
    );
    const m = rows[0];
    if (!m) throw new AppError('UNAUTHENTICATED');
    if (m.status === 'suspended') throw new AppError('ACCESS_SUSPENDED');
    if (m.status !== 'active') throw new AppError('INSUFFICIENT_PERMISSION');
    const next = { ...p, role: m.role, displayName: m.display_name } as P;
    if (perm) requirePermission(next, perm);
    return next;
  }
  const rows = await q.query<{ scopes: string[]; valid: boolean; client_name: string }>(
    `select k.scopes, c.name as client_name,
            (k.status = 'active' and k.deleted_at is null and k.secret_hash is not null
             and c.status = 'active'
             and clock_timestamp() < k.expires_at
             and (k.scheduled_revoke_at is null or clock_timestamp() < k.scheduled_revoke_at)) as valid
       from bzup.api_keys k
       join bzup.api_clients c on c.workspace_id = k.workspace_id and c.id = k.api_client_id
      where k.workspace_id = $1 and k.id = $2 and k.api_client_id = $3`,
    [p.workspaceId, p.apiKeyId, p.apiClientId],
  );
  const k = rows[0];
  if (!k || !k.valid) throw new AppError('INVALID_API_KEY');
  const next = {
    ...p,
    scopes: k.scopes as ApiScope[],
    clientName: k.client_name,
  } as P;
  if (perm) requirePermission(next, perm);
  return next;
}
