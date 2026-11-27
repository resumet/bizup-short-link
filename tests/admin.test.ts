import { beforeEach, describe, expect, it } from 'vitest';
import { setupDb } from './helpers/db';
import { AppError } from '@/lib/errors';
import { createCourse, importCourses, updateCourse, listCoursesForAdmin } from '@/lib/services/courses';
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

describe('강의 정보: 기수·웨비나 일정, 외부 강의 가져오기', () => {
  it('등록·수정에 기수·웨비나 일정 저장', async () => {
    const r = await createCourse(env.db, owner, { name: 'AI 수익화 클래스', instructor_name: '홍길동', cohort: '1', webinar_at: '2026-12-01T10:30:00+00:00' }, k(), 'r');
    const c = (r.body as { data: { id: string; cohort: string; webinar_at: string; source: string } }).data;
    expect(c).toMatchObject({ cohort: '1', webinar_at: '2026-12-01T10:30:00Z', source: 'manual' });
    const u = await updateCourse(env.db, owner, c.id, { cohort: '2', webinar_at: null }, r.headers.ETag, k(), 'r');
    expect((u.body as { data: object; changed_fields: string[] })).toMatchObject({ data: { cohort: '2', webinar_at: null }, changed_fields: ['cohort', 'webinar_at'] });
    expect(await code(createCourse(env.db, owner, { name: 'x', webinar_at: '어제' }, k(), 'r'))).toBe('VALIDATION_ERROR');
  });

  it('외부 UUID 를 id 로 추가, 이미 추가된 UUID 는 건너뜀', async () => {
    const A = crypto.randomUUID();
    const B = crypto.randomUUID();
    const item = (id: string, name: string) => ({ id, name, instructor_name: '홍길동', cohort: '1', webinar_at: '2026-12-01T10:30:00+00:00' });
    const r1 = await importCourses(env.db, owner, { courses: [item(A, 'A 강의')] }, k(), 'r');
    expect((r1.body as { data: object }).data).toEqual({ added: [A], skipped: [] });
    const r2 = await importCourses(env.db, owner, { courses: [item(A, 'A 강의 (이름 바뀜)'), item(B, 'B 강의')] }, k(), 'r');
    expect((r2.body as { data: object }).data).toEqual({ added: [B], skipped: [A] });
    const list = await listCoursesForAdmin(env.db, owner.workspaceId);
    expect(list).toHaveLength(2);
    expect(list.find((c) => c.id === A)).toMatchObject({ name: 'A 강의', source: 'dashboard', cohort: '1', status: 'active' });
    // 같은 요청 안 중복, editor 거절
    expect(await code(importCourses(env.db, owner, { courses: [item(A, 'a'), item(A, 'a')] }, k(), 'r'))).toBe('VALIDATION_ERROR');
    expect(await code(importCourses(env.db, editor, { courses: [item(crypto.randomUUID(), 'c')] }, k(), 'r'))).toBe('INSUFFICIENT_PERMISSION');
  });
});
