// supabase/migrations/*.sql 중 미적용분을 순서대로 적용한다.
// 사용: npm run db:migrate   (DATABASE_URL 필요, MIGRATION_DATABASE_URL 이 있으면 우선 사용)
import postgres from 'postgres';
import fs from 'node:fs';
import path from 'node:path';

export async function migrate(url) {
  const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
  try {
    await sql`create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
    // Supabase Data API(anon)로 노출되지 않도록 RLS 활성화 (정책 없음 = API 접근 불가)
    await sql`alter table public.schema_migrations enable row level security`;
    const dir = path.resolve('supabase/migrations');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      const done = await sql`select 1 from public.schema_migrations where name = ${f}`;
      if (done.length) continue;
      await sql.begin(async (t) => {
        await t.unsafe(fs.readFileSync(path.join(dir, f), 'utf8'));
        await t`insert into public.schema_migrations (name) values (${f})`;
      });
      console.log(`migration applied: ${f}`);
    }
  } finally {
    await sql.end();
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('migrate.mjs')) {
  // Supabase 는 DDL 적용에 transaction pooler(6543) 대신 session pooler(5432)·직접 연결을 권장한다
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL 이 필요합니다.');
    process.exit(1);
  }
  await migrate(url);
}
