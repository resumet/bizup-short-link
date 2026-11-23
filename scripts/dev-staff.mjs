// 로컬 개발용 직원 계정 (owner / editor / viewer / 접근 중지).
// Supabase Auth 없이 DEV_AUTH 로그인으로 사용한다. BZUP_KEY_ENV=test 개발 DB 에서만 실행.
// 사용: npm run dev:staff
import postgres from 'postgres';
import { createHash } from 'node:crypto';

if (process.env.BZUP_KEY_ENV !== 'test' || process.env.DEV_AUTH !== 'true') {
  console.error('dev:staff 는 BZUP_KEY_ENV=test, DEV_AUTH=true 인 로컬 개발 환경에서만 실행합니다.');
  process.exit(1);
}
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });

// 이메일로부터 고정 UUID 를 만든다 (재실행해도 같은 사용자)
const uuidFor = (email) => {
  const h = createHash('sha256').update(`bzup-dev:${email}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const staff = [
  { email: 'owner@dev.bzup.test', name: '최고관리자(개발)', role: 'owner', status: 'active' },
  { email: 'editor@dev.bzup.test', name: '김직원(개발)', role: 'editor', status: 'active' },
  { email: 'viewer@dev.bzup.test', name: '조회자(개발)', role: 'viewer', status: 'active' },
  { email: 'suspended@dev.bzup.test', name: '중지직원(개발)', role: 'editor', status: 'suspended' },
];

try {
  const [s] = await sql`select workspace_id from bzup.service_settings`;
  if (!s) throw new Error('먼저 npm run bootstrap 을 실행하세요.');
  for (const m of staff) {
    const r = await sql`
      insert into bzup.workspace_members (workspace_id, user_id, display_name, email, role, status, invited_at, joined_at, suspended_at)
      values (${s.workspace_id}, ${uuidFor(m.email)}, ${m.name}, ${m.email}, ${m.role}, ${m.status}, now(), now(),
              ${m.status === 'suspended' ? sql`now()` : null})
      on conflict (workspace_id, user_id) do nothing
      returning id`;
    console.log(`${r.length ? '생성' : '이미 있음'}: ${m.email} (${m.role}, ${m.status})`);
  }
  console.log(`비밀번호: .env.local 의 DEV_LOGIN_PASSWORD`);
} finally {
  await sql.end();
}
