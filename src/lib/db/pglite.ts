// 테스트·로컬 검증용 PGlite 어댑터. 운영 코드에서 import 하지 않는다.
import { PGlite } from '@electric-sql/pglite';
import type { Db, Queryable, Row, TxOptions } from './types';
import { txHeader } from './types';

export async function createPgliteDb(migrationSql: string[]): Promise<Db & { raw: PGlite }> {
  const raw = new PGlite();
  for (const s of migrationSql) await raw.exec(s);
  // PGlite 는 단일 연결이므로 트랜잭션을 직렬화한다.
  let chain: Promise<unknown> = Promise.resolve();
  const direct: Queryable = {
    async query<T = Row>(text: string, params: unknown[] = []) {
      const r = await raw.query<T>(text, params);
      return r.rows;
    },
  };
  return {
    raw,
    query: direct.query,
    tx<T>(fn: (q: Queryable) => Promise<T>, opts?: TxOptions): Promise<T> {
      const run = async () =>
        raw.transaction(async (t) => {
          await t.query(`SET TRANSACTION ${txHeader(opts)}`);
          const q: Queryable = {
            async query<R = Row>(text: string, params: unknown[] = []) {
              const r = await t.query<R>(text, params);
              return r.rows;
            },
          };
          return fn(q);
        });
      const p = chain.then(run, run);
      chain = p.catch(() => undefined);
      return p as Promise<T>;
    },
  };
}
