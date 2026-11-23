// DB 추상화. 서비스 로직은 이 인터페이스만 사용한다.
// 운영: postgres.js (서버 전용 연결), 테스트: PGlite.

export type Row = Record<string, unknown>;

export interface Queryable {
  /** $1, $2 … 위치 파라미터 SQL */
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface TxOptions {
  isolation?: 'read committed' | 'repeatable read' | 'serializable';
  readOnly?: boolean;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>, opts?: TxOptions): Promise<T>;
}

export function txHeader(opts: TxOptions = {}): string {
  const iso = (opts.isolation ?? 'read committed').toUpperCase();
  return `ISOLATION LEVEL ${iso}${opts.readOnly ? ' READ ONLY' : ' READ WRITE'}`;
}

/** SQL 오류 코드 판별 (postgres.js·PGlite 모두 `code` 필드를 제공) */
export function pgErrorCode(e: unknown): string | undefined {
  if (e && typeof e === 'object' && 'code' in e) return String((e as { code: unknown }).code);
  return undefined;
}

export function pgConstraint(e: unknown): string | undefined {
  if (e && typeof e === 'object') {
    const o = e as { constraint?: string; constraint_name?: string };
    return o.constraint_name ?? o.constraint;
  }
  return undefined;
}

export const UNIQUE_VIOLATION = '23505';
