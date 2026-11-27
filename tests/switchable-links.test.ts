// 전환형 짧은 주소 유형: 빈 칸으로 만들고 나중에 채우기 · 강의+유형으로 전환 (API)
import { beforeEach, describe, expect, it } from 'vitest';
import { setupDb } from './helpers/db';
import { AppError } from '@/lib/errors';
import type { ApiPrincipal, UserPrincipal } from '@/lib/auth/principal';
import {
  createTypedShortLink, getTypedLinkState, listShortLinkTypes, setTypedSlot, switchTypedSlot,
} from '@/lib/services/short-links';
import { createLinkType, updateLinkType } from '@/lib/services/link-types-admin';
import { getLinkRevisions, parsePatchBody, patchLink, getLink } from '@/lib/services/links';
import { listLinks } from '@/lib/services/link-query';

type Env = Awaited<ReturnType<typeof setupDb>>;
let env: Env;
let owner: UserPrincipal;
let api: ApiPrincipal;
let course: string;
let n = 0;

const CHAT = 'https://open.kakao.com/o/abc123';
const LIVE = 'https://www.youtube.com/live/xyz';
const LIVE2 = 'https://www.youtube.com/live/next';
const ZOOM = 'https://zoom.us/j/123456789';

const ctx = () => ({ idempotencyKey: crypto.randomUUID(), requestId: `r${++n}`, apiBase: '/api/v1' as const });
const target = (over: Record<string, unknown> = {}) => ({ course_id: course, type_key: 'free_chat', ...over });
async function err(p: Promise<unknown>): Promise<AppError> {
  try { await p; } catch (e) { if (e instanceof AppError) return e; throw e; }
  throw new Error('expected error');
}
async function create(over: Record<string, unknown> = {}) {
  return createTypedShortLink(env.db, api, { ...target(), name: '무료단톡방', slot_urls: { chat: CHAT }, ...over }, ctx());
}
async function redirectTarget() {
  const [r] = await env.db.query<{ destination_url: string }>(
    `select destination_url from bzup.links where course_id = $1 and type_key = 'free_chat' and deleted_at is null`, [course]);
  return r.destination_url;
}

beforeEach(async () => {
  env = await setupDb();
  owner = await env.addUser('owner');
  api = (await env.addApiKey(owner, ['links:create', 'links:read', 'links:update'])).principal;
  course = await env.addCourse('A 강의');
});

describe('전환형 유형', () => {
  it('기본 free_chat 유형: chat·youtube·zoom 구성이 유형 조회에 보인다', async () => {
    const t = (await listShortLinkTypes(env.db, api)).find((x) => x.key === 'free_chat')!;
    expect(t).toMatchObject({ label: '무료단톡방', active: true });
    expect(t.slots!.map((s) => s.key)).toEqual(['chat', 'youtube', 'zoom']);
  });

  it('관리: 구성 2~5개·키 형식·중복 검증, 링크를 만든 뒤에는 구성 변경 불가', async () => {
    const code = async (slots: unknown) =>
      (await err(createLinkType(env.db, owner, { key: 'x_type', label: 'x', slots }, crypto.randomUUID(), 'r'))).code;
    expect(await code([{ key: 'a', label: 'A' }])).toBe('VALIDATION_ERROR');
    expect(await code([{ key: 'a', label: 'A' }, { key: 'a', label: 'B' }])).toBe('VALIDATION_ERROR');
    expect(await code([{ key: 'A', label: 'A' }, { key: 'b', label: 'B' }])).toBe('VALIDATION_ERROR');
    // 전환형은 free_chat 만: 다른 key 에 구성을 주면 거절
    expect(await code([{ key: 'chat', label: '단톡방' }, { key: 'replay', label: '다시보기' }])).toBe('VALIDATION_ERROR');
    // free_chat 은 링크가 없으면 구성 변경 가능
    await updateLinkType(env.db, owner, 'free_chat', { slots: [{ key: 'chat', label: '단톡방' }, { key: 'live', label: '라이브' }] }, crypto.randomUUID(), 'r');
    await createTypedShortLink(env.db, api, { course_id: course, type_key: 'free_chat', name: 'w', destination_url: CHAT }, ctx());
    const e = await err(updateLinkType(env.db, owner, 'free_chat', { slots: null }, crypto.randomUUID(), 'r'));
    expect(e.code).toBe('CONFLICT');
    // 이름 변경은 계속 가능
    await updateLinkType(env.db, owner, 'free_chat', { label: '무료단톡방 2' }, crypto.randomUUID(), 'r');
  });
});

