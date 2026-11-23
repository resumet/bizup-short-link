// 운영 서비스 최초 초기화 (PRD §3.6, §15.9, §20.4)
// - 서비스 설정이 이미 있으면 INITIAL_PRIMARY_ORIGIN 으로 덮어쓰지 않는다.
// - 최초 owner 는 배포 시 확인한 Auth 사용자 UUID 로 지정한다.
// 사용: node --env-file=.env.local scripts/bootstrap.mjs
import postgres from 'postgres';

const need = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`${k} 가 필요합니다.`); process.exit(1); }
  return v;
};

const sql = postgres(need('DATABASE_URL'), { prepare: false, max: 1 });
const ns = need('SERVICE_NAMESPACE_ID');
const origin = new URL(need('INITIAL_PRIMARY_ORIGIN'));
if (origin.protocol !== 'https:' && origin.hostname !== 'localhost') {
  console.error('INITIAL_PRIMARY_ORIGIN 은 HTTPS 주소여야 합니다.');
  process.exit(1);
}
const host = origin.host.toLowerCase().replace(/\.$/, '');
const kind = host.endsWith('.vercel.app') ? 'vercel_production' : host.startsWith('localhost') ? 'development' : 'custom';

try {
  await sql.begin(async (t) => {
    const existing = await t`select service_namespace_id, workspace_id from bzup.service_settings`;
    let workspaceId;
    if (existing.length) {
      if (existing[0].service_namespace_id !== ns) throw new Error('DB의 서비스 namespace 와 SERVICE_NAMESPACE_ID 가 다릅니다. 중단합니다.');
      workspaceId = existing[0].workspace_id;
      console.log('서비스 설정이 이미 있습니다. 주소 설정은 변경하지 않습니다.');
    } else {
      const [ws] = await t`insert into bzup.workspaces (name) values (${process.env.WORKSPACE_NAME ?? '비즈업'}) returning id`;
      workspaceId = ws.id;
      const [d] = await t`insert into bzup.service_domains (service_namespace_id, hostname, status, kind, verified_at, activated_at)
                          values (${ns}, ${host}, 'active', ${kind}, now(), now()) returning id`;
      await t`insert into bzup.service_settings (service_namespace_id, workspace_id, primary_domain_id) values (${ns}, ${workspaceId}, ${d.id})`;
      await t`insert into bzup.generation_templates (workspace_id) values (${workspaceId}) on conflict do nothing`;
      await t`select bzup.ensure_default_template_item(id) from bzup.generation_templates where workspace_id = ${workspaceId}`;
      console.log(`서비스 초기화: 기본 호스트 ${host}`);
    }
    const ownerId = process.env.INITIAL_OWNER_USER_ID;
    if (ownerId) {
      const owners = await t`select 1 from bzup.workspace_members where workspace_id = ${workspaceId} and role = 'owner' and status = 'active'`;
      if (owners.length) {
        console.log('활성 owner 가 이미 있습니다. 최초 owner 지정을 건너뜁니다.');
      } else {
        await t`insert into bzup.workspace_members (workspace_id, user_id, display_name, email, role, status, joined_at)
                values (${workspaceId}, ${ownerId}, ${process.env.INITIAL_OWNER_NAME ?? '최고관리자'}, ${process.env.INITIAL_OWNER_EMAIL ?? ''}, 'owner', 'active', now())`;
        await t`insert into bzup.admin_audit_events (workspace_id, actor_type, object_type, object_id, action, after_data)
                values (${workspaceId}, 'system', 'workspace_member', ${ownerId}, 'initial_owner_assigned', ${t.json({ user_id: ownerId })})`;
        console.log(`최초 owner 지정: ${ownerId}`);
      }
    }
  });
} finally {
  await sql.end();
}
