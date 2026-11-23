import { beforeEach, describe, expect, it } from 'vitest';
import { setupDb } from './helpers/db';
import { AppError } from '@/lib/errors';
import { createCourse, updateCourse, listCoursesForAdmin } from '@/lib/services/courses';
import { getTemplateForAdmin, saveTemplate } from '@/lib/services/template';
import { createBatch, parseBatchCreateBody } from '@/lib/services/links';
import type { UserPrincipal } from '@/lib/auth/principal';

type Env = Awaited<ReturnType<typeof setupDb>>;
let env: Env;
let owner: UserPrincipal;
let editor: UserPrincipal;
let n = 0;
const k = () => `admin-key-${++n}`;

async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e) { if (e instanceof AppError) return e.code; throw e; }
}

beforeEach(async () => {
  env = await setupDb();
  owner = await env.addUser('owner');
  editor = await env.addUser('editor');
});

describe('강의 관리 (AC-15, AC-16)', () => {
  it('owner 등록·수정·종료·재개, 감사 기록, 같은 이름 경고', async () => {
    const r = await createCourse(env.db, owner, { name: '김선아 강의', instructor_name: '김선아' }, k(), 'r');
    expect(r.status).toBe(201);
    const c = (r.body as { data: { id: string } }).data;
    const r2 = await createCourse(env.db, owner, { name: '김선아 강의' }, k(), 'r');
    expect((r2.body as { warnings: string[] }).warnings).toHaveLength(1);

    const closed = await updateCourse(env.db, owner, c.id, { status: 'closed' }, r.headers.ETag, k(), 'r');
    expect((closed.body as { data: { status: string; version: number } }).data).toMatchObject({ status: 'closed', version: 2 });
    // 옛 ETag 412
    expect(await code(updateCourse(env.db, owner, c.id, { status: 'active' }, r.headers.ETag, k(), 'r'))).toBe('PRECONDITION_FAILED');
    // 무변경은 버전 유지
    const same = await updateCourse(env.db, owner, c.id, { status: 'closed' }, closed.headers.ETag, k(), 'r');
    expect((same.body as { data: { version: number } }).data.version).toBe(2);

    const audits = await env.db.query<{ action: string }>(`select action from bzup.admin_audit_events where object_id = $1 order by created_at`, [c.id]);
    expect(audits.map((a) => a.action)).toEqual(['course_created', 'course_closed']);
    expect(await listCoursesForAdmin(env.db, owner.workspaceId)).toHaveLength(2);
  });

  it('editor 는 강의 원본 수정 불가', async () => {
    expect(await code(createCourse(env.db, editor, { name: 'x' }, k(), 'r'))).toBe('INSUFFICIENT_PERMISSION');
  });

  it('같은 요청 키 재시도는 재생', async () => {
    const key = k();
    const a = await createCourse(env.db, owner, { name: 'x' }, key, 'r');
    const b = await createCourse(env.db, owner, { name: 'x' }, key, 'r');
    expect(b.replayed).toBe(true);
    expect(b.body).toEqual(a.body);
    expect(await listCoursesForAdmin(env.db, owner.workspaceId)).toHaveLength(1);
  });
});