describe('생성: 첫 주소만 필수, 나머지는 비워 둔다', () => {
  it('slot_urls 로 첫 주소만 주면 나머지는 null, 단톡방에 연결', async () => {
    const r = await create({ slot_urls: { chat: CHAT, youtube: null } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      destination_url: CHAT, active_slot: 'chat',
      slots: [
        { key: 'chat', label: '단톡방', destination_url: CHAT },
        { key: 'youtube', label: '유튜브 라이브', destination_url: null },
        { key: 'zoom', label: '줌 라이브', destination_url: null },
      ],
    });
    expect(await redirectTarget()).toBe(CHAT);
  });

  it('destination_url 만 보내도 첫 주소로 쓴다', async () => {
    const r = await createTypedShortLink(env.db, api, { ...target(), name: 'x', destination_url: CHAT }, ctx());
    expect(r.body).toMatchObject({ active_slot: 'chat', destination_url: CHAT });
  });

  it('첫 주소 누락·없는 키·두 값 불일치·잘못된 주소·일반 유형에 slot_urls 는 422', async () => {
    const code = async (over: Record<string, unknown>) => (await err(create(over))).code;
    expect(await code({ slot_urls: { youtube: LIVE } })).toBe('VALIDATION_ERROR');
    expect(await code({ slot_urls: { chat: CHAT, kakao: LIVE } })).toBe('VALIDATION_ERROR');
    expect(await code({ destination_url: ZOOM, slot_urls: { chat: CHAT } })).toBe('VALIDATION_ERROR');
    expect(await code({ slot_urls: { chat: CHAT, youtube: 'ftp://x' } })).toBe('VALIDATION_ERROR');
    expect(await code({ slot_urls: [CHAT] })).toBe('VALIDATION_ERROR');
    expect((await err(createTypedShortLink(env.db, api, { course_id: course, type_key: 'payment', name: 'p', destination_url: CHAT, slot_urls: { chat: CHAT } }, ctx()))).code)
      .toBe('VALIDATION_ERROR');
  });
});

