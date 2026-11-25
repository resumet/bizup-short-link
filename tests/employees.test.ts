import { beforeEach, describe, expect, it } from 'vitest';
import { setupDb } from './helpers/db';
import { AppError } from '@/lib/errors';
import type { UserPrincipal } from '@/lib/auth/principal';
import type { AuthUserState } from '@/lib/auth/access';
import {
  completeOnboarding, InviteDeliveryError, inviteEmployee, listEmployees, memberEtag, resendInvitation, updateEmployee,
  type AuthDirectory,
} from '@/lib/services/employees';

type Env = Awaited<ReturnType<typeof setupDb>>;
let env: Env;
let owner: UserPrincipal;
let n = 0;
const k = () => `emp-key-${++n}`;
const ctx = { redirectTo: 'https://bizup.im/auth/confirm?next=/account/setup', requestId: 'r' };

async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e) { if (e instanceof AppError) return e.code; throw e; }
}

/** Supabase Auth Admin 대역 */
class FakeDirectory implements AuthDirectory {
  users = new Map<string, AuthUserState>();
  byEmail = new Map<string, string>();
  sent: string[] = [];
  failNext: string | null = null;
  async getUsers(ids: string[]) {
    return new Map(ids.map((id) => [id, this.users.get(id) ?? null]));
  }
  async invite(email: string) {
    if (this.failNext) { const c = this.failNext; this.failNext = null; throw new InviteDeliveryError(c); }
    const existing = this.byEmail.get(email);
    if (existing && this.users.get(existing)?.email_confirmed_at) return { userId: existing, existing: true };
    const id = existing ?? crypto.randomUUID();
    this.byEmail.set(email, id);
    this.users.set(id, { id, email, email_confirmed_at: null, banned_until: null, last_sign_in_at: null });
    this.sent.push(email);
    return { userId: id, existing: false };
  }
  /** 직원이 메일 링크를 눌러 이메일 확인 */
  confirm(email: string) {
    const u = this.users.get(this.byEmail.get(email)!)!;
    u.email_confirmed_at = new Date().toISOString();
    return u.id;
  }
}

let dir: FakeDirectory;

beforeEach(async () => {
  env = await setupDb();
  owner = await env.addUser('owner');
  dir = new FakeDirectory();
  dir.users.set(owner.userId, { id: owner.userId, email: 'owner@example.com', email_confirmed_at: new Date().toISOString(), banned_until: null, last_sign_in_at: null });
});

