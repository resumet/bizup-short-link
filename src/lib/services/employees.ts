// 직원 관리 (PRD §3.3~§3.6)
// - 직원 목록은 회사 멤버십·초대 기록 기준 (Supabase 전체 사용자 명단을 내려보내지 않는다)
// - 초대: 초대 기록(sending) → Auth 초대 메일 → 멤버십 연결(sent). Auth 호출과 DB 쓰기는 한 트랜잭션이 아니므로
//   초대 상태로 재시도를 복구한다 (§3.5)
// - 마지막 활성 owner 의 중지·강등 금지, 회사 잠금으로 동시 강등 차단 (§3.6)
import { AppError, validationError } from '@/lib/errors';
import { toIso } from '@/lib/time';
import type { Db, Queryable } from '@/lib/db/types';
import { lockWorkspace } from '@/lib/db/locks';
import { recheckPrincipal, type Role, type UserPrincipal } from '@/lib/auth/principal';
import { evaluateAccess, ACCESS_REASON_LABEL, type AuthUserState, type MemberState } from '@/lib/auth/access';
import { assertAllowedFields, cleanText, isObject } from '@/lib/validation';
import { audit, runAdminWrite } from './admin-write';
import { consume, limits } from './ratelimit';

/** Auth 계정 조회·초대 (Supabase Auth Admin 또는 로컬 개발용 대체 구현) */
export interface AuthDirectory {
  /** 'error' 는 조회 실패(추측하지 않음), Map 값 null 은 계정 없음 */
  getUsers(ids: string[]): Promise<Map<string, AuthUserState | null> | 'error'>;
  /** 초대 메일 발송 요청. existing=true 면 이미 있는 Auth 계정에 연결 (메일 미발송) */
  invite(email: string, redirectTo: string): Promise<{ userId: string; existing: boolean; autoAccept?: boolean }>;
}

export class InviteDeliveryError extends Error {
  constructor(readonly code: string) { super(code); }
}

