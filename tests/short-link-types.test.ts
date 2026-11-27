// 짧은 주소 유형(type_key) — docs/short-link-api-type-key-request.md §11 완료 기준
import { beforeEach, describe, expect, it } from 'vitest';
import { setupDb } from './helpers/db';
import { AppError } from '@/lib/errors';
import type { ApiPrincipal, UserPrincipal } from '@/lib/auth/principal';
import { createTypedShortLink, listShortLinkTypes } from '@/lib/services/short-links';
import { createLinkType, deleteLinkType, listLinkTypesForAdmin, updateLinkType } from '@/lib/services/link-types-admin';

type Env = Awaited<ReturnType<typeof setupDb>>;
let env: Env;
let owner: UserPrincipal;
let api: ApiPrincipal;
let courseA: string;
let courseB: string;
let n = 0;

const ctx = (key = crypto.randomUUID()) => ({ idempotencyKey: key, requestId: `r${++n}`, apiBase: '/api/v1' as const });
const body = (over: Record<string, unknown> = {}) => ({
  course_id: courseA, type_key: 'payment', destination_url: `https://pay.example.com/${++n}`, name: '결제페이지', ...over,
});
async function err(p: Promise<unknown>): Promise<AppError> {
  try { await p; } catch (e) { if (e instanceof AppError) return e; throw e; }
  throw new Error('expected error');
}

beforeEach(async () => {
  env = await setupDb();
  owner = await env.addUser('owner');
  api = (await env.addApiKey(owner, ['links:create'])).principal;
  courseA = await env.addCourse('A 강의');
  courseB = await env.addCourse('B 강의');
});

describe('유형 조회', () => {
  it('초기 유형 free_chat·landing·payment, key 오름차순, 숫자 필드 없음, 생성용 키로 조회 가능', async () => {
    const types = await listShortLinkTypes(env.db, api);
    expect(types).toEqual([
      { key: 'free_chat', label: '무료단톡방', active: true, slots: [
        { key: 'chat', label: '단톡방' }, { key: 'youtube', label: '유튜브 라이브' }, { key: 'zoom', label: '줌 라이브' },
      ] },
      { key: 'landing', label: '기본 랜딩 QR', active: true, slots: null },
      { key: 'payment', label: '결제페이지 QR', active: true, slots: null },
    ]);
  });

  it('key 는 변경·삭제 불가, label 변경과 비활성화는 가능', async () => {
    await expect(env.db.query(`update bzup.short_link_types set key = 'pay' where key = 'payment'`)).rejects.toThrow();
    await createTypedShortLink(env.db, api, body(), ctx());
    await expect(env.db.query(`delete from bzup.short_link_types where key = 'payment'`)).rejects.toThrow();
    await expect(env.db.query(`insert into bzup.short_link_types (key, label) values ('Bad', 'x')`)).rejects.toThrow();
    await env.db.query(`update bzup.short_link_types set label = '결제 QR', active = false where key = 'payment'`);
    expect((await listShortLinkTypes(env.db, api))[2]).toEqual({ key: 'payment', label: '결제 QR', active: false, slots: null });
  });
});

