// 로컬 개발용 PostgreSQL (embedded-postgres). 운영·Preview DB 와 분리된다.
// 사용: npm run dev:db  (포그라운드 유지, Ctrl+C 로 종료)
// - 데이터: .devdb/pgdata (persistent)
// - 마이그레이션: supabase/migrations/*.sql 중 미적용분 적용
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.DEV_DB_PORT ?? 54329);
const dataDir = path.resolve('.devdb/pgdata');
const fresh = !fs.existsSync(path.join(dataDir, 'PG_VERSION'));

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port: PORT,
  persistent: true,
  onLog: () => {},
});

if (fresh) {
  fs.mkdirSync(path.dirname(dataDir), { recursive: true });
  await pg.initialise();
}
await pg.start();

const admin = postgres({ host: '127.0.0.1', port: PORT, user: 'postgres', password: 'postgres', database: 'postgres', max: 1, onnotice: () => {} });
const exists = await admin`select 1 from pg_database where datname = 'bzup'`;
if (!exists.length) await admin.unsafe('create database bzup');
await admin.end();

const sql = postgres({ host: '127.0.0.1', port: PORT, user: 'postgres', password: 'postgres', database: 'bzup', max: 1, onnotice: () => {} });
await sql`create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
const migDir = path.resolve('supabase/migrations');
for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
  const done = await sql`select 1 from public.schema_migrations where name = ${f}`;
  if (done.length) continue;
  await sql.begin(async (t) => {
    await t.unsafe(fs.readFileSync(path.join(migDir, f), 'utf8'));
    await t`insert into public.schema_migrations (name) values (${f})`;
  });
  console.log(`migration applied: ${f}`);
}
await sql.end();

console.log(`dev db ready: postgres://postgres:postgres@127.0.0.1:${PORT}/bzup`);

const shutdown = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
setInterval(() => {}, 1 << 30);