const ROLES: readonly Role[] = ['owner', 'editor', 'viewer'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const memberEtag = (id: string, version: number) => `"member-${id}-v${version}"`;

interface MemberRow extends MemberState {
  id: string;
  user_id: string;
  display_name: string;
  email: string;
  invited_at: Date | null;
  joined_at: Date | null;
  suspended_at: Date | null;
  version: number;
  invitation_id: string | null;
  invitation_status: string | null;
  invitation_error: string | null;
}

const MEMBER_SELECT = `
  select m.id, m.user_id, m.display_name, m.email, m.role, m.status, m.invited_at, m.joined_at, m.suspended_at, m.version,
         i.id as invitation_id, i.status as invitation_status, i.last_error_code as invitation_error
    from bzup.workspace_members m
    left join lateral (
      select e.id, e.status, e.last_error_code from bzup.employee_invitations e
       where e.workspace_id = m.workspace_id and e.member_id = m.id
       order by e.created_at desc limit 1
    ) i on true`;

function serializeMember(m: MemberRow, auth?: AuthUserState | null | 'error') {
  const decision = auth === undefined ? null : evaluateAccess(auth, m);
  return {
    id: m.id,
    display_name: m.display_name,
    email: m.email,
    role: m.role,
    status: m.status,
    version: Number(m.version),
    invited_at: toIso(m.invited_at),
    joined_at: toIso(m.joined_at),
    suspended_at: toIso(m.suspended_at),
    last_sign_in_at: auth && auth !== 'error' ? auth.last_sign_in_at : null,
    can_login: decision?.canLogin ?? null,
    reason: decision && decision.reason !== 'ok' ? ACCESS_REASON_LABEL[decision.reason] : null,
    invitation: m.invitation_id ? { id: m.invitation_id, status: m.invitation_status, error: m.invitation_error } : null,
  };
}

async function ensureOwner(q: Queryable, p: UserPrincipal): Promise<UserPrincipal> {
  const owner = await recheckPrincipal(q, p);
  if (owner.role !== 'owner') throw new AppError('INSUFFICIENT_PERMISSION');
  return owner;
}

export async function listEmployees(db: Db, p: UserPrincipal, dir: AuthDirectory) {
  await ensureOwner(db, p);
  const members = await db.query<MemberRow>(
    `${MEMBER_SELECT}
      where m.workspace_id = $1
      order by case m.status when 'active' then 0 when 'onboarding' then 1 when 'invited' then 2 else 3 end,
               case m.role when 'owner' then 0 when 'editor' then 1 else 2 end, m.display_name`,
    [p.workspaceId],
  );
  // Auth 계정이 연결되기 전 실패한 초대 (재발송 대상)
  const pending = await db.query<{ id: string; email: string; display_name: string; role: Role; status: string; last_error_code: string | null; created_at: Date }>(
    `select id, normalized_email as email, display_name, intended_role as role, status, last_error_code, created_at
       from bzup.employee_invitations
      where workspace_id = $1 and member_id is null and status in ('pending','sending','sent','failed')
      order by created_at desc`,
    [p.workspaceId],
  );
  let auth: Map<string, AuthUserState | null> | 'error';
  try {
    auth = members.length ? await dir.getUsers(members.map((m) => m.user_id)) : new Map();
  } catch {
    auth = 'error';
  }
  return {
    members: members.map((m) => serializeMember(m, auth === 'error' ? 'error' : auth.get(m.user_id) ?? null)),
    pending_invitations: pending.map((i) => ({ ...i, created_at: toIso(i.created_at) })),
    auth_status: auth === 'error' ? 'unavailable' : 'ok',
  };
}

function parseInvite(body: unknown) {
  if (!isObject(body)) throw validationError('요청 형식이 올바르지 않습니다.');
  assertAllowedFields(body, ['display_name', 'email', 'role']);
  const displayName = cleanText(body.display_name, 'display_name', '이름', 1, 80);
  if (typeof body.email !== 'string') throw validationError('이메일을 입력해 주세요.', [{ field: 'email', message: '이메일을 입력해 주세요.' }]);
  const email = body.email.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    throw validationError('이메일 형식이 올바르지 않습니다.', [{ field: 'email', message: '이메일 형식이 올바르지 않습니다.' }]);
  }
  const role = (body.role ?? 'editor') as Role;
  if (!ROLES.includes(role)) throw validationError('역할을 확인해 주세요.', [{ field: 'role', message: '역할을 확인해 주세요.' }]);
  return { displayName, email, role };
}

export interface InviteCtx { redirectTo: string; requestId: string }

/** 직원 초대 (§3.5) */
export async function inviteEmployee(db: Db, p: UserPrincipal, body: unknown, dir: AuthDirectory, ctx: InviteCtx) {
  const input = parseInvite(body);
  await ensureOwner(db, p);
  await consume(db, limits.write(p));
  const invitationId = await db.tx(async (q) => {
    await lockWorkspace(q, p.workspaceId);
    const owner = await ensureOwner(q, p);
    const exists = await q.query<{ status: string }>(
      `select status from bzup.workspace_members where workspace_id = $1 and lower(email) = $2`,
      [owner.workspaceId, input.email],
    );
    if (exists[0]) {
      throw new AppError('EMPLOYEE_EXISTS', exists[0].status === 'invited' || exists[0].status === 'onboarding'
        ? '이미 초대한 직원입니다. 목록에서 초대를 다시 보내 주세요.'
        : '이미 등록된 직원입니다.');
    }
    // 같은 이메일의 진행 중 초대가 있으면 그 기록에서 재시도한다
    const cur = await q.query<{ id: string }>(
      `select id from bzup.employee_invitations
        where workspace_id = $1 and normalized_email = $2 and status in ('pending','sending','sent','failed')`,
      [owner.workspaceId, input.email],
    );
    if (cur[0]) {
      await q.query(
        `update bzup.employee_invitations set display_name = $2, intended_role = $3, status = 'sending', request_id = $4, updated_at = now()
          where id = $1`,
        [cur[0].id, input.displayName, input.role, ctx.requestId],
      );
      return cur[0].id;
    }
    const [row] = await q.query<{ id: string }>(
      `insert into bzup.employee_invitations
         (workspace_id, normalized_email, display_name, intended_role, status, invited_by, request_id, expires_at)
       values ($1,$2,$3,$4,'sending',$5,$6, now() + interval '7 days') returning id`,
      [owner.workspaceId, input.email, input.displayName, input.role, owner.userId, ctx.requestId],
    );
    return row.id;
  });
  return deliver(db, p, invitationId, dir, ctx);
}

