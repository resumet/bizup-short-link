// 공개 짧은 주소 이동 (PRD §12)
// - GET·HEAD 만 허용, 302 + no-store, 캐시·읽기 복제본 사용 금지
// - 등록된 active 호스트에서만 처리, 직원 로그인·API 키 불필요
// - 짧은 URL의 추가 query 를 목적지에 병합하지 않는다
import { after } from 'next/server';
import { getDb } from '@/lib/db/postgres';
import { recordView } from '@/lib/services/views';
import { SHORT_CODE_RE, isReservedCode } from '@/lib/crypto';
import { normalizeRequestHost } from '@/lib/services/settings';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const COMMON = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
  'X-Content-Type-Options': 'nosniff',
};

function page(status: number, title: string, message: string, head: boolean): Response {
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{font-family:system-ui,-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#f7f7f8;color:#222}main{text-align:center;padding:24px}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#666}</style></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
  return new Response(head ? null : html, {
    status,
    headers: { ...COMMON, 'Content-Type': 'text/html; charset=utf-8', ...(status === 503 ? { 'Retry-After': '5' } : {}) },
  });
}

const notFound = (head: boolean) => page(404, '찾을 수 없는 주소입니다', '주소를 다시 확인해 주세요.', head);
const unavailable = (head: boolean) => page(404, '사용할 수 없는 주소입니다', '이 짧은 주소는 현재 사용할 수 없습니다.', head);

async function resolve(req: Request, code: string): Promise<Response> {
  const head = req.method === 'HEAD';
  if (!SHORT_CODE_RE.test(code) || isReservedCode(code)) return notFound(head);
  const host = normalizeRequestHost(req.headers.get('host'));
  try {
    const db = getDb();
    // 등록된 active 호스트 확인과 링크 조회를 최신 primary DB 한 번의 조회로 수행
    const rows = await db.query<{ host_ok: boolean; id: string | null; destination_url: string | null; status: string | null }>(
      `select exists(select 1 from bzup.service_domains where hostname = $1 and status = 'active') as host_ok,
              l.id, l.destination_url, l.status
         from (select 1) x
         left join bzup.links l on l.short_code = $2`,
      [host ?? '', code],
    );
    const r = rows[0];
    if (!r?.host_ok) return notFound(head); // 등록되지 않은 호스트는 운영 서비스로 처리하지 않음
    if (!r.destination_url) return notFound(head);
    if (r.status !== 'active') return unavailable(head);
    // 조회수: 실제 이동(GET 302)만 센다. 응답을 보낸 뒤 기록하므로 이동 속도·성공에 영향을 주지 않는다.
    if (!head) {
      const linkId = r.id!;
      after(async () => {
        try {
          await recordView(db, linkId);
        } catch {
          // 조회수 기록 실패는 이동에 영향을 주지 않는다
        }
      });
    }
    return new Response(null, { status: 302, headers: { ...COMMON, Location: r.destination_url } });
  } catch {
    // 임의 목적지로 보내지 않는다
    return page(503, '잠시 후 다시 시도해 주세요', '일시적으로 주소를 확인할 수 없습니다.', head);
  }
}

type Ctx = { params: Promise<{ code: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return resolve(req, (await params).code);
}

export async function HEAD(req: Request, { params }: Ctx) {
  return resolve(req, (await params).code);
}

const notAllowed = async () =>
  new Response(null, { status: 405, headers: { ...COMMON, Allow: 'GET, HEAD' } });
export const POST = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;
export const OPTIONS = notAllowed;
