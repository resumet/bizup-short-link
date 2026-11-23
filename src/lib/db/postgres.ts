import 'server-only';
import postgres from 'postgres';
import type { Db, Queryable, Row, TxOptions } from './types';
import { txHeader } from './types';

// 서버리스 연결 풀(Supabase transaction pooler)을 고려해 prepared statement를 끈다 (§18.1, S13).
// 이 연결은 서버 전용이며 브라우저로 전달되지 않는다.

let instance: Db | null = null;

function wrap(sql: postgres.Sql | postgres.TransactionSql): Queryable {
  return {
    async query<T = Row>(text: string, params: unknown[] = []) {
      const rows = await sql.unsafe(text, params as postgres.ParameterOrJSON<never>[]);
      return rows as unknown as T[];
    },
  };
}

export function getDb(): Db {
  if (instance) return instance;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not configured');
  const sql = postgres(url, {
    prepare: false,
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    idle_timeout: 20,
    connect_timeout: 10,
    // 세션 상태가 다음 요청으로 새지 않도록 트랜잭션 단위로만 컨텍스트를 사용한다 (§18.4)
    connection: { application_name: 'bzup-link' },
    types: {
      // bigint 를 number 로
      bigint: postgres.BigInt,
    },
  });
  const base = wrap(sql);
  instance = {
    query: base.query,
    async tx<T>(fn: (q: Queryable) => Promise<T>, opts?: TxOptions) {
      return (await sql.begin(txHeader(opts), (t) => fn(wrap(t)))) as T;
    },
  };
  return instance;
}