/** 초대 재발송: 같은 초대 기록에서 재시도 (§3.5-7) */
export async function resendInvitation(db: Db, p: UserPrincipal, invitationId: string, dir: AuthDirectory, ctx: InviteCtx) {
  await ensureOwner(db, p);
  await consume(db, limits.write(p));
  await db.tx(async (q) => {
    await lockWorkspace(q, p.workspaceId);
    await ensureOwner(q, p);
    const rows = await q.query<{ status: string; member_status: string | null }>(
      `select e.status, m.status as member_status from bzup.employee_invitations e
         left join bzup.workspace_members m on m.workspace_id = e.workspace_id and m.id = e.member_id
        where e.workspace_id = $1 and e.id = $2 for update of e`,
      [p.workspaceId, invitationId],
    );
    const inv = rows[0];
    if (!inv) throw new AppError('NOT_FOUND');
    if (!['pending', 'sending', 'sent', 'failed'].includes(inv.status) || (inv.member_status && !['invited', 'onboarding'].includes(inv.member_status))) {
      throw new AppError('CONFLICT', '이미 수락했거나 취소된 초대입니다.');
    }
    await q.query(
      `update bzup.employee_invitations set status = 'sending', request_id = $2, updated_at = now(), expires_at = now() + interval '7 days'
        where id = $1`,
      [invitationId, ctx.requestId],
    );
  });
  return deliver(db, p, invitationId, dir, ctx);
}