describe('발급', () => {
  it('두 유형 각각 발급, 응답에 type_key·type_label, 숫자 type 없음, 출처 api', async () => {
    const a = await createTypedShortLink(env.db, api, body({ type_key: 'landing' }), ctx());
    const b = await createTypedShortLink(env.db, api, body(), ctx());
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ type_key: 'landing', type_label: '기본 랜딩 QR', course_id: courseA });
    expect(b.body).toMatchObject({ type_key: 'payment', type_label: '결제페이지 QR' });
    expect(a.body).not.toHaveProperty('type');
    const [row] = await env.db.query<{ source: string }>(`select source from bzup.links where id = $1`, [a.body.link_id]);
    expect(row.source).toBe('api');
  });

  it('같은 강의·유형 재발급은 409 로 기존 주소, 이름·주소 덮어쓰지 않음, 다른 강의는 별도 발급', async () => {
    const first = await createTypedShortLink(env.db, api, body(), ctx());
    const e = await err(createTypedShortLink(env.db, api, body({ name: '다른 이름' }), ctx()));
    expect(e.code).toBe('LINK_TYPE_EXISTS');
    expect(e.status).toBe(409);
    expect(e.details).toMatchObject({
      course_id: courseA, type_key: 'payment', type_label: '결제페이지 QR',
      link_id: first.body.link_id, short_code: first.body.short_code, short_url: first.body.short_url,
    });
    const [row] = await env.db.query<{ name: string }>(`select name from bzup.links where id = $1`, [first.body.link_id]);
    expect(row.name).toBe('결제페이지');
    const other = await createTypedShortLink(env.db, api, body({ course_id: courseB }), ctx());
    expect(other.status).toBe(201);
  });

  it('동시 발급에도 같은 강의·유형 링크는 1개', async () => {
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => createTypedShortLink(env.db, api, body(), ctx())));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect(((r as PromiseRejectedResult).reason as AppError).code).toBe('LINK_TYPE_EXISTS');
    }
    const [c] = await env.db.query<{ n: number }>(`select count(*)::int as n from bzup.links where course_id = $1 and type_key = 'payment'`, [courseA]);
    expect(c.n).toBe(1);
  });

  it('구형 type 필드·잘못된 type_key 는 422 VALIDATION_ERROR, 미등록은 UNKNOWN_LINK_TYPE', async () => {
    const code = async (b: Record<string, unknown>) => (await err(createTypedShortLink(env.db, api, b, ctx()))).code;
    const { type_key: _omit, ...noKey } = body();
    void _omit;
    expect(await code({ ...noKey, type: '0001' })).toBe('VALIDATION_ERROR');
    expect(await code(body({ type: '0001' }))).toBe('VALIDATION_ERROR');
    expect(await code(noKey)).toBe('VALIDATION_ERROR');
    expect(await code(body({ type_key: '0001' }))).toBe('VALIDATION_ERROR');
    expect(await code(body({ type_key: 1 }))).toBe('VALIDATION_ERROR');
    expect(await code(body({ type_key: 'Payment' }))).toBe('VALIDATION_ERROR');
    expect(await code(body({ type_key: 'pay ment' }))).toBe('VALIDATION_ERROR');
    expect(await code(body({ type_key: 'a'.repeat(65) }))).toBe('VALIDATION_ERROR');
    expect(await code(body({ extra: 1 }))).toBe('VALIDATION_ERROR');
    expect(await code(body({ type_key: 'coupon' }))).toBe('UNKNOWN_LINK_TYPE');
  });

  it('비활성 유형: 기존 링크가 있으면 409, 없으면 422 LINK_TYPE_INACTIVE', async () => {
    const first = await createTypedShortLink(env.db, api, body(), ctx());
    await env.db.query(`update bzup.short_link_types set active = false where key = 'payment'`);
    const e = await err(createTypedShortLink(env.db, api, body(), ctx()));
    expect(e.code).toBe('LINK_TYPE_EXISTS');
    expect((e.details as { short_url: string }).short_url).toBe(first.body.short_url);
    expect((await err(createTypedShortLink(env.db, api, body({ course_id: courseB }), ctx()))).code).toBe('LINK_TYPE_INACTIVE');
  });

  it('강의 검증·이름·주소 검증·권한', async () => {
    const closed = await env.addCourse('종료 강의', 'closed');
    const code = async (b: Record<string, unknown>, p = api) => (await err(createTypedShortLink(env.db, p, b, ctx()))).code;
    expect(await code(body({ course_id: undefined }))).toBe('COURSE_REQUIRED');
    expect(await code(body({ course_id: crypto.randomUUID() }))).toBe('COURSE_REQUIRED');
    expect(await code(body({ course_id: closed }))).toBe('COURSE_NOT_ACTIVE');
    expect(await code(body({ name: '   ' }))).toBe('VALIDATION_ERROR');
    expect(await code(body({ destination_url: 'ftp://x.com/' }))).toBe('VALIDATION_ERROR');
    expect(await code(body({ destination_url: 'https://user:pw@x.com/' }))).toBe('VALIDATION_ERROR');
    const readOnly = (await env.addApiKey(owner, ['links:read'])).principal;
    expect(await code(body(), readOnly)).toBe('INSUFFICIENT_SCOPE');
  });
});

describe('멱등성', () => {
  it('같은 키·같은 본문 재시도는 원래 201 응답 재사용, 다른 본문은 IDEMPOTENCY_KEY_REUSED', async () => {
    const key = crypto.randomUUID();
    const b = body();
    const first = await createTypedShortLink(env.db, api, b, ctx(key), true);
    const again = await createTypedShortLink(env.db, api, b, ctx(key), true);
    expect(again.status).toBe(201);
    expect(again.body.link_id).toBe(first.body.link_id);
    const e = await err(createTypedShortLink(env.db, api, { ...b, name: '바뀐 이름' }, ctx(key), true));
    expect(e.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const [c] = await env.db.query<{ n: number }>(`select count(*)::int as n from bzup.links`);
    expect(c.n).toBe(1);
    // 키 없이 다시 보내면 409 로 기존 링크
    expect((await err(createTypedShortLink(env.db, api, b, ctx()))).code).toBe('LINK_TYPE_EXISTS');
  });
});

describe('유형 관리 (최고관리자)', () => {
  it('추가·이름 수정·비활성화, 쓰인 유형은 제거 불가, 안 쓰인 유형은 제거', async () => {
    const k = () => crypto.randomUUID();
    const c = await createLinkType(env.db, owner, { key: 'replay', label: '다시보기 QR' }, k(), 'r');
    expect(c.status).toBe(201);
    expect((await err(createLinkType(env.db, owner, { key: 'replay', label: 'x' }, k(), 'r'))).code).toBe('CONFLICT');
    expect((await err(createLinkType(env.db, owner, { key: 'Bad', label: 'x' }, k(), 'r'))).code).toBe('VALIDATION_ERROR');
    await updateLinkType(env.db, owner, 'replay', { label: '다시보기', active: false }, k(), 'r');
    expect((await listLinkTypesForAdmin(env.db)).find((t) => t.key === 'replay')).toMatchObject({ label: '다시보기', active: false, used: false });

    await createTypedShortLink(env.db, api, body({ type_key: 'landing' }), ctx());
    expect((await err(deleteLinkType(env.db, owner, 'landing', k(), 'r'))).code).toBe('CONFLICT');
    await deleteLinkType(env.db, owner, 'replay', k(), 'r');
    expect((await listLinkTypesForAdmin(env.db)).map((t) => t.key)).toEqual(['free_chat', 'landing', 'payment']);

    const editor = await env.addUser('editor');
    expect((await err(createLinkType(env.db, editor, { key: 'x', label: 'x' }, k(), 'r'))).code).toBe('INSUFFICIENT_PERMISSION');
  });
});
