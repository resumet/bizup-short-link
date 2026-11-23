import { beforeEach, describe, expect, it } from 'vitest';
import { setupDb } from './helpers/db';
import { AppError } from '@/lib/errors';
import {
  createBatch, getLink, getLinkRevisions, parseBatchCreateBody, parsePatchBody, patchLink, preflight,
} from '@/lib/services/links';
import { getTemplateForAdmin, saveTemplate } from '@/lib/services/template';
import { listLinks } from '@/lib/services/link-query';
import type { UserPrincipal } from '@/lib/auth/principal';

type Env = Awaited<ReturnType<typeof setupDb>>;
let env: Env;
let owner: UserPrincipal;
let editor: UserPrincipal;
let course: string;
let n = 0;
const k = () => `slot-key-${Date.now()}-${++n}`;
const ctx = () => ({ idempotencyKey: k(), requestId: 'r', apiBase: '/internal' as const });

async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e) { if (e instanceof AppError) return e.code; throw e; }
}

const CHAT = 'https://open.kakao.com/o/abc123';
const LIVE = 'https://www.youtube.com/live/xyz';
const ZOOM = 'https://zoom.us/j/123456789';

async function template() {
  const t = await getTemplateForAdmin(env.db, owner);
  const item = t.data.items.find((i) => i.name === '단톡방-라이브유튜브-앵콜줌')!;
  return { id: t.data.id, version: t.data.version, item };
}

async function createSlotted(slotUrls: (string | null)[]) {
  const t = await template();
  const r = await createBatch(env.db, editor, parseBatchCreateBody({
    course_id: course, template_id: t.id, template_version: t.version,
    items: [{ template_item_id: t.item.id, slot_urls: slotUrls }],
  }), ctx());
  const linkId = (r.body as { data: { results: { link_id: string }[] } }).data.results[0].link_id;
  return linkId;
}

beforeEach(async () => {
  env = await setupDb();
  owner = await env.addUser('owner');
  editor = await env.addUser('editor');
  course = await env.addCourse('강의');
});

describe('기본 이름 목록 항목', () => {
  it('새 목록에 "단톡방-라이브유튜브-앵콜줌"(전환 주소 3개)이 기본으로 있다', async () => {
    const t = await template();
    expect(t.item.destination_slots).toEqual(['단톡방', '라이브 유튜브', '앵콜 줌']);
    expect(t.item.is_active).toBe(true);
  });
});

describe('전환 주소 링크 생성', () => {
  it('짧은 주소 1개, 기본은 단톡방으로 연결, 나머지는 비워 둘 수 있다', async () => {
    const id = await createSlotted([CHAT, LIVE, null]);
    const { link, slots } = await getLink(env.db, editor, id);
    expect(link.destination_url).toBe(CHAT);
    expect(Number(link.active_slot)).toBe(0);
    expect(slots).toEqual([
      { position: 0, label: '단톡방', destination_url: CHAT },
      { position: 1, label: '라이브 유튜브', destination_url: LIVE },
      { position: 2, label: '앵콜 줌', destination_url: null },
    ]);
    expect((await env.db.query(`select count(*)::int as n from bzup.links`))[0]).toEqual({ n: 1 });
    const list = await listLinks(env.db, editor, {});
    expect(list.data[0].active_slot_label).toBe('단톡방');
  });

  it('단톡방(기본) 주소는 필수, 개수가 다르면 거절', async () => {
    const t = await template();
    expect(() => parseBatchCreateBody({
      course_id: course, template_id: t.id, template_version: t.version,
      items: [{ template_item_id: t.item.id, slot_urls: [null, LIVE, ZOOM] }],
    })).toThrow(AppError);
    expect(await code(createBatch(env.db, editor, parseBatchCreateBody({
      course_id: course, template_id: t.id, template_version: t.version,
      items: [{ template_item_id: t.item.id, slot_urls: [CHAT, LIVE] }],
    }), ctx()))).toBe('TEMPLATE_ITEMS_MISMATCH');
    expect(await code(createBatch(env.db, editor, parseBatchCreateBody({
      course_id: course, template_id: t.id, template_version: t.version,
      items: [{ template_item_id: t.item.id, destination_url: CHAT }],
    }), ctx()))).toBe('TEMPLATE_ITEMS_MISMATCH');
  });

  it('중복 확인은 현재 연결(단톡방) 주소 기준, 프리플라이트도 같은 규칙', async () => {
    await createSlotted([CHAT, null, null]);
    const t = await template();
    const pf = await preflight(env.db, editor, {
      mode: 'batch', course_id: course, template_id: t.id, template_version: t.version,
      items: [{ template_item_id: t.item.id, slot_urls: [CHAT, null, null] }],
    });
    expect(pf.requires_confirmation).toBe(true);
  });
});