async function deliver(db: Db, p: UserPrincipal, invitationId: string, dir: AuthDirectory, ctx: InviteCtx) {
  const [inv] = await db.query<{ normalized_email: string; display_name: string; intended_role: Role }>(
    `select normalized_email, display_name, intended_role from bzup.employee_invitations where workspace_id = $1 and id = $2`,
    [p.workspaceId, invitationId],
  );
  let result: { userId: string; existing: boolean; autoAccept?: boolean };
  try {
    result = await dir.invite(inv.normalized_email, ctx.redirectTo);
  } catch (e) {
    const code = e instanceof InviteDeliveryError ? e.code : 'unknown';
    await db.query(
      `update bzup.employee_invitations set status = 'failed', last_error_code = $2, updated_at = now() where id = $1`,
      [invitationId, code.slice(0, 80)],
    );
    throw new AppError('INVITE_DELIVERY_FAILED');
  }

  return db.tx(async (q) => {
    await lockWorkspace(q, p.workspaceId);
    const owner = await ensureOwner(q, p);
    const found = await q.query<{ id: string; status: string }>(
      `select id, status from bzup.workspace_members where workspace_id = $1 and user_id = $2 for update`,
      [owner.workspaceId, result.userId],
    );
    if (found[0] && ['active', 'suspended'].includes(found[0].status)) {
      await q.query(`update bzup.employee_invitations set status = 'revoked', updated_at = now() where id = $1`, [invitationId]);
      throw new AppError('EMPLOYEE_EXISTS');
    }
    // 개발 대체 구현은 바로 활성, 기존 Auth 계정은 로그인 후 초기 설정, 신규 계정은 메일 수락 대기
    const status = result.autoAccept ? 'active' : result.existing ? 'onboarding' : 'invited';
    let memberId: string;
    if (found[0]) {
      memberId = found[0].id;
      await q.query(
        `update bzup.workspace_members set display_name = $2, email = $3, role = $4, status = $5, invited_at = now(),
                version = version + 1, updated_at = now() where id = $1`,
        [memberId, inv.display_name, inv.normalized_email, inv.intended_role, status],
      );
    } else {
      const [m] = await q.query<{ id: string }>(
        `insert into bzup.workspace_members (workspace_id, user_id, display_name, email, role, status, invited_at, joined_at)
         values ($1,$2,$3,$4,$5,$6, now(), case when $6 = 'active' then now() end) returning id`,
        [owner.workspaceId, result.userId, inv.display_name, inv.normalized_email, inv.intended_role, status],
      );
      memberId = m.id;
    }
    const invStatus = result.autoAccept ? 'accepted' : 'sent';
    await q.query(
      `update bzup.employee_invitations
          set status = $2, auth_user_id = $3, member_id = $4, delivery_requested_at = now(), last_error_code = null,
              accepted_at = case when $2 = 'accepted' then now() end, updated_at = now()
        where id = $1`,
      [invitationId, invStatus, result.userId, memberId],
    );
    await audit(q, owner, {
      objectType: 'workspace_member', objectId: memberId, action: 'employee_invited',
      after: { email: inv.normalized_email, role: inv.intended_role, status, existing_account: result.existing }, requestId: ctx.requestId,
    });
    const [row] = await q.query<MemberRow>(`${MEMBER_SELECT} where m.id = $1`, [memberId]);
    return {
      status: 201,
      body: {
        data: serializeMember(row),
        // 메일 API 성공은 수신·수락이 아니다 (§3.5)
        delivery: result.autoAccept ? 'dev_auto_accepted' : result.existing ? 'linked_existing_account' : 'requested',
      },
    };
  });
}

/** 역할 변경·접근 중지·재개 (§3.6) */
export async function updateEmployee(db: Db, p: UserPrincipal, id: string, body: unknown, ifMatch: string, key: string, requestId: string) {
  if (!isObject(body)) throw validationError('요청 형식이 올바르지 않습니다.');
  assertAllowedFields(body, ['role', 'status']);
  if (body.role !== undefined && !ROLES.includes(body.role as Role)) throw validationError('역할을 확인해 주세요.');
  if (body.status !== undefined && body.status !== 'active' && body.status !== 'suspended') throw validationError('상태를 확인해 주세요.');
  const wantRole = body.role as Role | undefined;
  const wantStatus = body.status as 'active' | 'suspended' | undefined;

  return runAdminWrite(db, p, {
    method: 'PATCH', route: `/admin/employees/${id}`, idempotencyKey: key, hashInput: { body, if_match: ifMatch }, resultObjectType: 'workspace_member',
  }, async (q, owner) => {
    const rows = await q.query<MemberRow>(`${MEMBER_SELECT} where m.workspace_id = $1 and m.id = $2 for update of m`, [owner.workspaceId, id]);
    const cur = rows[0];
    if (!cur) throw new AppError('NOT_FOUND');
    const etag = memberEtag(cur.id, Number(cur.version));
    if (ifMatch !== etag) throw new AppError('PRECONDITION_FAILED', undefined, { headers: { ETag: etag } });

    const nextRole = wantRole ?? cur.role;
    let nextStatus = cur.status;
    if (wantStatus === 'suspended') nextStatus = 'suspended';
    // 재개: 가입을 마친 직원은 활성, 아직이면 초대 대기로 되돌린다
    if (wantStatus === 'active' && cur.status === 'suspended') nextStatus = cur.joined_at ? 'active' : 'invited';

    if (cur.role === 'owner' && cur.status === 'active' && (nextRole !== 'owner' || nextStatus !== 'active')) {
      const [{ n }] = await q.query<{ n: number }>(
        `select count(*)::int as n from bzup.workspace_members
          where workspace_id = $1 and role = 'owner' and status = 'active' and id <> $2`,
        [owner.workspaceId, id],
      );
      if (n === 0) throw new AppError('LAST_OWNER_REQUIRED');
    }

    const changed: string[] = [];
    if (nextRole !== cur.role) changed.push('role');
    if (nextStatus !== cur.status) changed.push('status');
    let result = cur;
    if (changed.length) {
      await q.query(
        `update bzup.workspace_members
            set role = $3, status = $4, version = version + 1, updated_at = clock_timestamp(),
                suspended_at = case when $4 = 'suspended' then clock_timestamp() else null end
          where workspace_id = $1 and id = $2`,
        [owner.workspaceId, id, nextRole, nextStatus],
      );
      [result] = await q.query<MemberRow>(`${MEMBER_SELECT} where m.id = $1`, [id]);
      const action = changed.includes('status')
        ? (nextStatus === 'suspended' ? 'employee_suspended' : 'employee_resumed')
        : 'employee_role_changed';
      await audit(q, owner, {
        objectType: 'workspace_member', objectId: id, action,
        before: { role: cur.role, status: cur.status }, after: { role: nextRole, status: nextStatus }, requestId,
      });
    }
    return {
      status: 200,
      body: { data: serializeMember(result), changed_fields: changed },
      headers: { ETag: memberEtag(id, Number(result.version)) },
      objectId: id,
    };
  });
}