describe('나중에 채우고 전환 (강의 + 유형, ETag 없이)', () => {
  it('라이브 전 채우기 → 전환 → 복귀 → 다음날 줌, 이동 주소가 따라 바뀐다', async () => {
    await create();
    // 유튜브 주소가 나오면 채우기만 (연결은 그대로)
    const filled = await setTypedSlot(env.db, api, { ...target(), slot: 'youtube', destination_url: LIVE }, ctx());
    expect(filled).toMatchObject({ active_slot: 'chat', changed_fields: ['slot_urls'] });
    expect(await redirectTarget()).toBe(CHAT);

    // 라이브 시작
    const live = await switchTypedSlot(env.db, api, { ...target(), slot: 'youtube' }, ctx());
    expect(live).toMatchObject({ active_slot: 'youtube', active_slot_label: '유튜브 라이브', destination_url: LIVE });
    expect(await redirectTarget()).toBe(LIVE);

    // 같은 전환 반복은 변경 없음
    expect(await switchTypedSlot(env.db, api, { ...target(), slot: 'youtube' }, ctx())).toMatchObject({ changed_fields: [] });

    // 라이브 중 주소 교체도 바로 반영
    await setTypedSlot(env.db, api, { ...target(), slot: 'youtube', destination_url: LIVE2 }, ctx());
    expect(await redirectTarget()).toBe(LIVE2);

    // 종료 → 단톡방
    await switchTypedSlot(env.db, api, { ...target(), slot: 'chat' }, ctx());
    expect(await redirectTarget()).toBe(CHAT);

    // 다음날 줌: 채우고 바로 전환 (한 번에)
    const zoom = await setTypedSlot(env.db, api, { ...target(), slot: 'zoom', destination_url: ZOOM, activate: true }, ctx());
    expect(zoom).toMatchObject({ active_slot: 'zoom', destination_url: ZOOM });
    expect(zoom.changed_fields).toEqual(expect.arrayContaining(['slot_urls', 'active_slot', 'destination_url']));
    expect(await redirectTarget()).toBe(ZOOM);

    // 상태 조회
    const state = await getTypedLinkState(env.db, api, target());
    expect(state).toMatchObject({ switchable: true, active_slot: 'zoom', slots: [
      { key: 'chat', destination_url: CHAT }, { key: 'youtube', destination_url: LIVE2 }, { key: 'zoom', destination_url: ZOOM },
    ] });

    // 변경 이력에 전부 남는다
    const revs = await getLinkRevisions(env.db, owner, state.link_id);
    expect(revs.length).toBeGreaterThanOrEqual(6);
  });

  it('빈 주소로 전환 불가, 연결 중인 주소는 비울 수 없음, 연결 안 된 주소는 비울 수 있음', async () => {
    await create();
    expect((await err(switchTypedSlot(env.db, api, { ...target(), slot: 'youtube' }, ctx()))).code).toBe('SLOT_EMPTY');
    expect((await err(setTypedSlot(env.db, api, { ...target(), slot: 'chat', destination_url: null }, ctx()))).code).toBe('SLOT_EMPTY');
    expect((await err(setTypedSlot(env.db, api, { ...target(), slot: 'youtube', destination_url: null, activate: true }, ctx()))).code).toBe('SLOT_EMPTY');
    await setTypedSlot(env.db, api, { ...target(), slot: 'youtube', destination_url: LIVE }, ctx());
    const cleared = await setTypedSlot(env.db, api, { ...target(), slot: 'youtube', destination_url: null }, ctx());
    expect(cleared.slots![1].destination_url).toBeNull();
    expect(await redirectTarget()).toBe(CHAT);
  });

  it('없는 키·전환형 아닌 링크·없는 링크·권한', async () => {
    await create();
    expect((await err(switchTypedSlot(env.db, api, { ...target(), slot: 'kakao' }, ctx()))).code).toBe('UNKNOWN_SLOT');
    await createTypedShortLink(env.db, api, { course_id: course, type_key: 'payment', name: 'p', destination_url: CHAT }, ctx());
    expect((await err(switchTypedSlot(env.db, api, { ...target({ type_key: 'payment' }), slot: 'chat' }, ctx()))).code).toBe('LINK_NOT_SWITCHABLE');
    expect((await getTypedLinkState(env.db, api, target({ type_key: 'payment' }))).switchable).toBe(false);
    expect((await err(switchTypedSlot(env.db, api, { ...target({ type_key: 'landing' }), slot: 'chat' }, ctx()))).code).toBe('NOT_FOUND');
    const createOnly = (await env.addApiKey(owner, ['links:create'])).principal;
    expect((await err(switchTypedSlot(env.db, createOnly, { ...target(), slot: 'chat' }, ctx()))).code).toBe('INSUFFICIENT_SCOPE');
    expect((await err(switchTypedSlot(env.db, api, { ...target(), slot: 'chat', extra: 1 }, ctx()))).code).toBe('VALIDATION_ERROR');
  });

  it('웹 화면 방식(링크 ID + ETag PATCH)과 함께 써도 상태가 맞다', async () => {
    const r = await create();
    const { etag } = await getLink(env.db, owner, r.body.link_id);
    await patchLink(env.db, owner, r.body.link_id, parsePatchBody({ slot_urls: [CHAT, LIVE, null] }), etag,
      { idempotencyKey: crypto.randomUUID(), requestId: 'w', apiBase: '/internal' });
    const s = await switchTypedSlot(env.db, api, { ...target(), slot: 'youtube' }, ctx());
    expect(s.destination_url).toBe(LIVE);
    const list = await listLinks(env.db, owner, { course_id: course });
    expect(list.data[0]).toMatchObject({ active_slot_label: '유튜브 라이브' });
  });
});
