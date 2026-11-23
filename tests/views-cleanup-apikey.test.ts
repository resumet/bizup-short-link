import { beforeEach, describe, expect, it } from 'vitest';
import { setupDb } from './helpers/db';
import { AppError } from '@/lib/errors';
import { createSingleLink, parseSingleCreateBody } from '@/lib/services/links';
import { listLinks } from '@/lib/services/link-query';
import { getDailyViews, recordView } from '@/lib/services/views';
import { cleanupExpired } from '@/lib/services/cleanup';
import { getSystemApiStatus, issueSystemKey, revokeSystemKey, updateSystemClient } from '@/lib/services/system-api-key';
import { authenticateApiKey } from '@/lib/auth/api-key';
import type { UserPrincipal } from '@/lib/auth/principal';

type Env = Awaited<ReturnType<typeof setupDb>>;
let env: Env;
let owner: UserPrincipal;
let editor: UserPrincipal;
let course: string;
let n = 0;
const k = () => `vca-key-${Date.now()}-${++n}`;

async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e) { if (e instanceof AppError) return e.code; throw e; }
}

async function makeLink(name = '링크') {
  const r = await createSingleLink(env.db, editor, parseSingleCreateBody({
    course_id: course, name, destination_url: `https://example.com/${name}-${++n}`,
  }), { idempotencyKey: k(), requestId: 'r', apiBase: '/internal' });
  return (r.body as { data: { id: string } }).data.id;
}

beforeEach(async () => {
  env = await setupDb();
  owner = await env.addUser('owner');
  editor = await env.addUser('editor');
  course = await env.addCourse('강의');
  process.env.BZUP_KEY_ENV = 'live';
});

describe('조회수', () => {
  it('일자별·총계를 누적하고 목록에 총조회수를 보여준다', async () => {
    const a = await makeLink('a');
    const b = await makeLink('b');
    for (let i = 0; i < 3; i++) await recordView(env.db, a);
    await recordView(env.db, b);
    // 어제 기록 1건을 직접 넣어 일자 분리를 확인
    await env.db.query(
      `insert into bzup.link_daily_views (link_id, view_date, views) values ($1, (now() at time zone 'Asia/Seoul')::date - 1, 5)`, [a],
    );
    const v = await getDailyViews(env.db, editor, a, 7);
    expect(v.daily).toHaveLength(7);
    expect(v.daily[6].views).toBe(3);
    expect(v.daily[5].views).toBe(5);
    expect(v.total_views).toBe(3); // 총계는 실제 이동 기록만 누적
    const list = await listLinks(env.db, editor, {});
    const byId = Object.fromEntries(list.data.map((l) => [l.id, l.total_views]));
    expect(byId[a]).toBe(3);
    expect(byId[b]).toBe(1);
  });

  it('조회 기록이 없는 링크는 0', async () => {
    const a = await makeLink('none');
    expect((await getDailyViews(env.db, editor, a, 30)).total_views).toBe(0);
    expect((await listLinks(env.db, editor, {})).data[0].total_views).toBe(0);
  });

  it('다른 회사·없는 링크는 NOT_FOUND', async () => {
    expect(await code(getDailyViews(env.db, editor, crypto.randomUUID(), 30))).toBe('NOT_FOUND');
  });
});

describe('만료 기록 정리', () => {
  it('만료된 재시도 기록·검토 토큰·호출 카운터만 지운다', async () => {
    await makeLink('x');
    await env.db.query(`update bzup.idempotency_records set expires_at = now() - interval '1 minute'`);
    await makeLink('y'); // 아직 유효한 기록 1건
    await env.db.query(
      `insert into bzup.generation_reviews (token_hash, workspace_id, principal_type, principal_id, mode, normalized_input_hash,
         resolved_course_id, existing_duplicate_digest, expires_at, created_at)
       values ('\\x01', $1, 'user', $2, 'single', '\\x01', $3, '\\x01', now() - interval '25 hours', now() - interval '25 hours'),
              ('\\x02', $1, 'user', $2, 'single', '\\x01', $3, '\\x01', now() + interval '5 minutes', now())`,
      [env.workspaceId, editor.userId, course],
    );
    await env.db.query(`insert into bzup.rate_windows (bucket, window_start, count) values ('old', now() - interval '2 hours', 1)`);
    const r = await cleanupExpired(env.db, { batch: 1 });
    expect(r).toMatchObject({ idempotency_deleted: 1, reviews_deleted: 1, rate_windows_deleted: 1, finished: true });
    expect((await env.db.query(`select count(*)::int as n from bzup.idempotency_records`))[0]).toEqual({ n: 1 });
    expect((await env.db.query(`select count(*)::int as n from bzup.generation_reviews`))[0]).toEqual({ n: 1 });
    expect((await env.db.query(`select count(*)::int as n from bzup.links`))[0]).toEqual({ n: 2 });
  });
});