describe('상세에서 전환', () => {
  it('라이브 유튜브로 전환 → 목적지 변경, 짧은 코드 유지, 이력 기록', async () => {
    const id = await createSlotted([CHAT, LIVE, null]);
    const before = await getLink(env.db, editor, id);
    const r = await patchLink(env.db, editor, id, parsePatchBody({ active_slot: 1 }), before.etag, ctx());
    const d = (r.body as { data: { destination_url: string; active_slot: number; short_code: string; version: number }; changed_fields: string[] });
    expect(d.data).toMatchObject({ destination_url: LIVE, active_slot: 1, short_code: before.link.short_code, version: 2 });
    expect(d.changed_fields.sort()).toEqual(['active_slot', 'destination_url']);
    const rev = (await getLinkRevisions(env.db, editor, id))[0];
    expect(rev.before).toMatchObject({ active_slot_label: '단톡방', destination_url: CHAT });
    expect(rev.after).toMatchObject({ active_slot_label: '라이브 유튜브', destination_url: LIVE });
  });

  it('비어 있는 주소로는 전환 불가, 주소 입력 후 전환 가능', async () => {
    const id = await createSlotted([CHAT, LIVE, null]);
    let cur = await getLink(env.db, editor, id);
    expect(await code(patchLink(env.db, editor, id, parsePatchBody({ active_slot: 2 }), cur.etag, ctx()))).toBe('VALIDATION_ERROR');
    await patchLink(env.db, editor, id, parsePatchBody({ slot_urls: [CHAT, LIVE, ZOOM] }), cur.etag, ctx());
    cur = await getLink(env.db, editor, id);
    expect(cur.link.destination_url).toBe(CHAT); // 주소만 저장, 연결은 그대로
    await patchLink(env.db, editor, id, parsePatchBody({ active_slot: 2 }), cur.etag, ctx());
    expect((await getLink(env.db, editor, id)).link.destination_url).toBe(ZOOM);
  });

  it('연결 중인 주소를 수정하면 목적지도 함께 바뀐다, 연결 중인 주소는 비울 수 없다', async () => {
    const id = await createSlotted([CHAT, LIVE, null]);
    let cur = await getLink(env.db, editor, id);
    const NEW_CHAT = 'https://open.kakao.com/o/new999';
    await patchLink(env.db, editor, id, parsePatchBody({ slot_urls: [NEW_CHAT, LIVE, null] }), cur.etag, ctx());
    cur = await getLink(env.db, editor, id);
    expect(cur.link.destination_url).toBe(NEW_CHAT);
    expect(await code(patchLink(env.db, editor, id, parsePatchBody({ slot_urls: [null, LIVE, null] }), cur.etag, ctx()))).toBe('VALIDATION_ERROR');
  });

  it('전환 주소 링크에 destination_url 직접 수정, 일반 링크에 active_slot 은 거절', async () => {
    const id = await createSlotted([CHAT, LIVE, null]);
    const cur = await getLink(env.db, editor, id);
    expect(await code(patchLink(env.db, editor, id, parsePatchBody({ destination_url: ZOOM }), cur.etag, ctx()))).toBe('VALIDATION_ERROR');
    expect(() => parsePatchBody({ destination_url: ZOOM, active_slot: 1 })).toThrow(AppError);
  });

  it('viewer 는 전환할 수 없다', async () => {
    const viewer = await env.addUser('viewer');
    const id = await createSlotted([CHAT, LIVE, null]);
    const cur = await getLink(env.db, editor, id);
    expect(await code(patchLink(env.db, viewer, id, parsePatchBody({ active_slot: 1 }), cur.etag, ctx()))).toBe('INSUFFICIENT_PERMISSION');
  });
});

describe('이름 목록 편집', () => {
  it('전환 주소 라벨 변경은 목록 버전을 올린다, 2~5개 검증', async () => {
    const t = await getTemplateForAdmin(env.db, owner);
    const items = t.data.items.filter((i) => i.is_active).map((i) => ({ id: i.id, name: i.name, destination_slots: i.destination_slots }));
    items[0].destination_slots = ['단톡방', '라이브 유튜브', '앵콜 줌', '복습 영상'];
    const r = await saveTemplate(env.db, owner, { items }, t.etag, k(), 'r');
    expect((r.body as { version_changed: boolean }).version_changed).toBe(true);
    const bad = [{ ...items[0], destination_slots: ['하나'] }];
    expect(await code(saveTemplate(env.db, owner, { items: bad }, r.headers.ETag, k(), 'r'))).toBe('VALIDATION_ERROR');
  });
});
