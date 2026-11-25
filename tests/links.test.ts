import { beforeEach, describe, expect, it } from 'vitest';
import { setupDb, HOST } from './helpers/db';
import { AppError } from '@/lib/errors';
import {
  createBatch, createSingleLink, deleteLink, getLink, getLinkRevisions, parseBatchCreateBody, parsePatchBody,
  parseSingleCreateBody, patchLink, preflight,
} from '@/lib/services/links';
import type { Principal, UserPrincipal } from '@/lib/auth/principal';

type Env = Awaited<ReturnType<typeof setupDb>>;
let env: Env;
let editor: UserPrincipal;
let owner: UserPrincipal;
let courseA: string;
let courseB: string;
let n = 0;
const key = () => `test-key-${Date.now()}-${++n}`;
const ctx = (k = key()) => ({ idempotencyKey: k, requestId: `req-${n}`, apiBase: '/internal' as const });

async function err(p: Promise<unknown>): Promise<AppError> {
  try { await p; } catch (e) { if (e instanceof AppError) return e; throw e; }
  throw new Error('expected AppError');
}

async function create(p: Principal, body: Record<string, unknown>, k?: string) {
  return createSingleLink(env.db, p, parseSingleCreateBody(body), ctx(k));
}

beforeEach(async () => {
  env = await setupDb();
  owner = await env.addUser('owner');
  editor = await env.addUser('editor', '김직원');
  courseA = await env.addCourse('김선아 강의');
  courseB = await env.addCourse('신민철 강의');
});

describe('단건 생성 (AC-22, AC-17, AC-18)', () => {
  it('링크와 최초 이력을 저장한다', async () => {
    const r = await create(editor, { course_id: courseA, name: '웨비나', destination_url: 'https://bizupclass.com/w?utm_source=sms' });
    expect(r.status).toBe(201);
    const data = (r.body as { data: Record<string, unknown> }).data;
    expect(data.short_code).toMatch(/^[0-9A-Za-z]{7}$/);
    expect(data.short_url).toBe(`https://${HOST}/${data.short_code}`);
    expect(data.issued_short_url).toBe(data.short_url);
    expect(data.source).toBe('web');
    expect(r.headers.ETag).toBe(`"link-${data.id}-v1-u1"`);
    const revs = await getLinkRevisions(env.db, editor, data.id as string);
    expect(revs).toHaveLength(1);
    expect(revs[0].action).toBe('created');
    expect(env.ledger.reserved.size).toBe(1);
  });

  it('강의 없음 422 COURSE_REQUIRED, 종료 강의 COURSE_NOT_ACTIVE', async () => {
    expect((await err(create(editor, { name: 'x', destination_url: 'https://a.com/' }))).code).toBe('COURSE_REQUIRED');
    const closed = await env.addCourse('종료', 'closed');
    expect((await err(create(editor, { course_id: closed, name: 'x', destination_url: 'https://a.com/' }))).code).toBe('COURSE_NOT_ACTIVE');
    const c = await env.db.query<{ n: number }>(`select count(*)::int as n from bzup.links`);
    expect(c[0].n).toBe(0);
  });

  it('viewer는 생성 불가', async () => {
    const viewer = await env.addUser('viewer');
    expect((await err(create(viewer, { course_id: courseA, name: 'x', destination_url: 'https://a.com/' }))).code).toBe('INSUFFICIENT_PERMISSION');
  });

  it('접근 중지된 직원은 잠금 후 재검사에서 거절', async () => {
    await env.db.query(`update bzup.workspace_members set status = 'suspended' where id = $1`, [editor.memberId]);
    expect((await err(create(editor, { course_id: courseA, name: 'x', destination_url: 'https://a.com/' }))).code).toBe('ACCESS_SUSPENDED');
  });

  it('허용되지 않은 필드 422', async () => {
    expect((await err(create(editor, { course_id: courseA, name: 'x', destination_url: 'https://a.com/', workspace_id: 'x' }))).code)
      .toBe('VALIDATION_ERROR');
  });

  it('서비스 자체 호스트 목적지는 FORBIDDEN_DESTINATION', async () => {
    expect((await err(create(editor, { course_id: courseA, name: 'x', destination_url: `https://${HOST}/abc` }))).code)
      .toBe('FORBIDDEN_DESTINATION');
  });

  it('원장 장애 시 503, 링크 0건 (AC-54)', async () => {
    env.ledger.failing = true;
    expect((await err(create(editor, { course_id: courseA, name: 'x', destination_url: 'https://a.com/' }))).code).toBe('SERVICE_UNAVAILABLE');
    expect((await env.db.query<{ n: number }>(`select count(*)::int as n from bzup.links`))[0].n).toBe(0);
  });
});