describe('시스템 API 키', () => {
  it('발급: 원문 1회, 해시만 저장, 같은 요청 재시도는 원문 없이 같은 키', async () => {
    const key = k();
    const r = await issueSystemKey(env.db, owner, { expires_in_days: 90 }, key, 'r');
    expect(r.status).toBe(201);
    const d = (r.body as { data: { api_key: string; key_id: string; scopes: string[] } }).data;
    expect(d.api_key).toMatch(/^bzup_live_/);
    expect(d.scopes).toEqual(['links:create', 'links:read', 'links:update', 'courses:read']);
    const p = await authenticateApiKey(env.db, `Bearer ${d.api_key}`);
    expect(p.apiKeyId).toBe(d.key_id);

    const again = await issueSystemKey(env.db, owner, { expires_in_days: 90 }, key, 'r');
    expect(again.status).toBe(200);
    expect(JSON.stringify(again.body)).not.toContain(d.api_key);
    expect((again.body as { code: string; data: { key_id: string } })).toMatchObject({ code: 'KEY_ALREADY_CREATED', data: { key_id: d.key_id } });
    expect(await code(issueSystemKey(env.db, owner, { expires_in_days: 30 }, key, 'r'))).toBe('IDEMPOTENCY_KEY_REUSED');

    const stored = await env.db.query<{ n: number }>(`select count(*)::int as n from bzup.api_keys`);
    expect(stored[0].n).toBe(1);
    const audit = await env.db.query<{ after_data: unknown }>(`select after_data from bzup.admin_audit_events where action = 'api_key_issued'`);
    expect(JSON.stringify(audit)).not.toContain(d.api_key);
  });

  it('유효기간 범위·무기한 거절', async () => {
    for (const bad of [0, 366, null, 1.5]) {
      expect(await code(issueSystemKey(env.db, owner, { expires_in_days: bad }, k(), 'r'))).toBe('INVALID_EXPIRATION');
    }
  });

  it('재발급: 즉시 폐기 또는 병행 기간', async () => {
    const first = (await issueSystemKey(env.db, owner, {}, k(), 'r')).body as { data: { api_key: string; key_id: string } };
    // 24시간 병행
    const second = (await issueSystemKey(env.db, owner, { overlap_hours: 24 }, k(), 'r')).body as { data: { api_key: string } };
    expect((await authenticateApiKey(env.db, `Bearer ${first.data.api_key}`)).apiKeyId).toBe(first.data.key_id);
    const s = await getSystemApiStatus(env.db, owner);
    expect(s.keys.map((x) => x.effective_status).sort()).toEqual(['active', 'rotating']);
    // 즉시 폐기 재발급 → 이전 두 키 모두 사용 불가
    const third = (await issueSystemKey(env.db, owner, { overlap_hours: 0 }, k(), 'r')).body as { data: { api_key: string } };
    expect(await code(authenticateApiKey(env.db, `Bearer ${first.data.api_key}`))).toBe('INVALID_API_KEY');
    expect(await code(authenticateApiKey(env.db, `Bearer ${second.data.api_key}`))).toBe('INVALID_API_KEY');
    expect(await code(authenticateApiKey(env.db, `Bearer ${third.data.api_key}`))).toBe('OK');
  });

  it('폐기: 영구, 해시 제거, 반복 204, 링크 보존', async () => {
    const d = ((await issueSystemKey(env.db, owner, {}, k(), 'r')).body as { data: { api_key: string; key_id: string } }).data;
    const api = await authenticateApiKey(env.db, `Bearer ${d.api_key}`);
    await createSingleLink(env.db, api, parseSingleCreateBody({ course_id: course, name: 'api', destination_url: 'https://api.example.com/' }),
      { idempotencyKey: k(), requestId: 'r', apiBase: '/api/v1' });
    expect(await code(revokeSystemKey(env.db, owner, d.key_id, {}, k(), 'r'))).toBe('VALIDATION_ERROR');
    const r = await revokeSystemKey(env.db, owner, d.key_id, { reason: '연동 종료' }, k(), 'r');
    expect(r.status).toBe(204);
    expect((await revokeSystemKey(env.db, owner, d.key_id, { reason: '다시' }, k(), 'r')).status).toBe(204);
    expect(await code(authenticateApiKey(env.db, `Bearer ${d.api_key}`))).toBe('INVALID_API_KEY');
    const [row] = await env.db.query<{ secret_hash: unknown; deleted_at: unknown }>(`select secret_hash, deleted_at from bzup.api_keys where id = $1`, [d.key_id]);
    expect(row.secret_hash).toBeNull();
    expect(row.deleted_at).not.toBeNull();
    expect((await env.db.query(`select count(*)::int as n from bzup.links where source = 'api'`))[0]).toEqual({ n: 1 });
  });

  it('기본 강의 설정과 권한', async () => {
    await issueSystemKey(env.db, owner, {}, k(), 'r');
    const s = await getSystemApiStatus(env.db, owner);
    const r = await updateSystemClient(env.db, owner, { default_course_id: course }, s.etag!, k(), 'r');
    expect((r.body as { data: { default_course_id: string } }).data.default_course_id).toBe(course);
    expect(await code(updateSystemClient(env.db, owner, { default_course_id: null }, s.etag!, k(), 'r'))).toBe('PRECONDITION_FAILED');
    expect(await code(issueSystemKey(env.db, editor, {}, k(), 'r'))).toBe('INSUFFICIENT_PERMISSION');
    expect(await code(getSystemApiStatus(env.db, editor))).toBe('INSUFFICIENT_PERMISSION');
  });
});