describe('자동생성 이름 목록 (AC-39~AC-42, AC-47)', () => {
  it('추가·재정렬·비활성화와 버전 관리', async () => {
    // 새 목록은 기본 항목(전환 주소 3개)으로 시작한다
    const t0 = await getTemplateForAdmin(env.db, owner);
    expect(t0.data.version).toBe(2);
    expect(t0.data.items[0]).toMatchObject({ name: '단톡방-라이브유튜브-앵콜줌', destination_slots: ['단톡방', '라이브 유튜브', '앵콜 줌'] });
    const s1 = await saveTemplate(env.db, owner, { items: [{ name: '무료 웨비나 신청' }, { name: '사전 안내 블로그' }, { name: '무료 웨비나 신청' }] }, t0.etag, k(), 'r');
    const d1all = (s1.body as { data: { version: number; items: { id: string; name: string; is_active: boolean }[] } }).data;
    const d1 = { ...d1all, items: d1all.items.filter((i) => i.is_active) };
    expect(d1.version).toBe(3);
    expect(d1.items.map((i) => i.name)).toEqual(['무료 웨비나 신청', '사전 안내 블로그', '무료 웨비나 신청']);

    // 무변경 저장은 버전 유지
    const same = await saveTemplate(env.db, owner, { items: d1.items.map((i) => ({ id: i.id, name: i.name })) }, s1.headers.ETag, k(), 'r');
    expect((same.body as { version_changed: boolean }).version_changed).toBe(false);

    // 재정렬 + 마지막 항목 비활성화(요청에서 제외)
    const [a, b] = d1.items;
    const s2 = await saveTemplate(env.db, owner, { items: [{ id: b.id, name: b.name }, { id: a.id, name: a.name }] }, s1.headers.ETag, k(), 'r');
    const d2 = (s2.body as { data: { version: number; items: { id: string; name: string; is_active: boolean }[] } }).data;
    expect(d2.version).toBe(4);
    expect(d2.items.filter((i) => i.is_active).map((i) => i.id)).toEqual([b.id, a.id]);
    expect(d2.items.filter((i) => !i.is_active)).toHaveLength(2);

    // 동시 편집: 옛 ETag 412
    expect(await code(saveTemplate(env.db, owner, { items: [] }, s1.headers.ETag, k(), 'r'))).toBe('PRECONDITION_FAILED');
    const revs = await env.db.query(`select version from bzup.generation_template_revisions order by version`);
    expect(revs).toHaveLength(3); // 기본 항목 추가 + 저장 2회
  });

  it('빈 목록 저장 가능·실행 불가, 101개 활성 거절', async () => {
    const t0 = await getTemplateForAdmin(env.db, owner);
    const s = await saveTemplate(env.db, owner, { items: [] }, t0.etag, k(), 'r');
    expect(s.status).toBe(200);
    const items = Array.from({ length: 101 }, (_, i) => ({ name: `이름 ${i}` }));
    expect(await code(saveTemplate(env.db, owner, { items }, s.headers.ETag, k(), 'r'))).toBe('VALIDATION_ERROR');
    const course = await env.addCourse('강의');
    expect(await code(createBatch(env.db, editor, parseBatchCreateBody({
      course_id: course, template_id: t0.data.id, template_version: (s.body as { data: { version: number } }).data.version,
      items: [{ template_item_id: crypto.randomUUID(), destination_url: 'https://a.com/' }],
    }), { idempotencyKey: k(), requestId: 'r', apiBase: '/internal' }))).toBe('TEMPLATE_EMPTY');
  });

  it('목록이 바뀌면 팝업 생성은 TEMPLATE_CHANGED', async () => {
    const t0 = await getTemplateForAdmin(env.db, owner);
    const s1 = await saveTemplate(env.db, owner, { items: [{ name: 'a' }] }, t0.etag, k(), 'r');
    const d1 = (s1.body as { data: { id: string; version: number; items: { id: string }[] } }).data;
    await saveTemplate(env.db, owner, { items: [{ id: d1.items[0].id, name: 'a 변경' }] }, s1.headers.ETag, k(), 'r');
    const course = await env.addCourse('강의');
    expect(await code(createBatch(env.db, editor, parseBatchCreateBody({
      course_id: course, template_id: d1.id, template_version: d1.version, items: [{ template_item_id: d1.items[0].id, destination_url: 'https://a.com/' }],
    }), { idempotencyKey: k(), requestId: 'r', apiBase: '/internal' }))).toBe('TEMPLATE_CHANGED');
  });

  it('editor 는 원본 목록 수정 불가', async () => {
    const t0 = await getTemplateForAdmin(env.db, owner);
    expect(await code(saveTemplate(env.db, editor, { items: [] }, t0.etag, k(), 'r'))).toBe('INSUFFICIENT_PERMISSION');
  });
});
