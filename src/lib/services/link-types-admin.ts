// 짧은 주소 유형 관리 (최고관리자 전용)
// - key 는 생성 후 변경 불가, label·활성 여부 수정
// - 전환 주소 구성(slots)은 그 유형으로 링크를 만들기 전까지만 바꿀 수 있다
// - 제거는 링크가 한 번도 쓰지 않은 유형만 (삭제된 링크 포함). 쓰인 유형은 비활성화
import { AppError, validationError } from '@/lib/errors';
import { toIso } from '@/lib/time';
import type { Db, Queryable } from '@/lib/db/types';
import type { UserPrincipal } from '@/lib/auth/principal';
import { assertAllowedFields, cleanText, isObject } from '@/lib/validation';
import { audit, runAdminWrite } from './admin-write';
import { TYPE_KEY_RE } from './short-links';
import { parseSlotDefs, type SlotDef } from './slot-defs';

interface TypeRow {
  key: string; label: string; active: boolean; slots: SlotDef[] | null; created_at: Date; updated_at: Date; link_count: number; live_link_count: number;
}

function serialize(t: TypeRow) {
  return {
    key: t.key, label: t.label, active: t.active, slots: t.slots ?? null,
    link_count: Number(t.live_link_count), used: Number(t.link_count) > 0,
    created_at: toIso(t.created_at), updated_at: toIso(t.updated_at),
  };
}

const SELECT = `
  select t.key, t.label, t.active, t.slots, t.created_at, t.updated_at,
         (select count(*)::int from bzup.links l where l.type_key = t.key) as link_count,
         (select count(*)::int from bzup.links l where l.type_key = t.key and l.deleted_at is null) as live_link_count
    from bzup.short_link_types t`;

export async function listLinkTypesForAdmin(q: Queryable) {
  const rows = await q.query<TypeRow>(`${SELECT} order by t.key collate "C"`);
  return rows.map(serialize);
}

function parseKey(v: unknown): string {
  if (typeof v !== 'string' || !TYPE_KEY_RE.test(v)) {
    throw validationError('key 는 소문자 영문으로 시작하고 소문자 영문·숫자·밑줄만 쓸 수 있습니다 (1~64자).', [{ field: 'key', message: '형식 오류' }]);
  }
  return v;
}

export async function createLinkType(db: Db, p: UserPrincipal, body: unknown, idemKey: string, requestId: string) {
  if (!isObject(body)) throw new AppError('INVALID_JSON');
  assertAllowedFields(body, ['key', 'label', 'active', 'slots']);
  const key = parseKey(body.key);
  const label = cleanText(body.label, 'label', '표시 이름', 1, 120);
  const slots = parseSlotDefs(body.slots);
  if (body.active !== undefined && typeof body.active !== 'boolean') throw validationError('active 는 true/false 입니다.');
  const active = body.active ?? true;
  return runAdminWrite(db, p, { method: 'POST', route: '/admin/short-link-types', idempotencyKey: idemKey, hashInput: body, resultObjectType: 'short_link_type' },
    async (q, owner) => {
      const r = await q.query<{ key: string }>(
        `insert into bzup.short_link_types (key, label, active, slots) values ($1,$2,$3,$4::text::jsonb) on conflict (key) do nothing returning key`,
        [key, label, active, slots ? JSON.stringify(slots) : null],
      );
      if (!r[0]) throw new AppError('CONFLICT', `이미 있는 key 입니다: ${key}. 다른 용도라면 새 key 를 사용해 주세요.`);
      await audit(q, owner, { objectType: 'short_link_type', objectId: null, action: 'short_link_type_created', after: { key, label, active, slots }, requestId });
      const [row] = await q.query<TypeRow>(`${SELECT} where t.key = $1`, [key]);
      return { status: 201, body: { data: serialize(row) }, headers: {} };
    });
}

export async function updateLinkType(db: Db, p: UserPrincipal, key: string, body: unknown, idemKey: string, requestId: string) {
  parseKey(key);
  if (!isObject(body)) throw new AppError('INVALID_JSON');
  assertAllowedFields(body, ['label', 'active', 'slots']);
  const label = body.label === undefined ? undefined : cleanText(body.label, 'label', '표시 이름', 1, 120);
  if (body.active !== undefined && typeof body.active !== 'boolean') throw validationError('active 는 true/false 입니다.');
  const slotsGiven = 'slots' in body;
  const slots = slotsGiven ? parseSlotDefs(body.slots) : undefined;
  if (label === undefined && body.active === undefined && !slotsGiven) throw validationError('변경할 항목이 없습니다.');
  return runAdminWrite(db, p, { method: 'PATCH', route: `/admin/short-link-types/${key}`, idempotencyKey: idemKey, hashInput: body, resultObjectType: 'short_link_type' },
    async (q, owner) => {
      const [cur] = await q.query<TypeRow>(`${SELECT} where t.key = $1`, [key]);
      if (!cur) throw new AppError('NOT_FOUND');
      const next = {
        label: label ?? cur.label,
        active: body.active === undefined ? cur.active : (body.active as boolean),
        slots: slots === undefined ? cur.slots ?? null : slots,
      };
      const slotsChanged = JSON.stringify(next.slots) !== JSON.stringify(cur.slots ?? null);
      if (slotsChanged && Number(cur.link_count) > 0) {
        throw new AppError('CONFLICT', '이 유형으로 만든 링크가 있어 전환 주소 구성을 바꿀 수 없습니다. 새 유형을 만들어 주세요.');
      }
      if (next.label !== cur.label || next.active !== cur.active || slotsChanged) {
        await q.query(`update bzup.short_link_types set label = $2, active = $3, slots = $4::text::jsonb where key = $1`,
          [key, next.label, next.active, next.slots ? JSON.stringify(next.slots) : null]);
        await audit(q, owner, {
          objectType: 'short_link_type', objectId: null, action: 'short_link_type_updated',
          before: { key, label: cur.label, active: cur.active, slots: cur.slots ?? null }, after: { key, ...next }, requestId,
        });
      }
      const [row] = await q.query<TypeRow>(`${SELECT} where t.key = $1`, [key]);
      return { status: 200, body: { data: serialize(row) }, headers: {} };
    });
}

export async function deleteLinkType(db: Db, p: UserPrincipal, key: string, idemKey: string, requestId: string) {
  parseKey(key);
  return runAdminWrite(db, p, { method: 'DELETE', route: `/admin/short-link-types/${key}`, idempotencyKey: idemKey, hashInput: { key }, resultObjectType: 'short_link_type' },
    async (q, owner) => {
      const [cur] = await q.query<TypeRow>(`${SELECT} where t.key = $1`, [key]);
      if (!cur) throw new AppError('NOT_FOUND');
      if (Number(cur.link_count) > 0) {
        throw new AppError('CONFLICT', '이 유형으로 발급된 링크가 있어 제거할 수 없습니다. 대신 비활성화해 주세요.');
      }
      await q.query(`delete from bzup.short_link_types where key = $1`, [key]);
      await audit(q, owner, { objectType: 'short_link_type', objectId: null, action: 'short_link_type_deleted', before: { key, label: cur.label, active: cur.active }, requestId });
      return { status: 200, body: { data: { key, deleted: true } }, headers: {} };
    });
}
