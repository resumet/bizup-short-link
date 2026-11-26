// 트래킹 링크 엑셀 읽기: 머리글 행에서 추천코드·진행매체·URL 열을 찾아 행을 꺼낸다.
// 파일은 메모리에서만 읽고 저장하지 않는다.
import ExcelJS from 'exceljs';
import { AppError, validationError } from '@/lib/errors';

export const TRACKING_MAX_ROWS = 300;
export const TRACKING_MAX_FILE_BYTES = 4 * 1024 * 1024; // Vercel 함수 요청 본문 한도(4.5MB) 아래
const HEADER_SCAN_ROWS = 20;

export interface TrackingSheetRow {
  /** 엑셀의 실제 행 번호 */
  row: number;
  referralCode: string;
  media: string;
  url: string;
}

type ColumnKey = 'referral' | 'media' | 'url';

const HEADER_RULES: Record<ColumnKey, RegExp[]> = {
  referral: [/추천\s*(인\s*)?코드/i, /referral|ref[\s_-]*code|추천/i],
  media: [/진행\s*매체/i, /매체|media|채널|channel/i],
  url: [/^\s*(url|링크\s*url|랜딩\s*url)\s*$/i, /url|링크|주소|landing/i],
};
// 결과 열(짧은 주소)을 원본 URL 열로 착각하지 않도록 제외
const NOT_URL_HEADER = /짧은|단축|short/i;

function plain(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('richText' in v && Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('hyperlink' in v) {
      const text = typeof v.text === 'string' ? v.text : plain(v.text as ExcelJS.CellValue);
      return text || String(v.hyperlink ?? '');
    }
    if ('result' in v) return plain(v.result as ExcelJS.CellValue);
    if ('error' in v) return '';
  }
  return String(v);
}

/** 셀 문자열. URL 열은 표시 문자열이 URL 이 아니고 하이퍼링크가 있으면 하이퍼링크를 쓴다 */
function cellText(cell: ExcelJS.Cell, preferHyperlink = false): string {
  const v = cell.value;
  if (preferHyperlink && v && typeof v === 'object' && 'hyperlink' in v && typeof v.hyperlink === 'string') {
    const shown = plain(v).trim();
    if (!/^https?:\/\//i.test(shown)) return v.hyperlink.trim();
  }
  return plain(v).replace(/ /g, ' ').trim();
}

function findColumns(headers: string[]): Partial<Record<ColumnKey, number>> {
  const found: Partial<Record<ColumnKey, number>> = {};
  const used = new Set<number>();
  for (const key of ['referral', 'media', 'url'] as ColumnKey[]) {
    for (const re of HEADER_RULES[key]) {
      const idx = headers.findIndex((h, i) => !used.has(i) && h !== '' && re.test(h) && !(key === 'url' && NOT_URL_HEADER.test(h)));
      if (idx >= 0) { found[key] = idx; used.add(idx); break; }
    }
  }
  return found;
}

const LABEL: Record<ColumnKey, string> = { referral: '추천코드', media: '진행매체', url: 'URL' };

/** 첫 번째 시트에서 머리글(추천코드·진행매체·URL)을 찾고 데이터 행을 돌려준다 */
export async function readTrackingWorkbook(data: ArrayBuffer | Buffer): Promise<TrackingSheetRow[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data as ArrayBuffer);
  } catch {
    throw validationError('엑셀 파일(.xlsx)을 읽을 수 없습니다. 파일 형식을 확인해 주세요.', [{ field: 'file', message: '.xlsx 형식만 지원' }]);
  }
  const ws = wb.worksheets.find((s) => s.actualRowCount > 0) ?? wb.worksheets[0];
  if (!ws) throw validationError('엑셀 파일에 시트가 없습니다.', [{ field: 'file', message: '빈 파일' }]);

  let headerRow = -1;
  let cols: Partial<Record<ColumnKey, number>> = {};
  let best: Partial<Record<ColumnKey, number>> = {};
  const lastScan = Math.min(ws.rowCount, HEADER_SCAN_ROWS);
  for (let r = 1; r <= lastScan; r++) {
    const row = ws.getRow(r);
    const headers: string[] = [];
    for (let c = 1; c <= Math.max(row.cellCount, ws.columnCount); c++) headers.push(cellText(row.getCell(c)));
    const f = findColumns(headers);
    if (Object.keys(f).length > Object.keys(best).length) best = f;
    if (f.referral !== undefined && f.media !== undefined && f.url !== undefined) {
      headerRow = r;
      cols = f;
      break;
    }
  }
  if (headerRow < 0) {
    const missing = (['referral', 'media', 'url'] as ColumnKey[]).filter((k) => best[k] === undefined).map((k) => LABEL[k]);
    throw validationError(
      `엑셀 머리글에서 ${missing.join('·')} 열을 찾지 못했습니다. 첫 행에 '추천코드', '진행매체', 'URL' 머리글을 넣어 주세요.`,
      [{ field: 'file', message: `찾지 못한 열: ${missing.join(', ')}` }],
    );
  }

  const rows: TrackingSheetRow[] = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const referralCode = cellText(row.getCell(cols.referral! + 1));
    const media = cellText(row.getCell(cols.media! + 1));
    const url = cellText(row.getCell(cols.url! + 1), true);
    if (!referralCode && !media && !url) continue;
    rows.push({ row: r, referralCode, media, url });
    if (rows.length > TRACKING_MAX_ROWS) {
      throw new AppError('PAYLOAD_TOO_LARGE', `한 번에 최대 ${TRACKING_MAX_ROWS}행까지 올릴 수 있습니다. 파일을 나눠 주세요.`);
    }
  }
  if (rows.length === 0) throw validationError('엑셀에 데이터 행이 없습니다.', [{ field: 'file', message: '데이터 없음' }]);
  return rows;
}

/** 업로드 양식 */
export async function trackingTemplateWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('트래킹 링크');
  ws.columns = [
    { header: '추천코드', key: 'referral', width: 16 },
    { header: '진행매체', key: 'media', width: 18 },
    { header: 'URL', key: 'url', width: 70 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.addRow({ referral: 'ABC123', media: '인스타그램', url: 'https://example.com/landing?ref=ABC123' });
  ws.addRow({ referral: 'XYZ789', media: '유튜브', url: 'https://example.com/landing?ref=XYZ789' });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export interface TrackingExportRow {
  created_at: string | null; name: string; referral_code: string; media: string; destination_url: string; short_url: string; status: string;
}

/** 보관된 트래킹 링크 내려받기: 업로드 양식 열 + 이름·단축 링크·상태 */
export async function trackingExportWorkbook(rows: TrackingExportRow[], formatDate: (iso: string | null) => string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('트래킹 링크');
  ws.columns = [
    { header: '생성일', key: 'created', width: 18 },
    { header: '이름', key: 'name', width: 40 },
    { header: '추천 코드', key: 'referral', width: 20 },
    { header: '진행 매체', key: 'media', width: 14 },
    { header: 'URL', key: 'url', width: 70 },
    { header: '단축 링크', key: 'short', width: 28 },
    { header: '상태', key: 'status', width: 10 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    ws.addRow({ created: formatDate(r.created_at), name: r.name, referral: r.referral_code, media: r.media,
      url: r.destination_url, short: r.short_url, status: r.status });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
