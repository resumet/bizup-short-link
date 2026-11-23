import { beforeEach, describe, expect, it } from 'vitest';
import { setupDb, HOST } from './helpers/db';
import { AppError } from '@/lib/errors';
import { authenticateApiKey } from '@/lib/auth/api-key';
import { createSingleLink, parseSingleCreateBody } from '@/lib/services/links';
import { listLinks } from '@/lib/services/link-query';
import { evaluateAccess } from '@/lib/auth/access';
import type { UserPrincipal } from '@/lib/auth/principal';

type Env = Awaited<ReturnType<typeof setupDb>>;
let env: Env;
let owner: UserPrincipal;
let courseA: string;
let n = 0;

async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e) { if (e instanceof AppError) return e.code; throw e; }
}

beforeEach(async () => {
  env = await setupDb();
  owner = await env.addUser('owner');
  courseA = await env.addCourse('김선아 강의');
});

describe('외부 API 키 인증 (AC-99~AC-101, AC-126)', () => {
  it('유효 키는 인증, 형식 오류·오답·환경 교차는 INVALID_API_KEY', async () => {
    const { plaintext, keyId } = await env.addApiKey(owner, ['links:create']);
    const p = await authenticateApiKey(env.db, `Bearer ${plaintext}`);
    expect(p.apiKeyId).toBe(keyId);
    expect(await code(authenticateApiKey(env.db, null))).toBe('INVALID_API_KEY');
    expect(await code(authenticateApiKey(env.db, plaintext))).toBe('INVALID_API_KEY');
    expect(await code(authenticateApiKey(env.db, `Bearer ${plaintext.slice(0, -1)}x`))).toBe('INVALID_API_KEY');
    expect(await code(authenticateApiKey(env.db, `Bearer ${plaintext.replace('bzup_live_', 'bzup_test_')}`))).toBe('INVALID_API_KEY');
    expect(await code(authenticateApiKey(env.db, 'Bearer eyJhbGciOiJIUzI1NiJ9.x.y'))).toBe('INVALID_API_KEY');
  });

  it('중지·만료·교체 종료·삭제·연동 중지 키는 모두 401', async () => {
    const cases: [string, string][] = [
      ['suspended', `update bzup.api_keys set status='suspended' where id=$1`],
      ['expired', `update bzup.api_keys set expires_at = created_at + interval '1 millisecond' where id=$1`],
      ['rotation', `update bzup.api_keys set scheduled_revoke_at = now() - interval '1 second' where id=$1`],
      ['deleted', `update bzup.api_keys set status='revoked', revoked_at=now(), deleted_at=now(), secret_hash=null where id=$1`],
      ['client', `update bzup.api_clients set status='suspended' where id=(select api_client_id from bzup.api_keys where id=$1)`],
    ];
    for (const [, sql] of cases) {
      const { plaintext, keyId } = await env.addApiKey(owner, ['links:read']);
      await env.db.query(sql, [keyId]);
      expect(await code(authenticateApiKey(env.db, `Bearer ${plaintext}`))).toBe('INVALID_API_KEY');
    }
  });

  it('create 전용 키는 목록 조회 403 INSUFFICIENT_SCOPE (AC-102)', async () => {
    const { principal } = await env.addApiKey(owner, ['links:create']);
    expect(await code(listLinks(env.db, principal, {}))).toBe('INSUFFICIENT_SCOPE');
  });
});

