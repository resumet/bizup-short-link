// 트래킹 링크: 엑셀(추천 코드·진행 매체·URL) → 강의별 짧은 주소, 같은 강의의 기존 URL 은 무시
import { beforeEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { setupDb } from './helpers/db';
import type { UserPrincipal } from '@/lib/auth/principal';
import { readTrackingWorkbook } from '@/lib/tracking/excel';
import { createTrackingLinks, listTrackingLinks, trackingLinkName } from '@/lib/services/tracking-links';
import { AppError } from '@/lib/errors';
import { createSingleLink, parseSingleCreateBody } from '@/lib/services/links';
import { PostgresLedger, setLedger } from '@/lib/services/ledger';
import { reserveCodes } from '@/lib/services/links';
import { loadUrlPolicy } from '@/lib/services/settings';

type Env = Awaited<ReturnType<typeof setupDb>>;
let env: Env;
let editor: UserPrincipal;
let courseA: string;
let courseB: string;
let n = 0;

const BASE = 'https://www.bizupclass.com/free-courses/032c74a8-178d-4dd4-a0fd-d25de86bf6b5';

/** 실제 업로드 파일과 같은 머리글 구성 */
async function workbook(rows: [string, string, string][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('트래킹 링크');
  ws.addRow(['생성일', '유입 채널', '추천 코드', '진행 매체', 'URL', '단축 링크']);
  for (const [code, media, url] of rows) ws.addRow(['2026.11.26', '제휴', code, media, url, null]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function upload(courseId: string, rows: [string, string, string][]) {
  const parsed = await readTrackingWorkbook(await workbook(rows));
  return createTrackingLinks(env.db, editor, { courseId, fileName: 'tracking.xlsx', rows: parsed }, `r${++n}`);
}

beforeEach(async () => {
  env = await setupDb();
  editor = await env.addUser('editor');
  courseA = await env.addCourse('현직약사의 건기식 세일즈 마스터 클래스');
  courseB = await env.addCourse('B 강의');
});

describe('엑셀 읽기', () => {
  it('머리글(추천 코드·진행 매체·URL)을 찾고 단축 링크·유입 채널 열은 쓰지 않는다, 값 앞뒤 공백 제거', async () => {
    const rows = await readTrackingWorkbook(await workbook([
      ['초월스토리 ', '유튜브', `${BASE}?code=6uq51m&channel=influencer&media=youtube`],
    ]));
    expect(rows).toEqual([{ row: 2, referralCode: '초월스토리', media: '유튜브', url: `${BASE}?code=6uq51m&channel=influencer&media=youtube` }]);
  });

  it('필수 머리글이 없으면 422', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('s').addRow(['코드', 'URL']);
    await expect(readTrackingWorkbook(Buffer.from(await wb.xlsx.writeBuffer()))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('엑셀이 아닌 파일은 422', async () => {
    await expect(readTrackingWorkbook(Buffer.from('not excel'))).rejects.toBeInstanceOf(AppError);
  });
});

describe('발급', () => {
  it('이름은 강의명_추천코드_진행매체, 짧은 주소 생성, 결과 보관', async () => {
    const r = await upload(courseA, [
      ['돈터뷰', '유튜브', `${BASE}?code=4fqljg`],
      ['매듭컴퍼니', '유튜브', `${BASE}?code=fcy19r`],
    ]);
    expect(r).toMatchObject({ total_rows: 2, created_count: 2, skipped_count: 0, error_count: 0 });
    expect(r.rows[0]).toMatchObject({ status: 'created', name: '현직약사의 건기식 세일즈 마스터 클래스_돈터뷰_유튜브', row: 2 });
    expect(r.rows[0].short_url).toMatch(/^https:\/\/.+\/[0-9A-Za-z]{7}$/);
    const stored = await listTrackingLinks(env.db, editor, courseA);
    expect(stored).toHaveLength(2);
    expect(stored.map((s) => s.referral_code).sort()).toEqual(['돈터뷰', '매듭컴퍼니']);
    const [link] = await env.db.query<{ course_id: string; source: string; deleted_at: Date | null }>(
      `select course_id, source, deleted_at from bzup.links where id = $1`, [r.rows[0].link_id],
    );
    expect(link).toMatchObject({ course_id: courseA, source: 'web', deleted_at: null });
    const [mode] = await env.db.query<{ creation_mode: string; type_key: string | null }>(
      `select creation_mode, type_key from bzup.links where id = $1`, [r.rows[0].link_id],
    );
    expect(mode).toEqual({ creation_mode: 'tracking', type_key: null });
    const [rev] = await env.db.query<{ n: number }>(`select count(*)::int as n from bzup.link_revisions where link_id = $1`, [r.rows[0].link_id]);
    expect(rev.n).toBe(1);
  });

  it('같은 강의에 다시 올리면 이미 있는 URL 은 무시하고 새 항목만 만든다', async () => {
    const first = await upload(courseA, [['돈터뷰', '유튜브', `${BASE}?code=4fqljg`]]);
    const second = await upload(courseA, [
      ['돈터뷰', '유튜브', `${BASE}?code=4fqljg`],
      ['늦지않았다', '유튜브', `${BASE}?code=6n3y5y`],
    ]);
    expect(second).toMatchObject({ total_rows: 2, created_count: 1, skipped_count: 1, error_count: 0 });
    expect(second.rows[0]).toMatchObject({ status: 'exists', link_id: first.rows[0].link_id, short_url: first.rows[0].short_url });
    expect(second.rows[1].status).toBe('created');
    expect(await listTrackingLinks(env.db, editor, courseA)).toHaveLength(2);
    const [u] = await env.db.query<{ n: number }>(`select count(*)::int as n from bzup.tracking_uploads where course_id = $1`, [courseA]);
    expect(u.n).toBe(2);
  });

  it('다른 강의에는 같은 URL 도 새로 만든다', async () => {
    await upload(courseA, [['돈터뷰', '유튜브', `${BASE}?code=4fqljg`]]);
    const r = await upload(courseB, [['돈터뷰', '유튜브', `${BASE}?code=4fqljg`]]);
    expect(r.created_count).toBe(1);
  });

  it('파일 안 중복 URL 은 건너뛰고, 빈 값·잘못된 URL 은 오류 행으로 표시(나머지는 생성)', async () => {
    const r = await upload(courseA, [
      ['A', '유튜브', `${BASE}?code=a`],
      ['B', '유튜브', `${BASE}?code=a`],
      ['', '유튜브', `${BASE}?code=c`],
      ['D', '유튜브', 'not a url'],
    ]);
    expect(r.rows.map((x) => x.status)).toEqual(['created', 'duplicate_in_file', 'error', 'error']);
    expect(r).toMatchObject({ created_count: 1, skipped_count: 1, error_count: 2 });
  });

  it('긴 강의명은 120자에 맞게 줄인다', () => {
    const name = trackingLinkName('가'.repeat(200), '코드', '매체');
    expect([...name].length).toBe(120);
    expect(name.endsWith('_코드_매체')).toBe(true);
  });
});

describe('DB 원장 일괄 예약 (운영과 같은 CODE_LEDGER_DRIVER=postgres)', () => {
  it('한 문장으로 예약해 13행 업로드가 끝나고, 코드는 모두 다르다', async () => {
    setLedger(new PostgresLedger(env.db));
    const rows = Array.from({ length: 13 }, (_, i) => [`R${i}`, '유튜브', `${BASE}?code=x${i}`] as [string, string, string]);
    const r = await upload(courseA, rows);
    expect(r.created_count).toBe(13);
    expect(new Set(r.rows.map((x) => x.short_url)).size).toBe(13);
    const [c] = await env.db.query<{ n: number }>(`select count(*)::int as n from bzup_ledger.code_reservations`);
    expect(c.n).toBe(13);
  });

  it('이미 예약된 코드와 충돌하면 그 행만 새 코드로 다시 예약한다', async () => {
    const ledger = new PostgresLedger(env.db);
    setLedger(ledger);
    const policy = await loadUrlPolicy(env.db);
    const first = [{ linkId: crypto.randomUUID() } as { linkId: string; shortCode?: string }];
    await reserveCodes(env.db, policy, env.workspaceId, first);
    // 같은 코드를 다른 링크가 먼저 가져간 상태를 흉내: 예약 시도 1회차에 기존 코드를 끼워 넣는다
    const rows = [{ linkId: crypto.randomUUID(), shortCode: undefined as string | undefined }];
    const orig = ledger.reserveMany.bind(ledger);
    let call = 0;
    ledger.reserveMany = async (inputs) => orig(call++ === 0 ? inputs.map((i) => ({ ...i, shortCode: first[0].shortCode! })) : inputs);
    await reserveCodes(env.db, policy, env.workspaceId, rows);
    expect(call).toBe(2);
    expect(rows[0].shortCode).toMatch(/^[0-9A-Za-z]{7}$/);
    expect(rows[0].shortCode).not.toBe(first[0].shortCode);
  });
});

describe('트래킹 링크만 강의 + 원본 주소당 1개', () => {
  it('같은 강의에 같은 URL 의 일반 링크가 있어도 트래킹 링크는 만든다', async () => {
    await createSingleLink(env.db, editor, parseSingleCreateBody({ course_id: courseA, name: '일반', destination_url: `${BASE}?code=g1` }),
      { idempotencyKey: crypto.randomUUID(), requestId: 'x', apiBase: '/internal' });
    const r = await upload(courseA, [['G', '유튜브', `${BASE}?code=g1`]]);
    expect(r.created_count).toBe(1);
  });

  it('DB 가 같은 강의·URL 의 두 번째 트래킹 링크를 막고, 삭제하면 다시 만들 수 있다', async () => {
    const first = await upload(courseA, [['A', '유튜브', `${BASE}?code=d1`]]);
    const id = first.rows[0].link_id!;
    // 같은 행을 그대로 복제해 넣으면 고유 색인 위반
    await expect(env.db.query(
      `insert into bzup.links (workspace_id, issued_domain, short_code, name, initial_destination_url, destination_url,
         canonical_destination, destination_fingerprint, course_id, status, source, creation_mode, created_by_type, updated_by_type)
       select workspace_id, issued_domain, 'Zz99999', name, initial_destination_url, destination_url,
         canonical_destination, destination_fingerprint, course_id, status, source, creation_mode, created_by_type, updated_by_type
         from bzup.links where id = $1`, [id],
    )).rejects.toMatchObject({ code: '23505' });
    await env.db.query(`update bzup.links set deleted_at = now() where id = $1`, [id]);
    const again = await upload(courseA, [['A', '유튜브', `${BASE}?code=d1`]]);
    expect(again.created_count).toBe(1);
    expect(again.rows[0].link_id).not.toBe(id);
  });
});
