// 브라우저 → /internal 호출 헬퍼. 같은 출처 상대 경로만 사용한다 (§20.4).
// 쿠키 기반 변경 요청에는 이중 제출 CSRF 토큰을 붙인다 (§18.3).

export interface RowError { row?: number; template_item_id?: string; field?: string; message: string }

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly rowErrors?: RowError[],
    readonly requestId?: string,
  ) {
    super(message);
  }
}

function csrfToken(): string {
  const m = /(?:^|;\s*)bzup_csrf=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1]) : '';
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export interface ApiResult<T> { status: number; body: T; etag: string | null }

export async function apiFetch<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; ifMatch?: string | null; idempotencyKey?: string; timeoutMs?: number } = {},
): Promise<ApiResult<T>> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') {
    headers['X-CSRF-Token'] = csrfToken();
    headers['Content-Type'] = 'application/json';
  }
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 45000);
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: ctrl.signal,
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', '응답을 받지 못했습니다. 같은 내용으로 다시 시도해 주세요.');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    throw new ApiError(401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = body?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'UNKNOWN', e.message ?? '요청을 처리하지 못했습니다.', e.details, e.row_errors, e.request_id);
  }
  return { status: res.status, body: body as T, etag: res.headers.get('etag') };
}

export function formatKst(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** 파일 업로드(multipart). CSRF 토큰을 붙이고 오류는 apiFetch 와 같은 ApiError 로 던진다 */
export async function apiUpload<T = unknown>(path: string, form: FormData, timeoutMs = 120000): Promise<ApiResult<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      body: form,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: ctrl.signal,
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', '응답을 받지 못했습니다. 잠시 후 같은 파일로 다시 올려 주세요. 이미 만든 주소는 다시 만들지 않습니다.');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    throw new ApiError(401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
  }
  const text = await res.text();
  let body: { error?: { code?: string; message?: string; details?: Record<string, unknown>; row_errors?: RowError[]; request_id?: string } } | null = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) {
    const e = body?.error ?? {};
    const msg = e.message ?? (res.status === 413 ? '파일이 너무 큽니다.' : '요청을 처리하지 못했습니다.');
    throw new ApiError(res.status, e.code ?? 'UNKNOWN', msg, e.details, e.row_errors, e.request_id);
  }
  return { status: res.status, body: body as T, etag: res.headers.get('etag') };
}
