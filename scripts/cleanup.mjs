// 만료 기록 정리 수동 실행 (로컬·운영 점검용)
// 사용: npm run db:cleanup
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });
try {
  const total = { idempotency_deleted: 0, reviews_deleted: 0, rate_windows_deleted: 0 };
  for (;;) {
    const [r] = await sql`select * from bzup.cleanup_expired(5000)`;
    for (const k of Object.keys(total)) total[k] += Number(r[k]);
    if (Object.keys(total).every((k) => Number(r[k]) < 5000)) break;
  }
  console.log(total);
} finally {
  await sql.end();
}
