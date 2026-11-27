// 로컬 개발 데이터: 진행중 강의, 자동생성 이름 목록, 테스트 API 연동·키(bzup_test_)
// 사용: npm run dev:seed   — 키 원문은 이 출력에서 한 번만 표시된다.
// 운영 DB 에서 실행하지 않는다 (BZUP_KEY_ENV=test 일 때만 동작).
import postgres from 'postgres';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

if (process.env.BZUP_KEY_ENV !== 'test') {
  console.error('dev:seed 는 BZUP_KEY_ENV=test 인 개발 환경에서만 실행합니다.');
  process.exit(1);
}
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });

try {
  const [s] = await sql`select workspace_id from bzup.service_settings`;
  if (!s) throw new Error('먼저 npm run bootstrap 을 실행하세요.');
  const ws = s.workspace_id;
  const [owner] = await sql`select user_id from bzup.workspace_members where workspace_id = ${ws} and role = 'owner' limit 1`;
  const actor = owner?.user_id ?? randomUUID();

  let [course] = await sql`select id from bzup.courses where workspace_id = ${ws} and name = '김선아 강의'`;
  if (!course) {
    [course] = await sql`insert into bzup.courses (workspace_id, name, instructor_name, status, created_by)
                         values (${ws}, '김선아 강의', '김선아', 'active', ${actor}) returning id`;
    await sql`insert into bzup.courses (workspace_id, name, instructor_name, status, created_by)
              values (${ws}, '신민철 강의', '신민철', 'active', ${actor})`;
  }

  // 시스템 API 연동(회사당 1개)을 재사용하거나 만든다
  let [client] = await sql`select id from bzup.api_clients where workspace_id = ${ws} and is_system and status <> 'deleted'`;
  if (!client) {
    [client] = await sql`insert into bzup.api_clients (workspace_id, name, status, is_system, default_course_id, created_by)
                         values (${ws}, '시스템 API', 'active', true, ${course.id}, ${actor}) returning id`;
  }
  const publicId = randomBytes(16).toString('base64url');
  const keyPrefix = `bzup_test_${publicId}`;
  const plaintext = `${keyPrefix}_${randomBytes(32).toString('base64url')}`;
  await sql`insert into bzup.api_keys (workspace_id, api_client_id, name, public_id, environment, key_prefix, secret_hash,
              scopes, status, expires_at, created_by)
            values (${ws}, ${client.id}, '로컬 개발 키', ${publicId}, 'test', ${keyPrefix},
                    ${createHash('sha256').update(plaintext).digest()},
                    ${['links:create', 'links:read', 'links:update', 'courses:read']}, 'active',
                    now() + interval '90 days', ${actor})`;
  console.log(`course_id(김선아 강의): ${course.id}`);
  console.log(`API key (한 번만 표시): ${plaintext}`);
} finally {
  await sql.end();
}
