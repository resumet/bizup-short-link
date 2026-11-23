// 자동생성 이름 목록 (PRD §7, §15.6)
// - 회사당 1개, 활성 항목 0~100, 동일 이름 허용(항목 ID로 구분)
// - 제거는 비활성화, 활성 항목·이름·순서의 실제 변경마다 version +1
// - 전체 저장은 ETag/If-Match + Idempotency-Key
import { AppError, validationError, type RowError } from '@/lib/errors';
import { toIso } from '@/lib/time';
import type { Db, Queryable } from '@/lib/db/types';
import type { UserPrincipal } from '@/lib/auth/principal';
import { assertAllowedFields, cleanText, isObject, UUID_RE } from '@/lib/validation';
import { audit, runAdminWrite } from './admin-write';

export const MAX_ACTIVE_ITEMS = 100;
const MAX_TOTAL_ITEMS = 500;

export const templateEtag = (id: string, version: number) => `"template-${id}-v${version}"`;

interface ItemRow { id: string; name: string; sort_order: number; is_active: boolean; destination_slots: string[] | null }

export const MAX_SLOTS = 5;
const sameSlots = (a: string[] | null, b: string[] | null) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export async function ensureTemplate(q: Queryable, workspaceId: string) {
  const created = await q.query<{ id: string }>(
    `insert into bzup.generation_templates (workspace_id) values ($1) on conflict (workspace_id) do nothing returning id`,
    [workspaceId],
  );
  // 새로 만든 목록에는 기본 항목(단톡방-라이브유튜브-앵콜줌)을 넣는다
  if (created[0]) await q.query(`select bzup.ensure_default_template_item($1)`, [created[0].id]);
  const [t] = await q.query<{ id: string; display_name: string; version: number; updated_at: Date; updated_by: string | null }>(
    `select id, display_name, version, updated_at, updated_by from bzup.generation_templates where workspace_id = $1`,
    [workspaceId],
  );
  return t;
}

async function loadItems(q: Queryable, templateId: string): Promise<ItemRow[]> {
  return q.query<ItemRow>(
    `select id, name, sort_order, is_active, destination_slots from bzup.generation_template_items
      where template_id = $1 order by is_active desc, sort_order, id`,
    [templateId],
  );
}

export async function getTemplateForAdmin(db: Db, p: UserPrincipal) {
  const t = await db.tx(async (q) => ensureTemplate(q, p.workspaceId));
  const items = await loadItems(db, t.id);
  const revisions = await db.query<{ version: number; created_at: Date; actor_name: string | null }>(
    `select r.version, r.created_at, m.display_name as actor_name
       from bzup.generation_template_revisions r
       left join bzup.workspace_members m on m.workspace_id = r.workspace_id and m.user_id = r.actor_user_id
      where r.template_id = $1 order by r.version desc limit 20`,
    [t.id],
  );
  return {
    etag: templateEtag(t.id, Number(t.version)),
    data: {
      id: t.id,
      display_name: t.display_name,
      version: Number(t.version),
      updated_at: toIso(t.updated_at),
      items: items.map((i) => ({ id: i.id, name: i.name, sort_order: i.sort_order, is_active: i.is_active, destination_slots: i.destination_slots })),
      revisions: revisions.map((r) => ({ version: Number(r.version), created_at: toIso(r.created_at), actor_name: r.actor_name })),
    },
  };
}

interface SaveItem { id: string | null; name: string; is_active: boolean; destination_slots: string[] | null }

function parseSlots(raw: unknown, row: number, errors: RowError[]): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_SLOTS) {
    errors.push({ row, field: 'destination_slots', message: `전환 주소는 2~${MAX_SLOTS}개로 지정해 주세요.` });
    return null;
  }
  const labels: string[] = [];
  for (const l of raw) {
    try {
      labels.push(cleanText(l, 'destination_slots', '전환 주소 이름', 1, 40));
    } catch (e) {
      errors.push({ row, field: 'destination_slots', message: (e as Error).message });
      return null;
    }
  }
  if (new Set(labels).size !== labels.length) {
    errors.push({ row, field: 'destination_slots', message: '전환 주소 이름이 겹칩니다.' });
    return null;
  }
  return labels;
}

function parseSaveBody(body: unknown): SaveItem[] {
  if (!isObject(body)) throw new AppError('INVALID_JSON');
  assertAllowedFields(body, ['items']);
  if (!Array.isArray(body.items)) throw validationError('items 배열이 필요합니다.');
  if (body.items.length > MAX_TOTAL_ITEMS) throw validationError(`항목은 최대 ${MAX_TOTAL_ITEMS}개까지 보관할 수 있습니다.`);
  const errors: RowError[] = [];
  const seen = new Set<string>();
  const items: SaveItem[] = body.items.map((raw, idx) => {
    if (!isObject(raw)) throw validationError(`${idx + 1}번째 항목 형식이 올바르지 않습니다.`);
    assertAllowedFields(raw, ['id', 'name', 'is_active', 'destination_slots']);
    let id: string | null = null;
    if (raw.id !== undefined && raw.id !== null) {
      if (typeof raw.id !== 'string' || !UUID_RE.test(raw.id)) throw validationError(`${idx + 1}번째 항목 ID가 올바르지 않습니다.`);
      id = raw.id.toLowerCase();
      if (seen.has(id)) throw validationError('같은 항목 ID가 두 번 포함되어 있습니다.');
      seen.add(id);
    }
    if (raw.is_active !== undefined && typeof raw.is_active !== 'boolean') throw validationError('is_active는 true/false입니다.');
    let name = '';
    try {
      name = cleanText(raw.name, 'name', '명칭', 1, 120);
    } catch (e) {
      errors.push({ row: idx + 1, field: 'name', message: (e as Error).message });
    }
    const destination_slots = parseSlots(raw.destination_slots, idx + 1, errors);
    return { id, name, is_active: raw.is_active !== false, destination_slots };
  });
  if (errors.length) throw validationError('이름 목록을 확인해 주세요.', errors);
  const active = items.filter((i) => i.is_active).length;
  if (active > MAX_ACTIVE_ITEMS) {
    throw validationError(`활성 항목은 최대 ${MAX_ACTIVE_ITEMS}개입니다. 현재 ${active}개입니다.`);
  }
  return items;
}

