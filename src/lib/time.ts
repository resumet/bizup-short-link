// 시각 표시: DB/API UTC, 화면·Excel 한국 시간 (PRD §2.3)

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function toIso(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function kstParts(d: Date) {
  const k = new Date(d.getTime() + KST_OFFSET_MS);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return {
    y: p(k.getUTCFullYear(), 4), mo: p(k.getUTCMonth() + 1), d: p(k.getUTCDate()),
    h: p(k.getUTCHours()), mi: p(k.getUTCMinutes()), s: p(k.getUTCSeconds()),
  };
}

/** 2026-11-18 13:00:00 */
export function formatKst(d: Date | string | null | undefined): string {
  if (d === null || d === undefined) return '';
  const x = kstParts(typeof d === 'string' ? new Date(d) : d);
  return `${x.y}-${x.mo}-${x.d} ${x.h}:${x.mi}:${x.s}`;
}

/** 파일명용 YYYYMMDD_HHmmss (KST) */
export function kstFileStamp(d: Date): string {
  const x = kstParts(d);
  return `${x.y}${x.mo}${x.d}_${x.h}${x.mi}${x.s}`;
}
