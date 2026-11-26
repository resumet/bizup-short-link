// 트래킹 링크 업로드 양식(.xlsx)
import { internalRoute } from '@/lib/route';
import { baseHeaders } from '@/lib/http';
import { trackingTemplateWorkbook } from '@/lib/tracking/excel';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = internalRoute(async (c) => {
  const buf = await trackingTemplateWorkbook();
  const h = baseHeaders(c.requestId, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="tracking-links-template.xlsx"; filename*=UTF-8''${encodeURIComponent('트래킹링크_업로드양식.xlsx')}`,
  });
  return new Response(new Uint8Array(buf), { status: 200, headers: h });
});
