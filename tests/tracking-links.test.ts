// 트래킹 링크: 엑셀(추천 코드·진행 매체·URL) → 강의별 짧은 주소, 같은 강의의 기존 URL 은 무시
import { beforeEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { setupDb } from './helpers/db';
import type { UserPrincipal } from '@/lib/auth/principal';
import { readTrackingWorkbook } from '@/lib/tracking/excel';
import { createTrackingLinks, listTrackingLinks, trackingLinkName } from '@/lib/services/tracking-links';
import { AppError } from '@/lib/errors';

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
