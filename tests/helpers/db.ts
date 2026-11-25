import fs from 'node:fs';
import path from 'node:path';
import { createPgliteDb } from '@/lib/db/pglite';
import { MemoryLedger, setLedger } from '@/lib/services/ledger';
import { generateApiKey } from '@/lib/crypto';
import type { ApiPrincipal, ApiScope, Role, UserPrincipal } from '@/lib/auth/principal';

const MIG_DIR = path.resolve(__dirname, '../../supabase/migrations');

export const NS = '11111111-1111-4111-8111-111111111111';
export const HOST = 'bzup-link-demo.vercel.app';

export async function setupDb() {
  const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  const db = await createPgliteDb(files.map((f) => fs.readFileSync(path.join(MIG_DIR, f), 'utf8')));
  const ledger = new MemoryLedger();
  setLedger(ledger);

  const [ws] = await db.query<{ id: string }>(`insert into bzup.workspaces (name) values ('비즈업') returning id`);
  const [dom] = await db.query<{ id: string }>(
    `insert into bzup.service_domains (service_namespace_id, hostname, status, kind, activated_at)
     values ($1, $2, 'active', 'vercel_production', now()) returning id`,
    [NS, HOST],
  );
  await db.query(
    `insert into bzup.service_settings (service_namespace_id, workspace_id, primary_domain_id) values ($1,$2,$3)`,
    [NS, ws.id, dom.id],
  );
  const workspaceId = ws.id;

  async function addUser(role: Role, name = `${role}-user`): Promise<UserPrincipal> {
    const userId = crypto.randomUUID();
    const [m] = await db.query<{ id: string }>(
      `insert into bzup.workspace_members (workspace_id, user_id, display_name, email, role, status, joined_at)
       values ($1,$2,$3,$4,$5,'active', now()) returning id`,
      [workspaceId, userId, name, `${name}@example.com`, role],
    );
    return { kind: 'user', workspaceId, userId, memberId: m.id, role, displayName: name };
  }

  async function addCourse(name: string, status: 'active' | 'closed' = 'active') {
    const [c] = await db.query<{ id: string }>(
      `insert into bzup.courses (workspace_id, name, status) values ($1,$2,$3) returning id`,
      [workspaceId, name, status],
    );
    return c.id;
  }

  async function addApiKey(owner: UserPrincipal, scopes: ApiScope[]) {
    const [client] = await db.query<{ id: string }>(
      `insert into bzup.api_clients (workspace_id, name, status, created_by)
       values ($1,'수강 신청 자동화','active',$2) returning id`,
      [workspaceId, owner.userId],
    );
    const k = generateApiKey('live');
    const [key] = await db.query<{ id: string }>(
      `insert into bzup.api_keys (workspace_id, api_client_id, name, public_id, environment, key_prefix, secret_hash,
         scopes, status, expires_at, created_by)
       values ($1,$2,'key',$3,'live',$4,$5,$6,'active', now() + interval '90 days', $7) returning id`,
      [workspaceId, client.id, k.publicId, k.keyPrefix, k.secretHash, scopes, owner.userId],
    );
    const principal: ApiPrincipal = {
      kind: 'api_client', workspaceId, apiClientId: client.id, apiKeyId: key.id, scopes,
      clientName: '수강 신청 자동화',
    };
    return { principal, plaintext: k.plaintext, clientId: client.id, keyId: key.id };
  }

  async function addTemplate(names: string[]) {
    const [t] = await db.query<{ id: string }>(
      `insert into bzup.generation_templates (workspace_id) values ($1) returning id`, [workspaceId],
    );
    const items: { id: string; name: string }[] = [];
    for (const [i, name] of names.entries()) {
      const [it] = await db.query<{ id: string }>(
        `insert into bzup.generation_template_items (workspace_id, template_id, name, sort_order) values ($1,$2,$3,$4) returning id`,
        [workspaceId, t.id, name, i + 1],
      );
      items.push({ id: it.id, name });
    }
    return { id: t.id, version: 1, items };
  }

  return { db, ledger, workspaceId, addUser, addCourse, addApiKey, addTemplate };
}