describe('멱등성 (AC-52, AC-78, AC-79)', () => {
  it('같은 키·같은 본문은 최초 응답 재생, 다른 본문은 409', async () => {
    const body = { course_id: courseA, name: 'x', destination_url: 'https://a.com/' };
    const k = key();
    const a = await create(editor, body, k);
    const b = await create(editor, body, k);
    expect(b.replayed).toBe(true);
    expect(b.body).toEqual(a.body);
    expect(b.headers).toEqual(a.headers);
    expect((await env.db.query<{ n: number }>(`select count(*)::int as n from bzup.links`))[0].n).toBe(1);
    expect((await err(create(editor, { ...body, name: 'y' }, k))).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('성공 후 강의가 종료되어도 같은 요청은 재생', async () => {
    const body = { course_id: courseA, name: 'x', destination_url: 'https://a.com/' };
    const k = key();
    const a = await create(editor, body, k);
    await env.db.query(`update bzup.courses set status='closed' where id=$1`, [courseA]);
    const b = await create(editor, body, k);
    expect(b.body).toEqual(a.body);
  });

  it('동시에 같은 키로 요청해도 한 번만 저장', async () => {
    const body = { course_id: courseA, name: 'x', destination_url: 'https://a.com/' };
    const k = key();
    const rs = await Promise.all([create(editor, body, k), create(editor, body, k), create(editor, body, k)]);
    expect(new Set(rs.map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect((await env.db.query<{ n: number }>(`select count(*)::int as n from bzup.links`))[0].n).toBe(1);
  });
});

describe('같은 목적지 재생성 확인 (AC-26~AC-38)', () => {
  const url = 'https://bizupclass.com/webinar/kim?utm_source=sms';

  it('다른 강의·비활성 링크도 중복으로 보고, 확인 후 새로 만든다', async () => {
    await create(editor, { course_id: courseA, name: '기존', destination_url: url });
    const e = await err(create(editor, { course_id: courseB, name: '새것', destination_url: 'https://BIZUPCLASS.com:443/webinar/kim?utm_source=sms' }));
    expect(e.code).toBe('DUPLICATE_DESTINATION');
    const d = e.details as { review_token: string; duplicate_groups: { existing_count: number; existing_links: { name: string }[] }[] };
    expect(d.duplicate_groups[0].existing_count).toBe(1);
    expect(d.duplicate_groups[0].existing_links[0].name).toBe('기존');

    const body = { course_id: courseB, name: '새것', destination_url: 'https://BIZUPCLASS.com:443/webinar/kim?utm_source=sms',
      review_token: d.review_token, duplicate_decision: 'create_new' };
    const ok = await create(editor, body);
    expect(ok.status).toBe(201);
    // 같은 토큰을 다른 요청 키로 재사용하면 거절
    expect((await err(create(editor, body))).code).toBe('REVIEW_ALREADY_USED');
  });

  it('UTM이 다르면 중복이 아니다, 이름만 같아도 중복이 아니다', async () => {
    await create(editor, { course_id: courseA, name: '같은이름', destination_url: url });
    const r = await create(editor, { course_id: courseA, name: '같은이름', destination_url: url.replace('sms', 'blog') });
    expect(r.status).toBe(201);
  });

  it('최초 URL만 같고 현재 URL이 다르면 중복 아님 (AC-28)', async () => {
    const a = await create(editor, { course_id: courseA, name: 'a', destination_url: url });
    const data = (a.body as { data: { id: string } }).data;
    await patchLink(env.db, editor, data.id, parsePatchBody({ destination_url: 'https://other.com/' }), a.headers.ETag, ctx());
    const r = await create(editor, { course_id: courseA, name: 'b', destination_url: url });
    expect(r.status).toBe(201);
  });

  it('확인 이후 중복 집합이 바뀌면 DUPLICATE_REVIEW_CHANGED (AC-35)', async () => {
    await create(editor, { course_id: courseA, name: '기존', destination_url: url });
    const pf = await preflight(env.db, editor, { mode: 'single', course_id: courseB, name: '새것', destination_url: url });
    expect(pf.requires_confirmation).toBe(true);
    // 다른 사용자가 같은 목적지로 링크를 추가
    const other = await create(owner, { course_id: courseA, name: '경쟁', destination_url: url }).catch(async (e: AppError) => {
      const d = e.details as { review_token: string };
      return create(owner, { course_id: courseA, name: '경쟁', destination_url: url, review_token: d.review_token, duplicate_decision: 'create_new' });
    });
    expect(other.status).toBe(201);
    const e = await err(create(editor, { course_id: courseB, name: '새것', destination_url: url, review_token: pf.review_token, duplicate_decision: 'create_new' }));
    expect(e.code).toBe('DUPLICATE_REVIEW_CHANGED');
    expect((e.details as { review_token: string }).review_token).toBeTruthy();
  });

  it('확인 후 입력·강의·주체가 바뀌면 토큰 거절 (AC-36)', async () => {
    await create(editor, { course_id: courseA, name: '기존', destination_url: url });
    const pf = await preflight(env.db, editor, { mode: 'single', course_id: courseB, name: '새것', destination_url: url });
    const t = { review_token: pf.review_token, duplicate_decision: 'create_new' };
    expect((await err(create(editor, { course_id: courseB, name: '바뀐이름', destination_url: url, ...t }))).code).toBe('REVIEW_MISMATCH');
    expect((await err(create(editor, { course_id: courseA, name: '새것', destination_url: url, ...t }))).code).toBe('REVIEW_MISMATCH');
    expect((await err(create(owner, { course_id: courseB, name: '새것', destination_url: url, ...t }))).code).toBe('REVIEW_MISMATCH');
  });

  it('read 없는 create 키에는 기존 링크 정보를 노출하지 않는다 (AC-38)', async () => {
    await create(editor, { course_id: courseA, name: '비공개 이름', destination_url: url });
    const { principal } = await env.addApiKey(owner, ['links:create']);
    const e = await err(create(principal, { course_id: courseA, name: 'api', destination_url: url }));
    expect(e.code).toBe('DUPLICATE_DESTINATION');
    const g = (e.details as { duplicate_groups: Record<string, unknown>[] }).duplicate_groups[0];
    expect(g.existing_count).toBe(1);
    expect(g.existing_links).toBeUndefined();
    expect(JSON.stringify(e.details)).not.toContain('비공개 이름');
  });

  it('API 는 course_id(강의 UUID) 필수, 지정한 강의로 생성', async () => {
    const { principal } = await env.addApiKey(owner, ['links:create']);
    const e = await err(create(principal, { name: 'api', destination_url: 'https://api.example.com/' }));
    expect(e.code).toBe('COURSE_REQUIRED');
    const r = await create(principal, { course_id: courseB, name: 'api', destination_url: 'https://api.example.com/' });
    expect((r.body as { data: { course_id: string; source: string } }).data).toMatchObject({ course_id: courseB, source: 'api' });
  });

  it('폐기된 키는 잠금 후 재검사에서 거절 (AC-121)', async () => {
    const { principal, keyId } = await env.addApiKey(owner, ['links:create']);
    await env.db.query(`update bzup.api_keys set scheduled_revoke_at = now() - interval '1 second' where id = $1`, [keyId]);
    expect((await err(create(principal, { course_id: courseB, name: 'api', destination_url: 'https://api.example.com/' }))).code).toBe('INVALID_API_KEY');
  });
});

describe('수정·이력 (AC-57~AC-60, AC-20)', () => {
  async function seed() {
    const r = await create(editor, { course_id: courseA, name: 'a', destination_url: 'https://a.com/' });
    return { id: (r.body as { data: { id: string } }).data.id, etag: r.headers.ETag };
  }

  it('목적지 변경 시 코드 유지, 버전·이력 증가', async () => {
    const { id, etag } = await seed();
    const r = await patchLink(env.db, editor, id, parsePatchBody({ destination_url: 'https://b.com/', change_reason: '교체' }), etag, ctx());
    const data = (r.body as { data: { version: number; destination_url: string; initial_destination_url: string } }).data;
    expect(data).toMatchObject({ version: 2, destination_url: 'https://b.com/', initial_destination_url: 'https://a.com/' });
    expect(r.headers.ETag).toBe(`"link-${id}-v2-u1"`);
    const revs = await getLinkRevisions(env.db, editor, id);
    expect(revs[0]).toMatchObject({ version: 2, action: 'updated', changed_fields: ['destination_url'], reason: '교체' });
  });

  it('오래된 ETag는 412, 무변경은 버전 유지', async () => {
    const { id, etag } = await seed();
    const same = await patchLink(env.db, editor, id, parsePatchBody({ name: 'a' }), etag, ctx());
    expect((same.body as { data: { version: number } }).data.version).toBe(1);
    expect((await getLinkRevisions(env.db, editor, id))).toHaveLength(1);
    await patchLink(env.db, editor, id, parsePatchBody({ name: 'b' }), etag, ctx());
    expect((await err(patchLink(env.db, editor, id, parsePatchBody({ name: 'c' }), etag, ctx()))).code).toBe('PRECONDITION_FAILED');
  });

  it('강의 재분류는 진행중 강의만, 이력에 강의명 스냅샷', async () => {
    const { id, etag } = await seed();
    const closed = await env.addCourse('종료', 'closed');
    expect((await err(patchLink(env.db, editor, id, parsePatchBody({ course_id: closed }), etag, ctx()))).code).toBe('COURSE_NOT_ACTIVE');
    await patchLink(env.db, editor, id, parsePatchBody({ course_id: courseB }), etag, ctx());
    const revs = await getLinkRevisions(env.db, editor, id);
    expect(revs[0].before).toMatchObject({ course_name_snapshot: '김선아 강의' });
    expect(revs[0].after).toMatchObject({ course_name_snapshot: '신민철 강의' });
  });

  it('불변 필드·null 지우기는 422', () => {
    expect(() => parsePatchBody({ short_code: 'abcdefg' })).toThrow(AppError);
    expect(() => parsePatchBody({ course_id: null })).toThrow(AppError);
    expect(() => parsePatchBody({})).toThrow(AppError);
  });

  it('도메인 전환 후 옛 ETag는 412, 링크 version 불변 (AC-89)', async () => {
    const { id, etag } = await seed();
    await env.db.query(`update bzup.service_settings set url_config_version = url_config_version + 1`);
    const cur = await getLink(env.db, editor, id);
    expect(cur.etag).toBe(`"link-${id}-v1-u2"`);
    const e = await err(patchLink(env.db, editor, id, parsePatchBody({ name: 'z' }), etag, ctx()));
    expect(e.code).toBe('PRECONDITION_FAILED');
    expect(e.message).toContain('서비스 주소 설정');
  });

  it('DB가 short_code 변경을 거절한다', async () => {
    const { id } = await seed();
    await expect(env.db.query(`update bzup.links set short_code = 'zzzzzzz' where id = $1`, [id])).rejects.toThrow();
    await expect(env.db.query(`delete from bzup.link_revisions`)).rejects.toThrow();
  });
});

describe('자동생성 일괄 생성 (AC-44~AC-52)', () => {
  it('모든 활성 행을 같은 강의로 생성하고 결과를 반환', async () => {
    const t = await env.addTemplate(['무료 웨비나 신청', '사전 안내 블로그', '라이브 입장']);
    const body = {
      course_id: courseA, template_id: t.id, template_version: 1,
      items: t.items.map((it, i) => ({ template_item_id: it.id, destination_url: `https://bizupclass.com/p${i}` })),
    };
    const r = await createBatch(env.db, editor, parseBatchCreateBody(body), ctx());
    const data = (r.body as { data: { total_count: number; results: { name: string }[] } }).data;
    expect(data.total_count).toBe(3);
    expect(data.results.map((x) => x.name)).toEqual(['무료 웨비나 신청', '사전 안내 블로그', '라이브 입장']);
    const rows = await env.db.query<{ course_id: string; creation_mode: string }>(`select course_id, creation_mode from bzup.links`);
    expect(rows.every((x) => x.course_id === courseA && x.creation_mode === 'batch')).toBe(true);
  });

  it('한 행 오류면 0건, 행별 오류 표시', async () => {
    const t = await env.addTemplate(['a', 'b']);
    const body = {
      course_id: courseA, template_id: t.id, template_version: 1,
      items: [{ template_item_id: t.items[0].id, destination_url: 'https://ok.com/' }, { template_item_id: t.items[1].id, destination_url: 'nope' }],
    };
    const e = (() => { try { parseBatchCreateBody(body); } catch (x) { return x as AppError; } })()!;
    expect(e.code).toBe('VALIDATION_ERROR');
    expect(e.rowErrors?.[0]).toMatchObject({ template_item_id: t.items[1].id, field: 'destination_url' });
  });

  it('누락·추가 항목은 TEMPLATE_ITEMS_MISMATCH, 버전 불일치는 TEMPLATE_CHANGED', async () => {
    const t = await env.addTemplate(['a', 'b']);
    const base = { course_id: courseA, template_id: t.id, template_version: 1 };
    const one = [{ template_item_id: t.items[0].id, destination_url: 'https://ok.com/' }];
    expect((await err(createBatch(env.db, editor, parseBatchCreateBody({ ...base, items: one }), ctx()))).code).toBe('TEMPLATE_ITEMS_MISMATCH');
    const both = t.items.map((it) => ({ template_item_id: it.id, destination_url: `https://ok.com/${it.name}` }));
    expect((await err(createBatch(env.db, editor, parseBatchCreateBody({ ...base, template_version: 2, items: both }), ctx()))).code).toBe('TEMPLATE_CHANGED');
  });

  it('입력 행끼리 같은 URL이면 확인 후 각각 생성 (AC-45, AC-46)', async () => {
    const t = await env.addTemplate(['a', 'b']);
    const body = {
      course_id: courseA, template_id: t.id, template_version: 1,
      items: t.items.map((it) => ({ template_item_id: it.id, destination_url: 'https://same.com/' })),
    };
    const e = await err(createBatch(env.db, editor, parseBatchCreateBody(body), ctx()));
    expect(e.code).toBe('DUPLICATE_DESTINATION');
    const d = e.details as { review_token: string; duplicate_kind: string };
    expect(d.duplicate_kind).toBe('internal');
    const r = await createBatch(env.db, editor, parseBatchCreateBody({ ...body, review_token: d.review_token, duplicate_decision: 'create_new' }), ctx());
    expect((r.body as { data: { total_count: number } }).data.total_count).toBe(2);
  });

  it('마지막 행 저장 실패 시 전체 롤백 (AC-50)', async () => {
    const t = await env.addTemplate(['a', 'b', 'c']);
    await env.db.query(`insert into bzup.links (workspace_id, issued_domain, short_code, name, initial_destination_url, destination_url,
      canonical_destination, destination_fingerprint, course_id, external_ref, status, source, creation_mode, created_by_type, updated_by_type)
      values ($1,'h','AAAAAAA','x','https://x.com/','https://x.com/','https://x.com/', '\\x00', $2, 'dup-ref','active','web','single','system','system')`,
      [env.workspaceId, courseA]);
    const body = {
      course_id: courseA, template_id: t.id, template_version: 1,
      items: t.items.map((it, i) => ({ template_item_id: it.id, destination_url: `https://p.com/${i}`, ...(i === 2 ? { external_ref: 'dup-ref' } : {}) })),
    };
    expect((await err(createBatch(env.db, editor, parseBatchCreateBody(body), ctx()))).code).toBe('EXTERNAL_REF_EXISTS');
    expect((await env.db.query<{ n: number }>(`select count(*)::int as n from bzup.links`))[0].n).toBe(1);
    expect((await env.db.query<{ n: number }>(`select count(*)::int as n from bzup.generation_batches`))[0].n).toBe(0);
  });
});


describe('링크 삭제 (위험 구역)', () => {
  it('명칭이 같아야 삭제, 삭제 후 조회·목록·이동 제외, type 재사용 가능', async () => {
    const { principal } = await env.addApiKey(owner, ['links:create']);
    const mk = (url: string) => createSingleLink(env.db, principal,
      { ...parseSingleCreateBody({ course_id: courseA, name: '삭제할 링크', destination_url: url }), linkType: 'landing' },
      { idempotencyKey: crypto.randomUUID(), requestId: 'r', apiBase: '/api/v1' });
    const r = await mk('https://del.example.com/1');
    const d = (r.body as { data: { id: string } }).data;
    const etag = r.headers.ETag;
    const del = (name: string, e = etag, who: Principal = editor) =>
      deleteLink(env.db, who, d.id, { confirm_name: name }, e, { idempotencyKey: crypto.randomUUID(), requestId: 'r', apiBase: '/internal' });

    expect((await err(del('다른 이름'))).code).toBe('VALIDATION_ERROR');
    const viewer = await env.addUser('viewer');
    expect((await err(del('삭제할 링크', etag, viewer))).code).toBe('INSUFFICIENT_PERMISSION');
    await del('삭제할 링크');

    expect((await err(getLink(env.db, editor, d.id))).code).toBe('NOT_FOUND');
    const [row] = await env.db.query<{ deleted_at: Date | null; status: string }>(`select deleted_at, status from bzup.links where id = $1`, [d.id]);
    expect(row.deleted_at).not.toBeNull();
    expect(row.status).toBe('inactive');
    const revs = await env.db.query<{ action: string }>(`select action from bzup.link_revisions where link_id = $1 order by version`, [d.id]);
    expect(revs.map((x) => x.action)).toEqual(['created', 'deleted']);
    // 같은 강의·type 으로 다시 생성 가능, 같은 목적지 중복 확인에도 안 걸림
    const again = await mk('https://del.example.com/1');
    expect(again.status).toBe(201);
    // 이미 삭제된 링크 재삭제는 404
    expect((await err(del('삭제할 링크'))).code).toBe('NOT_FOUND');
  });
});
