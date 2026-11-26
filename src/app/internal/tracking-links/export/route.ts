// 강의별 보관된 트래킹 링크 엑셀 내려받기 (단축 링크 열 채움)
import { internalRoute } from '@/lib/route';
import { baseHeaders } from '@/lib/http';
import { AppError } from '@/lib/errors';
import { formatKst, kstFileStamp } from '@/lib/time';
import type { UserPrincipal } from '@/lib/auth/principal';
import { trackingExportWorkbook } from '@/lib/tracking/excel';
import { listTrackingLinks } from '@/lib/services/tracking-links';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const STATUS = { active: '사용중', inactive: '중지', deleted: '삭제됨' } as const;

export const GET = internalRoute(async (c) => {
  const courseId = new URL(c.req.url).searchParams.get('course_id');
  const rows = await listTrackingLinks(c.db, c.principal as UserPrincipal, courseId);
  if (!rows.length) throw new AppError('EMPTY_EXPORT');
  const [course] = await c.db.query<{ name: string }>(
    `select name from bzup.courses where workspace_id = $1 and id = $2`, [c.principal.workspaceId, courseId],
  );
  const buf = await trackingExportWorkbook(
    rows.map((r) => ({ ...r, status: STATUS[r.status] })),
    (iso) => formatKst(iso).slice(0, 16),
  );
  const safe = (course?.name ?? 'course').replace(/[\/:*?"<>|\s]+/g, '_').slice(0, 80);
  const fileName = `tracking-links-${safe}-${kstFileStamp(new Date())}.xlsx`;
  const h = baseHeaders(c.requestId, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="tracking-links.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  });
  return new Response(new Uint8Array(buf), { status: 200, headers: h });
});