// 활성 항목·이름·순서·전환 주소 구성이 실행 팝업의 입력을 결정한다 → 바뀌면 버전 +1
const snapshot = (items: { id: string; name: string; sort_order: number; is_active: boolean; destination_slots: string[] | null }[]) =>
  items
    .filter((i) => i.is_active)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((i) => ({ id: i.id, name: i.name, sort_order: i.sort_order, destination_slots: i.destination_slots ?? null }));

export async function saveTemplate(db: Db, p: UserPrincipal, body: unknown, ifMatch: string, key: string, requestId: string) {
  const input = parseSaveBody(body);
  return runAdminWrite(db, p, {
    method: 'PUT', route: '/admin/generation-template', idempotencyKey: key, hashInput: { body, if_match: ifMatch },
    resultObjectType: 'generation_template',
  }, async (q, owner) => {
    const t = await ensureTemplate(q, owner.workspaceId);
    await q.query(`select 1 from bzup.generation_templates where id = $1 for update`, [t.id]);
    const etag = templateEtag(t.id, Number(t.version));
    if (ifMatch !== etag) throw new AppError('PRECONDITION_FAILED', '다른 관리자가 이름 목록을 먼저 변경했습니다. 최신 목록을 확인해 주세요.', { headers: { ETag: etag } });

    const current = await loadItems(q, t.id);
    const byId = new Map(current.map((i) => [i.id, i]));
    const unknown = input.filter((i) => i.id && !byId.has(i.id));
    if (unknown.length) throw validationError('이 목록에 없는 항목 ID가 포함되어 있습니다.');
    // 기존 항목은 삭제하지 않고 비활성화로만 제거한다. 요청에서 빠진 항목은 비활성으로 둔다.
    const listed = new Set(input.filter((i) => i.id).map((i) => i.id!));

    // 새 상태 계산: 요청 순서대로 활성 항목 sort_order 1..N, 비활성 항목은 그 뒤
    const next: { id: string | null; name: string; is_active: boolean; sort_order: number; destination_slots: string[] | null }[] = [];
    let order = 1;
    for (const i of input) next.push({ ...i, sort_order: order++ });
    for (const c of current) if (!listed.has(c.id)) next.push({ id: c.id, name: c.name, is_active: false, sort_order: order++, destination_slots: c.destination_slots });

    const before = snapshot(current);
    let afterTmp = 0;
    const afterPreview = snapshot(next.map((n) => ({ ...n, id: n.id ?? `new-${afterTmp++}` })));
    const activeChanged = JSON.stringify(before) !== JSON.stringify(afterPreview);
    // 비활성 항목의 이름·순서 변경 등 표시 정보 변경도 저장은 하되, 버전은 활성 구성 변경 시에만 올린다
    const anyChange = activeChanged || next.some((n) => {
      if (!n.id) return true;
      const c = byId.get(n.id)!;
      return c.name !== n.name || c.is_active !== n.is_active || !sameSlots(c.destination_slots, n.destination_slots);
    });

    if (anyChange) {
      for (const n of next) {
        if (n.id) {
          await q.query(
            `update bzup.generation_template_items
                set name=$2, sort_order=$3, is_active=$4, destination_slots=$5::text::jsonb, updated_at=clock_timestamp()
              where id=$1 and (name<>$2 or sort_order<>$3 or is_active<>$4
                               or destination_slots is distinct from $5::text::jsonb)`,
            [n.id, n.name, n.sort_order, n.is_active, n.destination_slots ? JSON.stringify(n.destination_slots) : null],
          );
        } else {
          const [row] = await q.query<{ id: string }>(
            `insert into bzup.generation_template_items (workspace_id, template_id, name, sort_order, is_active, destination_slots)
             values ($1,$2,$3,$4,$5,$6::text::jsonb) returning id`,
            [owner.workspaceId, t.id, n.name, n.sort_order, n.is_active, n.destination_slots ? JSON.stringify(n.destination_slots) : null],
          );
          n.id = row.id;
        }
      }
    }
    let version = Number(t.version);
    if (activeChanged) {
      version += 1;
      await q.query(
        `update bzup.generation_templates set version=$2, updated_by=$3, updated_at=clock_timestamp() where id=$1`,
        [t.id, version, owner.userId],
      );
      const after = snapshot(next as ItemRow[]);
      await q.query(
        `insert into bzup.generation_template_revisions (workspace_id, template_id, version, ordered_items_snapshot, actor_user_id, request_id)
         values ($1,$2,$3,$4::text::jsonb,$5,$6)`,
        [owner.workspaceId, t.id, version, JSON.stringify(after), owner.userId, requestId],
      );
      await audit(q, owner, {
        objectType: 'generation_template', objectId: t.id, action: 'template_saved',
        before: { version: Number(t.version), items: before }, after: { version, items: after }, requestId,
      });
    }
    const items = await loadItems(q, t.id);
    return {
      status: 200,
      body: {
        data: { id: t.id, display_name: t.display_name, version, items },
        version_changed: activeChanged,
      },
      headers: { ETag: templateEtag(t.id, version) },
      objectId: t.id,
    };
  });
}