/** 초대받은 직원의 초기 설정 완료: 표시명 확정 후 멤버십 활성화 (§3.5-6) */
export async function completeOnboarding(db: Db, workspaceId: string, userId: string, displayName: string) {
  const name = cleanText(displayName, 'display_name', '이름', 1, 80);
  return db.tx(async (q) => {
    await lockWorkspace(q, workspaceId);
    const rows = await q.query<{ id: string; status: string; role: Role; display_name: string }>(
      `select id, status, role, display_name from bzup.workspace_members where workspace_id = $1 and user_id = $2 for update`,
      [workspaceId, userId],
    );
    const m = rows[0];
    if (!m) throw new AppError('INSUFFICIENT_PERMISSION', '이 서비스의 직원으로 등록되지 않았습니다.');
    if (m.status === 'suspended') throw new AppError('ACCESS_SUSPENDED');
    if (m.status === 'active') return m.id;
    await q.query(
      `update bzup.workspace_members set display_name = $2, status = 'active', joined_at = clock_timestamp(),
              version = version + 1, updated_at = clock_timestamp() where id = $1`,
      [m.id, name],
    );
    await q.query(
      `update bzup.employee_invitations set status = 'accepted', accepted_at = now(), updated_at = now()
        where workspace_id = $1 and member_id = $2 and status in ('pending','sending','sent','failed')`,
      [workspaceId, m.id],
    );
    await q.query(
      `insert into bzup.admin_audit_events (workspace_id, actor_type, actor_user_id, object_type, object_id, action, after_data)
       values ($1, 'user', $2, 'workspace_member', $3, 'employee_joined', $4::text::jsonb)`,
      [workspaceId, userId, m.id, JSON.stringify({ display_name: name, role: m.role })],
    );
    return m.id;
  });
}

/** 초대 대기 직원의 현재 상태 (로그인·초기 설정 화면용) */
export async function memberForUser(q: Queryable, workspaceId: string, userId: string) {
  const rows = await q.query<{ id: string; status: string; role: Role; display_name: string; email: string }>(
    `select id, status, role, display_name, email from bzup.workspace_members where workspace_id = $1 and user_id = $2`,
    [workspaceId, userId],
  );
  return rows[0] ?? null;
}