describe('직원 초대 → 초기 설정 (§3.5)', () => {
  it('초대 메일 요청 → 초대 대기 → 초기 설정 완료 후 활성·로그인 가능', async () => {
    const r = await inviteEmployee(env.db, owner, { display_name: '김직원', email: ' Staff@Example.com ', role: 'editor' }, dir, ctx);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ delivery: 'requested', data: { email: 'staff@example.com', status: 'invited', role: 'editor' } });
    expect(dir.sent).toEqual(['staff@example.com']);

    let list = await listEmployees(env.db, owner, dir);
    const invited = list.members.find((m) => m.email === 'staff@example.com')!;
    expect(invited).toMatchObject({ can_login: 'no', reason: '초대 미수락', invitation: { status: 'sent' } });

    const uid = dir.confirm('staff@example.com');
    await completeOnboarding(env.db, owner.workspaceId, uid, '김직원(마케팅)');
    list = await listEmployees(env.db, owner, dir);
    const active = list.members.find((m) => m.email === 'staff@example.com')!;
    expect(active).toMatchObject({ status: 'active', display_name: '김직원(마케팅)', can_login: 'yes' });
    const [inv] = await env.db.query<{ status: string }>(`select status from bzup.employee_invitations`);
    expect(inv.status).toBe('accepted');
  });

  it('이미 등록된 이메일은 거절, 초대 대기 중이면 재발송 안내', async () => {
    await inviteEmployee(env.db, owner, { display_name: 'a', email: 'a@example.com' }, dir, ctx);
    expect(await code(inviteEmployee(env.db, owner, { display_name: 'a', email: 'A@example.com' }, dir, ctx))).toBe('EMPLOYEE_EXISTS');
    expect(await code(inviteEmployee(env.db, owner, { display_name: 'o', email: 'owner-user@example.com' }, dir, ctx))).toBe('EMPLOYEE_EXISTS');
  });

  it('발송 실패는 같은 초대 기록에서 재시도', async () => {
    dir.failNext = 'over_email_send_rate_limit';
    expect(await code(inviteEmployee(env.db, owner, { display_name: 'b', email: 'b@example.com' }, dir, ctx))).toBe('INVITE_DELIVERY_FAILED');
    let list = await listEmployees(env.db, owner, dir);
    expect(list.pending_invitations).toHaveLength(1);
    expect(list.pending_invitations[0]).toMatchObject({ status: 'failed', last_error_code: 'over_email_send_rate_limit' });

    await resendInvitation(env.db, owner, list.pending_invitations[0].id, dir, ctx);
    list = await listEmployees(env.db, owner, dir);
    expect(list.pending_invitations).toHaveLength(0);
    expect(list.members.find((m) => m.email === 'b@example.com')?.status).toBe('invited');
    expect(await env.db.query(`select id from bzup.employee_invitations`)).toHaveLength(1);
  });

  it('이미 확인된 Auth 계정은 새로 만들지 않고 연결 → 초기 설정 대기', async () => {
    const id = crypto.randomUUID();
    dir.byEmail.set('old@example.com', id);
    dir.users.set(id, { id, email: 'old@example.com', email_confirmed_at: new Date().toISOString(), banned_until: null, last_sign_in_at: null });
    const r = await inviteEmployee(env.db, owner, { display_name: '기존', email: 'old@example.com', role: 'viewer' }, dir, ctx);
    expect(r.body).toMatchObject({ delivery: 'linked_existing_account', data: { status: 'onboarding' } });
    expect(dir.sent).toEqual([]);
  });

  it('editor 는 초대 불가, 형식 오류 거절', async () => {
    const editor = await env.addUser('editor');
    expect(await code(inviteEmployee(env.db, editor, { display_name: 'x', email: 'x@example.com' }, dir, ctx))).toBe('INSUFFICIENT_PERMISSION');
    expect(await code(inviteEmployee(env.db, owner, { display_name: 'x', email: 'not-an-email' }, dir, ctx))).toBe('VALIDATION_ERROR');
    expect(await code(inviteEmployee(env.db, owner, { display_name: 'x', email: 'x@example.com', role: 'admin' }, dir, ctx))).toBe('VALIDATION_ERROR');
  });
});

describe('역할 변경·접근 중지 (§3.6)', () => {
  it('마지막 활성 owner 는 강등·중지 불가, 다른 owner 가 있으면 가능', async () => {
    const etag = memberEtag(owner.memberId, 1);
    expect(await code(updateEmployee(env.db, owner, owner.memberId, { role: 'editor' }, etag, k(), 'r'))).toBe('LAST_OWNER_REQUIRED');
    expect(await code(updateEmployee(env.db, owner, owner.memberId, { status: 'suspended' }, etag, k(), 'r'))).toBe('LAST_OWNER_REQUIRED');

    const owner2 = await env.addUser('owner', 'owner2');
    const r = await updateEmployee(env.db, owner2, owner.memberId, { role: 'editor' }, etag, k(), 'r');
    expect((r.body as { data: { role: string; version: number } }).data).toMatchObject({ role: 'editor', version: 2 });
    // 옛 ETag 412
    expect(await code(updateEmployee(env.db, owner2, owner.memberId, { role: 'viewer' }, etag, k(), 'r'))).toBe('PRECONDITION_FAILED');
  });

  it('중지된 직원은 다음 요청부터 거절, 재개하면 다시 활성', async () => {
    const editor = await env.addUser('editor');
    const r = await updateEmployee(env.db, owner, editor.memberId, { status: 'suspended' }, memberEtag(editor.memberId, 1), k(), 'r');
    expect(await code(listEmployees(env.db, { ...editor, role: 'owner' }, dir))).toBe('ACCESS_SUSPENDED');
    await updateEmployee(env.db, owner, editor.memberId, { status: 'active' }, r.headers.ETag, k(), 'r');
    const [m] = await env.db.query<{ status: string }>(`select status from bzup.workspace_members where id = $1`, [editor.memberId]);
    expect(m.status).toBe('active');
    const audits = await env.db.query<{ action: string }>(
      `select action from bzup.admin_audit_events where object_id = $1 order by created_at`, [editor.memberId]);
    expect(audits.map((a) => a.action)).toEqual(['employee_suspended', 'employee_resumed']);
  });
});