describe('목록·필터·cursor (§9, §14.5)', () => {
  async function seed(count: number) {
    const editor = await env.addUser('editor');
    for (let i = 0; i < count; i++) {
      await createSingleLink(env.db, editor, parseSingleCreateBody({
        course_id: courseA, name: `링크 ${i}`, destination_url: `https://bizupclass.com/p/${i}`,
      }), { idempotencyKey: `seed-key-${++n}`, requestId: 'r', apiBase: '/internal' });
    }
    return editor;
  }

  it('최신순 페이지 나누기와 cursor', async () => {
    const editor = await seed(5);
    const p1 = await listLinks(env.db, editor, { limit: '2' });
    expect(p1.data.map((d) => d.name)).toEqual(['링크 4', '링크 3']);
    expect(p1.pagination.has_more).toBe(true);
    const p2 = await listLinks(env.db, editor, { limit: '2', cursor: p1.pagination.next_cursor! });
    expect(p2.data.map((d) => d.name)).toEqual(['링크 2', '링크 1']);
    const p3 = await listLinks(env.db, editor, { limit: '2', cursor: p2.pagination.next_cursor! });
    expect(p3.data.map((d) => d.name)).toEqual(['링크 0']);
    expect(p3.pagination.has_more).toBe(false);
    // 다른 필터와 cursor 혼합은 400
    expect(await code(listLinks(env.db, editor, { limit: '2', status: 'active', cursor: p1.pagination.next_cursor! }))).toBe('INVALID_CURSOR');
  });

  it('검색: 명칭·목적지 부분, 코드·전체 짧은 주소는 대소문자 구분', async () => {
    const editor = await seed(3);
    const all = await listLinks(env.db, editor, {});
    const target = all.data[1];
    expect((await listLinks(env.db, editor, { q: 'BIZUPCLASS.com/p/1' })).data.map((d) => d.id)).toEqual([target.id]);
    expect((await listLinks(env.db, editor, { q: target.short_code })).data.map((d) => d.id)).toContain(target.id);
    expect((await listLinks(env.db, editor, { q: `https://${HOST}/${target.short_code}` })).data.map((d) => d.id)).toEqual([target.id]);
    const swapped = target.short_code.replace(/[a-zA-Z]/, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
    if (swapped !== target.short_code) {
      expect((await listLinks(env.db, editor, { short_code: swapped })).data).toHaveLength(0);
    }
    expect(await code(listLinks(env.db, editor, { q: 'x'.repeat(201) }))).toBe('VALIDATION_ERROR');
    expect(await code(listLinks(env.db, editor, { course_id: courseA, course_unassigned: 'true' }))).toBe('VALIDATION_ERROR');
    expect(await code(listLinks(env.db, editor, { unknown: '1' }))).toBe('VALIDATION_ERROR');
  });

  it('미분류 필터', async () => {
    const editor = await seed(1);
    expect((await listLinks(env.db, editor, { course_unassigned: 'true' })).data).toHaveLength(0);
    expect((await listLinks(env.db, editor, { course_id: courseA })).data).toHaveLength(1);
  });
});

describe('로그인 가능 판정 (§3.4, AC-06, AC-09, AC-13)', () => {
  const auth = { id: 'u', email: 'a@b.c', email_confirmed_at: '2026-01-01T00:00:00Z', banned_until: null, last_sign_in_at: null };
  it('규칙', () => {
    expect(evaluateAccess('error', { role: 'editor', status: 'active' })).toEqual({ canLogin: 'unknown', reason: 'auth_unavailable' });
    expect(evaluateAccess(null, { role: 'editor', status: 'active' }).reason).toBe('no_auth_account');
    expect(evaluateAccess({ ...auth, banned_until: '2999-01-01T00:00:00Z' }, { role: 'owner', status: 'active' }).reason).toBe('auth_banned');
    expect(evaluateAccess(auth, null).reason).toBe('not_member');
    expect(evaluateAccess(auth, { role: 'editor', status: 'invited' }).reason).toBe('invitation_pending');
    expect(evaluateAccess(auth, { role: 'editor', status: 'suspended' }).reason).toBe('suspended');
    expect(evaluateAccess({ ...auth, email_confirmed_at: null }, { role: 'editor', status: 'active' }).reason).toBe('email_unconfirmed');
    expect(evaluateAccess(auth, { role: 'viewer', status: 'active' }).canLogin).toBe('yes');
  });
});
